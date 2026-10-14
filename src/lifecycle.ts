import { getServiceContainer } from '@getflywheel/local/main';
import {
	DockerError,
	DockerNotFoundError,
	describeError,
	findFreePort,
	getDockerStatus,
	hostUriFor,
	inspectContainer,
	isPortConflict,
	listAllContainers,
	listRunningContainers,
	loopbackUriFor,
	removeContainer,
	removeContainerByName,
	removeVolume,
	startContainer,
	stopContainer,
	stopContainerByName,
	versionOfImage,
	volumeExists,
	waitForElasticsearchReady,
} from './docker';
import { withSiteLock } from './lock';
import {
	SUPPORTED_VERSIONS,
	getDataMajor,
	getPort,
	getPortsOfOtherSites,
	getSite,
	getSiteIds,
	getVersion,
	isEnabled,
	isSupportedVersion,
	majorOf,
	setDataMajor,
	setEnabled,
	setPort,
	setVersion,
	type EsVersion,
} from './storage';
import type { Result } from './types';
import { getEpHost, removeEpHost, setEpHost } from './wpconfig';

const MAJOR_CHANGE_PENDING_ERROR =
	'Major version change pending. Confirm it in the Elasticsearch panel to recreate the data volume.';

const lastErrors = new Map<string, string>();

/** Sites seen running through the siteStarted/siteStopped hooks. */
const startedSites = new Set<string>();

/**
 * Per-site counter bumped on every start, stop, container removal, disable
 * and version change. A readiness watcher runs only while the counter still
 * holds the value of the start that launched it.
 */
const generations = new Map<string, number>();

/** Set once the orphan sweep and version reconcile have both succeeded. */
let startupDone = false;
/** Time of the last failed startup run, so a failing run is retried at most once per STARTUP_RETRY_MS. */
let lastStartupFailure = 0;
const STARTUP_RETRY_MS = 60_000;
let startupInFlight: Promise<void> | null = null;

function bumpGeneration(siteId: string): number {
	const next = (generations.get(siteId) ?? 0) + 1;
	generations.set(siteId, next);
	return next;
}

function isCurrentGeneration(siteId: string, generation: number): boolean {
	const current = generations.get(siteId) ?? 0;
	return current === generation;
}

function describe(err: unknown): string {
	return err instanceof Error ? describeError(err) : String(err);
}

export function getLastError(siteId: string): string | null {
	return lastErrors.get(siteId) ?? null;
}

function setLastError(siteId: string, error: string): void {
	lastErrors.set(siteId, error);
}

function clearLastError(siteId: string): void {
	lastErrors.delete(siteId);
}

function markSiteRunning(siteId: string, running: boolean): void {
	if (running) startedSites.add(siteId);
	else startedSites.delete(siteId);
}

/**
 * Whether Local has the site's processes up. Local creates the process group
 * before firing siteStarted and removes it before firing siteStopped.
 */
export function isSiteRunning(siteId: string): boolean {
	const site = getSite(siteId);
	if (!site) return false;
	try {
		return getServiceContainer().cradle.siteProcessManager.hasRunningProcess(site);
	} catch {
		return startedSites.has(siteId);
	}
}

/**
 * Major version of the data in the site's volume: the recorded value, or the
 * major of the deployed container when none is recorded.
 */
function effectiveDataMajor(siteId: string, deployedVersion: string | null): number | null {
	const recorded = getDataMajor(siteId);
	if (recorded !== null) return recorded;
	return deployedVersion ? majorOf(deployedVersion) : null;
}

export function isMajorChangePending(siteId: string, deployedVersion: string | null): boolean {
	const dataMajor = effectiveDataMajor(siteId, deployedVersion);
	if (dataMajor === null) return false;
	const selectedMajor = majorOf(getVersion(siteId));
	return dataMajor !== selectedMajor;
}

/**
 * Picks a free port that no other site stores. The check and the save run
 * without an await in between, so concurrent calls cannot pick the same port.
 */
async function assignNewPort(siteId: string, exclude: number[] = []): Promise<number> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const candidate = await findFreePort();
		const taken = getPortsOfOtherSites(siteId);
		if (candidate > 0 && !taken.has(candidate) && !exclude.includes(candidate)) {
			setPort(siteId, candidate);
			return candidate;
		}
	}
	throw new Error('Could not find a free port for Elasticsearch.');
}

/**
 * Returns the site's stored port, assigning a new one when none is stored or
 * another site (e.g. a clone) holds the same port. A site whose container is
 * bound to the stored port keeps it, so a clone moves and the original stays.
 */
