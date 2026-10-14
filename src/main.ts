import * as LocalMain from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	HEAP_MB,
	containerNameFor,
	getDockerStatus,
	hostUriFor,
	inspectContainer,
	isElasticsearchReady,
	listRunningContainers,
	loopbackUriFor,
	versionOfImage,
} from './docker';
import { registerHooks } from './hooks';
import {
	getLastError,
	isMajorChangePending,
	isSiteRunning,
	recreateVolume,
	runStartupTasks,
	setSiteEnabled,
	setSiteEpEnabled,
	setSiteVersion,
	stopAllContainers,
} from './lifecycle';
import { getEpHost, getForeignEpHost } from './wpconfig';
import { DEFAULT_VERSION, SUPPORTED_VERSIONS, getSite, getVersion, isEnabled, isSupportedVersion } from './storage';
import type { Status } from './types';

const RAM_WARNING_THRESHOLD = 2;
const QUIT_CLEANUP_TIMEOUT_MS = 15_000;
const QUIT_CANCELLED_AFTER_MS = 5_000;

const INVALID_SITE = 'Unknown site.';
const INVALID_ENABLED = 'The enabled flag must be a boolean.';

let quitListenerRegistered = false;

function siteFor(siteId: unknown): Local.Site | null {
	if (typeof siteId !== 'string' || siteId === '') return null;
	return getSite(siteId);
}

function baseStatus(): Status {
	return {
		dockerAvailable: false,
		dockerMissing: false,
		dockerError: null,
		siteRunning: false,
		containerRunning: false,
		containerExists: false,
		ready: false,
		runningCount: 0,
		warningThreshold: RAM_WARNING_THRESHOLD,
		ramPerInstanceMb: HEAP_MB,
		version: DEFAULT_VERSION,
		deployedVersion: null,
		hostUri: null,
		supportedVersions: SUPPORTED_VERSIONS,
		defaultVersion: DEFAULT_VERSION,
		epCurrent: null,
		epForeign: null,
		lastError: null,
		majorChangePending: false,
	};
}

async function getStatus(site: Local.Site): Promise<Status> {
	const siteId = site.id;
	// A wp-config.php read error is reported in this status only, not stored.
	let configError: string | null = null;
	const readEp = (read: Promise<string | null>) =>
		read.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			configError = `Could not read wp-config.php: ${message}`;
			return null;
		});
	const [docker, epCurrent, epForeign] = await Promise.all([
		getDockerStatus(),
		readEp(getEpHost(site)),
		readEp(getForeignEpHost(site)),
	]);
	const errors = [getLastError(siteId), configError].filter((error): error is string => Boolean(error));
	const status: Status = {
		...baseStatus(),
		dockerAvailable: docker.available,
		dockerMissing: docker.missing,
		dockerError: docker.error,
		siteRunning: isSiteRunning(siteId),
		version: getVersion(siteId),
		epCurrent,
		epForeign,
		lastError: errors.length > 0 ? errors.join(' ') : null,
		majorChangePending: isMajorChangePending(siteId, null),
	};
	if (!docker.available) return status;

	runStartupTasks();

	try {
		const [info, running] = await Promise.all([inspectContainer(siteId), listRunningContainers()]);
		const deployedVersion = versionOfImage(info?.image ?? null);
		const hostUri = info?.hostPort ? hostUriFor(info.hostPort) : null;
		status.containerExists = info !== null;
		status.containerRunning = info?.running ?? false;
		status.runningCount = running.length;
		status.deployedVersion = deployedVersion;
		status.hostUri = hostUri;
		status.majorChangePending = isMajorChangePending(siteId, deployedVersion);
		const probeUri = info?.hostPort ? loopbackUriFor(info.hostPort) : null;
		status.ready = status.containerRunning && probeUri ? await isElasticsearchReady(probeUri) : false;
	} catch (err) {
		console.error(`[elasticsearch] Status check failed for ${containerNameFor(siteId)}:`, err);
	}
	return status;
}

export default function (context: LocalMain.AddonMainContext): void {
	const { electron } = context;
	const { app, ipcMain } = electron;

	registerHooks();
	runStartupTasks();

	if (!quitListenerRegistered) {
		quitListenerRegistered = true;
		let quitting = false;
		app.on('before-quit', (event: { preventDefault: () => void }) => {
			if (quitting) return;
			event.preventDefault();
			quitting = true;
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_CLEANUP_TIMEOUT_MS).unref());
			Promise.race([stopAllContainers(), timeout])
				.catch((err) => console.error('[elasticsearch] shutdown stop failed:', err))
				.finally(() => {
					app.quit();
					// Another handler may cancel the quit; a later quit then runs cleanup again.
					setTimeout(() => {
						quitting = false;
					}, QUIT_CANCELLED_AFTER_MS).unref();
				});
		});
	}

	const handle = (channel: string, listener: (...args: any[]) => unknown) => {
		ipcMain.removeHandler(channel);
		ipcMain.handle(channel, listener);
	};

	handle('elasticsearch:isEnabled', (_e: unknown, siteId: unknown) => {
		const site = siteFor(siteId);
		if (!site) return false;
		try {
			return isEnabled(site.id);
		} catch (err) {
			console.error('[elasticsearch] isEnabled failed:', err);
			return false;
		}
	});

	handle('elasticsearch:setEnabled', async (_e: unknown, siteId: unknown, enabled: unknown) => {
		const site = siteFor(siteId);
		if (!site) return { ok: false, enabled: false, error: INVALID_SITE };
		if (typeof enabled !== 'boolean') {
			return { ok: false, enabled: isEnabled(site.id), error: INVALID_ENABLED };
		}
		return setSiteEnabled(site.id, enabled);
	});

	handle('elasticsearch:setEpEnabled', async (_e: unknown, siteId: unknown, enabled: unknown) => {
		const site = siteFor(siteId);
		if (!site) return { ok: false, error: INVALID_SITE };
		if (typeof enabled !== 'boolean') return { ok: false, error: INVALID_ENABLED };
		return setSiteEpEnabled(site.id, enabled);
	});

	handle('elasticsearch:recreateVolume', async (_e: unknown, siteId: unknown) => {
		const site = siteFor(siteId);
		if (!site) return { ok: false, error: INVALID_SITE };
		return recreateVolume(site.id);
	});

	handle('elasticsearch:setVersion', async (_e: unknown, siteId: unknown, version: unknown) => {
		const site = siteFor(siteId);
		if (!site) return { ok: false, version: DEFAULT_VERSION, error: INVALID_SITE };
		if (!isSupportedVersion(version)) {
			return { ok: false, version: getVersion(site.id), error: 'Unsupported Elasticsearch version.' };
		}
		return setSiteVersion(site.id, version);
	});

	handle('elasticsearch:status', async (_e: unknown, siteId: unknown) => {
		const site = siteFor(siteId);
		if (!site) return baseStatus();
		try {
			return await getStatus(site);
		} catch (err) {
			console.error('[elasticsearch] status failed:', err);
			return baseStatus();
		}
	});
}