async function ensurePort(siteId: string, boundPort: number | null): Promise<number> {
	const stored = getPort(siteId);
	if (stored === null) return assignNewPort(siteId);
	if (stored === boundPort || !getPortsOfOtherSites(siteId).has(stored)) return stored;
	return assignNewPort(siteId);
}

/** Points an existing EP_HOST marker block at the given port. */
async function syncEpHost(siteId: string, port: number): Promise<void> {
	const site = getSite(siteId);
	if (!site) return;
	const current = await getEpHost(site);
	const expected = hostUriFor(port);
	if (current === null || current === expected) return;
	const result = await setEpHost(site, expected);
	if (!result.ok) {
		throw new Error(result.error ?? 'Could not update EP_HOST in wp-config.php.');
	}
}

/**
 * Starts the site's container and returns the generation of this start, for
 * its readiness watcher. Must run inside the site lock.
 */
async function startForSite(siteId: string): Promise<number> {
	const generation = bumpGeneration(siteId);
	const docker = await getDockerStatus();
	if (!docker.available) {
		throw new DockerError(docker.error ?? 'Docker is not available.');
	}

	const info = await inspectContainer(siteId);
	const deployedVersion = versionOfImage(info?.image ?? null);
	const recordedMajor = getDataMajor(siteId);
	if (recordedMajor === null && deployedVersion) {
		setDataMajor(siteId, majorOf(deployedVersion));
	}
	if (isMajorChangePending(siteId, deployedVersion)) {
		throw new Error(MAJOR_CHANGE_PENDING_ERROR);
	}

	const version = getVersion(siteId);
	let port = await ensurePort(siteId, info?.boundPort ?? null);
	try {
		await startContainer(siteId, version, port);
	} catch (err) {
		if (!isPortConflict(err)) throw err;
		const busy = port;
		port = await assignNewPort(siteId, [busy]);
		console.warn(`[elasticsearch] Port ${busy} is taken for site ${siteId}; retrying on ${port}.`);
		await removeContainer(siteId);
		await startContainer(siteId, version, port);
	}

	setDataMajor(siteId, majorOf(version));
	await syncEpHost(siteId, port);
	return generation;
}

/**
 * Waits for cluster health in the background so Local's site start never
 * blocks on it. The watcher stops once a later start, stop or removal
 * replaces `generation`.
 */
function watchReadiness(siteId: string, generation: number): void {
	const isStale = () => !isCurrentGeneration(siteId, generation);
	(async () => {
		const info = await inspectContainer(siteId);
		if (!info?.hostPort || isStale()) return;
		const result = await waitForElasticsearchReady(siteId, loopbackUriFor(info.hostPort), isStale);
		if (result.ready || isStale()) return;
		console.error(`[elasticsearch] Site ${siteId}: ${result.error}`);
		if (!result.exited || !isEnabled(siteId) || !isSiteRunning(siteId)) return;
		setLastError(siteId, "Elasticsearch exited during startup. See Local's log for the container output.");
	})().catch((err) => console.error(`[elasticsearch] Readiness check failed for site ${siteId}:`, err));
}

/**
 * Queues the container start and returns without waiting for it, so Local's
 * site start never waits on Docker.
 */
export function onSiteStarted(siteId: string): void {
	markSiteRunning(siteId, true);
	void runStartupTasks();
	withSiteLock(siteId, async () => {
		// The site stopped, or Elasticsearch was disabled, while this start waited in the queue.
		if (!isSiteRunning(siteId) || !isEnabled(siteId)) return;
		try {
			// Applies the startup version reconcile to this site before its first start.
			if (!startupDone) {
				await reconcileSite(siteId).catch((err) =>
					console.error(`[elasticsearch] Version reconcile failed for site ${siteId}:`, err)
				);
			}
			const generation = await startForSite(siteId);
			clearLastError(siteId);
			watchReadiness(siteId, generation);
		} catch (err) {
			console.error('[elasticsearch] siteStarted handler failed:', err);
			setLastError(siteId, describe(err));
		}
	}).catch((err) => console.error('[elasticsearch] siteStarted handler failed:', err));
}

/** Queues the container stop and returns without waiting for it. */
export function onSiteStopped(siteId: string): void {
	markSiteRunning(siteId, false);
	bumpGeneration(siteId);
	withSiteLock(siteId, async () => {
		// A disabled site's container is already stopped, so errors only matter when enabled.
		const enabled = isEnabled(siteId);
		try {
			await stopContainer(siteId);
			if (enabled) clearLastError(siteId);
		} catch (err) {
			if (!enabled) return;
			console.error('[elasticsearch] siteStopped handler failed:', err);
			setLastError(siteId, describe(err));
		}
	}).catch((err) => console.error('[elasticsearch] siteStopped handler failed:', err));
}

/**
 * Removes the container and data volume of a deleted site. Local deletes the
 * site's data before firing the hook, so only the ID is available.
 */
export async function onSiteDeleted(siteId: string): Promise<void> {
	markSiteRunning(siteId, false);
	bumpGeneration(siteId);
	clearLastError(siteId);
	await withSiteLock(siteId, async () => {
		try {
			await removeContainer(siteId);
			await removeVolume(siteId);
		} catch (err) {
			// Without Docker, the startup sweep removes the container and volume later.
			if (err instanceof DockerNotFoundError) return;
			console.error('[elasticsearch] siteDeleted handler failed:', err);
		}
	});
}

export function setSiteEnabled(siteId: string, enabled: boolean): Promise<Result & { enabled: boolean }> {
	return withSiteLock(siteId, async () => {
		setEnabled(siteId, enabled);

		if (enabled) {
			if (!isSiteRunning(siteId)) return { ok: true, enabled: true };
			try {
				const generation = await startForSite(siteId);
				clearLastError(siteId);
				watchReadiness(siteId, generation);
				return { ok: true, enabled: true };
			} catch (err) {
				console.error('[elasticsearch] Enabling Elasticsearch failed:', err);
				setEnabled(siteId, false);
				bumpGeneration(siteId);
				await stopContainer(siteId).catch(() => {});
				const error = describe(err);
				setLastError(siteId, error);
				return { ok: false, enabled: false, error };
			}
		}

		bumpGeneration(siteId);
		const errors: string[] = [];
		const docker = await getDockerStatus();
		if (docker.available) {
			try {
				await stopContainer(siteId);
			} catch (err) {
				errors.push(describe(err));
			}
		}
		const site = getSite(siteId);
		if (site) {
			const removed = await removeEpHost(site);
			if (!removed.ok && removed.error) errors.push(removed.error);
		}
		if (errors.length > 0) {
			const error = errors.join(' ');
			setLastError(siteId, error);
			return { ok: false, enabled: false, error };
		}
		clearLastError(siteId);
		return { ok: true, enabled: false };
	});
}

export function setSiteEpEnabled(siteId: string, enabled: boolean): Promise<Result> {
	return withSiteLock(siteId, async () => {
		const site = getSite(siteId);
		if (!site) return { ok: false, error: 'Unknown site.' };
		if (!enabled) return removeEpHost(site);
		try {
			const info = await inspectContainer(siteId);
			if (!info?.hostPort) return { ok: false, error: 'Elasticsearch is not running for this site.' };
			return await setEpHost(site, hostUriFor(info.hostPort));
		} catch (err) {
			return { ok: false, error: describe(err) };
		}
	});
}

/**
 * Deletes the container and data volume, then recreates the container when
 * Elasticsearch is enabled and the site is running. Runs only while a major
 * version change is pending for the site.
 */
export function recreateVolume(siteId: string): Promise<Result> {
	return withSiteLock(siteId, async () => {
		try {
			const info = await inspectContainer(siteId);
			const deployedVersion = versionOfImage(info?.image ?? null);
			if (!isMajorChangePending(siteId, deployedVersion)) {
				return { ok: false, error: 'No major version change is pending for this site.' };
			}
			bumpGeneration(siteId);
			await removeContainer(siteId);
			await removeVolume(siteId);
			const volumeLeft = await volumeExists(siteId);
			if (volumeLeft) {
				throw new Error('The Elasticsearch data volume still exists after removal.');
			}
			setDataMajor(siteId, null);
			if (isEnabled(siteId) && isSiteRunning(siteId)) {
				const generation = await startForSite(siteId);
				watchReadiness(siteId, generation);
			}
			clearLastError(siteId);
			return { ok: true };
		} catch (err) {
			console.error('[elasticsearch] recreateVolume failed:', err);
			const error = describe(err);
			setLastError(siteId, error);
			return { ok: false, error };
		}
	});
}

/**
 * Stores the selected version. When the site is running and the data volume
 * holds the same major, the container is recreated on the new image now;
 * otherwise the version applies on the next start.
 */
export function setSiteVersion(siteId: string, version: EsVersion): Promise<Result & { version: string }> {
	return withSiteLock(siteId, async () => {
		setVersion(siteId, version);
		bumpGeneration(siteId);
		if (!isEnabled(siteId) || !isSiteRunning(siteId)) return { ok: true, version };
		try {
			const info = await inspectContainer(siteId);
			const deployedVersion = versionOfImage(info?.image ?? null);
			if (deployedVersion === version || isMajorChangePending(siteId, deployedVersion)) {
				return { ok: true, version };
			}
			const generation = await startForSite(siteId);
			clearLastError(siteId);
			watchReadiness(siteId, generation);
			return { ok: true, version };
		} catch (err) {
			console.error('[elasticsearch] Applying the Elasticsearch version failed:', err);
			const error = describe(err);
			setLastError(siteId, error);
			return { ok: false, version, error };
		}
	});
}

/**
 * Reverts an unconfirmed major version selection to a version matching the
 * data volume, so a restart of Local keeps the existing data usable.
 */
async function reconcileSite(siteId: string): Promise<void> {
	if (!isEnabled(siteId)) return;
	const info = await inspectContainer(siteId);
	const deployedVersion = versionOfImage(info?.image ?? null);
	const recordedMajor = getDataMajor(siteId);
	if (recordedMajor === null && deployedVersion) {
		setDataMajor(siteId, majorOf(deployedVersion));
	}
	if (!isMajorChangePending(siteId, deployedVersion)) return;

	const dataMajor = effectiveDataMajor(siteId, deployedVersion);
	const deployedMajor = deployedVersion ? majorOf(deployedVersion) : null;
	const revertTo =
		deployedVersion && isSupportedVersion(deployedVersion) && deployedMajor === dataMajor
			? deployedVersion
			: SUPPORTED_VERSIONS.find((v) => majorOf(v) === dataMajor);
	if (revertTo) setVersion(siteId, revertTo);
}

/** Throws when any of the settled tasks failed, after logging each failure. */
function throwOnFailure(results: PromiseSettledResult<unknown>[], label: string): void {
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
	for (const failure of failures) console.error(`[elasticsearch] ${label}:`, failure.reason);
	if (failures.length > 0) throw new Error(`${label} (${failures.length} failed).`);
}

async function reconcileVersions(): Promise<void> {
	const results = await Promise.allSettled(
		getSiteIds().map((siteId) => withSiteLock(siteId, () => reconcileSite(siteId)))
	);
	throwOnFailure(results, 'Version reconcile failed');
}

/**
 * Cleans up after a crash or a site deleted while Docker was down. Removes
 * the container and data volume of a site that no longer exists, and stops
 * the container of a site that is not running.
 */
async function sweepOrphanedContainers(): Promise<void> {
	const containers = await listAllContainers();
	// An empty site list means Local has not loaded its sites, so no container counts as deleted.
	const sitesLoaded = getSiteIds().length > 0;
	const results = await Promise.allSettled(
		containers.map(async ({ name, siteId, running }) => {
			if (!siteId) {
				if (running) await stopContainerByName(name);
				return;
			}
			await withSiteLock(siteId, async () => {
				if (!getSite(siteId)) {
					if (!sitesLoaded) return;
					bumpGeneration(siteId);
					await removeContainerByName(name);
					await removeVolume(siteId);
					return;
				}
				if (!running || isSiteRunning(siteId)) return;
				bumpGeneration(siteId);
				await stopContainerByName(name);
			});
		})
	);
	throwOnFailure(results, 'Orphan sweep failed');
}

/**
 * Orphan sweep and version reconcile. Runs as soon as Docker is available:
 * at add-on load, or later on a site start or status poll. Runs again on the
 * next trigger until both tasks succeed.
 */
export function runStartupTasks(): Promise<void> {
	if (startupDone) return Promise.resolve();
	if (startupInFlight) return startupInFlight;
	const sinceFailure = Date.now() - lastStartupFailure;
	if (sinceFailure < STARTUP_RETRY_MS) return Promise.resolve();
	startupInFlight = (async () => {
		const docker = await getDockerStatus();
		if (!docker.available) return;
		const results = await Promise.allSettled([sweepOrphanedContainers(), reconcileVersions()]);
		const failed = results.some((result) => result.status === 'rejected');
		if (failed) {
			lastStartupFailure = Date.now();
			return;
		}
		startupDone = true;
	})()
		.catch((err) => {
			lastStartupFailure = Date.now();
			console.error('[elasticsearch] Startup tasks failed:', err);
		})
		.finally(() => {
			startupInFlight = null;
		});
	return startupInFlight;
}

/** Stops every running add-on container. Used when Local quits. */
export async function stopAllContainers(): Promise<void> {
	const running = await listRunningContainers();
	await Promise.allSettled(running.map(({ name }) => stopContainerByName(name)));
}
