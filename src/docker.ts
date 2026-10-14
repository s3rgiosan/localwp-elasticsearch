import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import * as os from 'os';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const CONTAINER_PREFIX = 'localwp-elasticsearch-';
const CONTAINER_LABEL = 'com.localwp.addon=elasticsearch';
const SITE_LABEL = 'com.localwp.siteId';
const IMAGE_LABEL = 'com.localwp.esImage';
const CONFIG_LABEL = 'com.localwp.esConfig';

/** Heap size given to each Elasticsearch container, in MB. */
export const HEAP_MB = 512;

const QUERY_TIMEOUT_MS = 10_000;
const REGISTRY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 10 * 60_000;

const NOT_FOUND_RE = /no such (container|object|volume|image)/i;
const PORT_CONFLICT_RE = /port is already allocated|address already in use/i;

export class DockerError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = 'DockerError';
	}
}

class DockerTimeoutError extends DockerError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = 'DockerTimeoutError';
	}
}

export class DockerNotFoundError extends DockerError {
	constructor(cause?: unknown) {
		super(
			'Docker executable not found. Install Docker Desktop, Colima, OrbStack or Rancher Desktop, then try again.',
			cause
		);
		this.name = 'DockerNotFoundError';
	}
}

type DockerStatus = {
	available: boolean;
	/** The `docker` CLI could not be found. */
	missing: boolean;
	error: string | null;
};

type ContainerInfo = {
	running: boolean;
	/** Image the container was created from, read from its label. */
	image: string | null;
	/** Hash of the settings the container was created with, read from its label. */
	config: string | null;
	/** Host port currently published for 9200, only while running. */
	hostPort: number | null;
	/** Host port the container is configured to bind for 9200. */
	boundPort: number | null;
};

type AddonContainer = { name: string; siteId: string | null; running: boolean };

type ReadyResult = { ready: boolean; exited: boolean; error?: string };

function dockerCandidates(): string[] {
	const home = os.homedir();
	return [
		'/opt/homebrew/bin/docker',
		'/usr/local/bin/docker',
		path.join(home, '.docker/bin/docker'),
		'/Applications/Docker.app/Contents/Resources/bin/docker',
		path.join(home, '.rd/bin/docker'),
		path.join(home, '.rancher-desktop/bin/docker'),
		path.join(home, '.orbstack/bin/docker'),
		'/usr/bin/docker',
	];
}

let dockerBin: string | null = null;

/**
 * Finds the docker binary. A found path is cached; a miss is retried on the
 * next call so installing Docker does not require restarting Local.
 */
function resolveDockerBin(): string | null {
	if (dockerBin) return dockerBin;
	for (const candidate of dockerCandidates()) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			dockerBin = candidate;
			return dockerBin;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/**
 * Environment for docker calls. Local launched from Finder has a minimal PATH,
 * so credential helpers such as docker-credential-desktop would not be found.
 * HOME stays set so the CLI uses the active context from ~/.docker/config.json.
 */
function dockerEnv(bin: string | null): NodeJS.ProcessEnv {
	const home = os.homedir();
	const dirs = [
		bin ? path.dirname(bin) : null,
		'/opt/homebrew/bin',
		'/usr/local/bin',
		path.join(home, '.docker/bin'),
		process.env.PATH ?? null,
	].filter((dir): dir is string => Boolean(dir));
	return { ...process.env, HOME: process.env.HOME ?? home, PATH: dirs.join(':') };
}

function stderrOf(err: unknown): string {
	const error = err as { stderr?: unknown; message?: unknown };
	return String(error?.stderr ?? error?.message ?? '');
}

function firstLine(text: string): string {
	return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function isNoSuchError(err: unknown): boolean {
	return NOT_FOUND_RE.test(stderrOf(err));
}

/** Wraps a failed docker call, keeping the not-found and timeout kinds. */
function wrapError(message: string, err: unknown): DockerError {
	if (err instanceof DockerNotFoundError) return err;
	if (err instanceof DockerTimeoutError) return new DockerTimeoutError(message, err);
	return new DockerError(message, err);
}

export function isPortConflict(err: unknown): boolean {
	const cause = err instanceof DockerError ? err.cause : err;
	return PORT_CONFLICT_RE.test(stderrOf(cause)) || PORT_CONFLICT_RE.test(stderrOf(err));
}

/** Short, human-readable reason for a failed docker call. */
export function describeError(err: unknown): string {
	if (err instanceof DockerError) {
		const detail = err.cause ? firstLine(stderrOf(err.cause)) : '';
		return detail && !err.message.includes(detail) ? `${err.message} ${detail}` : err.message;
	}
	return firstLine(stderrOf(err)) || String(err);
}

async function execDocker(args: string[], timeout = QUERY_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
	const bin = resolveDockerBin();
	const command = bin ?? 'docker';
	try {
		return await execFileAsync(command, args, {
			timeout,
			env: dockerEnv(bin),
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (err) {
		const error = err as { code?: unknown; killed?: boolean; signal?: unknown };
		// A vanished binary is looked up again on the next call.
		if (error?.code === 'ENOENT') dockerBin = null;
		if (error?.code === 'ENOENT' || error?.code === 127) {
			throw new DockerNotFoundError(err);
		}
		if (error?.killed) {
			throw new DockerTimeoutError(`Docker did not respond within ${Math.round(timeout / 1000)}s (docker ${args[0]}).`, err);
		}
		throw err;
	}
}

export function containerNameFor(siteId: string): string {
	return `${CONTAINER_PREFIX}${siteId}`;
}

function volumeNameFor(siteId: string): string {
	return `${CONTAINER_PREFIX}${siteId}-data`;
}

/** EP_HOST value written to wp-config.php. */
export function hostUriFor(port: number): string {
	return `http://localhost:${port}`;
}

/** URL the main process uses to reach the container. */
export function loopbackUriFor(port: number): string {
	return `http://127.0.0.1:${port}`;
}

export async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Reports whether the Docker daemon answers, and why not when it does not.
 */
export async function getDockerStatus(): Promise<DockerStatus> {
	try {
		await execDocker(['info', '--format', '{{.ServerVersion}}']);
		return { available: true, missing: false, error: null };
	} catch (err) {
		if (err instanceof DockerNotFoundError) return { available: false, missing: true, error: err.message };
		const detail = firstLine(stderrOf(err instanceof DockerError ? err.cause : err));
		const reason = detail ? ` (${detail})` : '';
		return {
			available: false,
			missing: false,
			error: `Docker is installed but the daemon is not running. Start Docker Desktop, Colima or your Docker runtime.${reason}`,
		};
	}
}

let hostPlatformCache: string | null = null;

function normalizeArch(arch: string): string | null {
	switch (arch) {
		case 'aarch64':
		case 'arm64':
			return 'linux/arm64';
		case 'x86_64':
		case 'amd64':
		case 'x64':
			return 'linux/amd64';
		default:
			return null;
	}
}

/**
 * Platform of the Docker engine. Electron's own arch is wrong for an x64 Local
 * running under Rosetta, so the engine is asked first.
 */
async function hostPlatform(): Promise<string> {
	if (hostPlatformCache) return hostPlatformCache;
	try {
		const { stdout } = await execDocker(['info', '--format', '{{.Architecture}}']);
		const platform = normalizeArch(stdout.trim());
		if (platform) {
			hostPlatformCache = platform;
			return platform;
		}
	} catch {
		/* fall back to the Electron process arch */
	}
	return normalizeArch(os.arch()) ?? 'linux/amd64';
}

const manifestCache = new Map<string, Set<string>>();

async function imagePlatforms(image: string): Promise<Set<string>> {
	const cached = manifestCache.get(image);
	if (cached) return cached;
	const platforms = new Set<string>();
	try {
		const { stdout } = await execDocker(['manifest', 'inspect', image], REGISTRY_TIMEOUT_MS);
		const parsed = JSON.parse(stdout) as {
			manifests?: { platform?: { os?: string; architecture?: string } }[];
		};
		for (const m of parsed.manifests ?? []) {
			const p = m.platform;
			if (p?.os && p.architecture) platforms.add(`${p.os}/${p.architecture}`);
		}
		manifestCache.set(image, platforms);
	} catch {
		/* unknown platforms; retried on the next start */
	}
	return platforms;
}

/**
 * Platform to pull, or null to let Docker choose: when the registry lists no
 * platforms, or neither the host platform nor linux/amd64.
 */
async function platformFor(image: string): Promise<string | null> {
	const [host, available] = await Promise.all([hostPlatform(), imagePlatforms(image)]);
	if (available.size === 0) return null;
	if (available.has(host)) return host;
	if (available.has('linux/amd64')) return 'linux/amd64';
	return null;
}

function imageFor(version: string): string {
	const major = parseInt(version, 10);
	const repo = major >= 6 ? 'docker.elastic.co/elasticsearch/elasticsearch' : 'elasticsearch';
	return `${repo}:${version}`;
}

function envFlagsFor(version: string): string[] {
	const major = parseInt(version, 10);
	const flags = ['-e', `ES_JAVA_OPTS=-Xms${HEAP_MB}m -Xmx${HEAP_MB}m`];
	// The 5.x image reads no settings from the environment and runs as a single node by default.
	if (major >= 6) flags.push('-e', 'discovery.type=single-node', '-e', 'xpack.security.enabled=false');
	if (major === 7) {
		// Opts in to the 8.x disk watermark behavior, which clears the 7.x deprecation warning.
		flags.push('-e', 'cluster.routing.allocation.disk.watermark.enable_for_single_data_node=true');
		// ElasticPress uses no GeoIP processor, so the startup database download is skipped.
		flags.push('-e', 'ingest.geoip.downloader.enabled=false');
	}
	return flags;
}

/** Short hash of the container settings, so a change in them recreates the container. */
function configHashFor(version: string): string {
	return createHash('sha256').update(envFlagsFor(version).join('\n')).digest('hex').slice(0, 12);
}

function parsePort(value: unknown): number | null {
	const port = parseInt(String(value ?? ''), 10);
	return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Inspects the site's container. Returns null when it does not exist and
 * throws on any other Docker failure.
 */
export async function inspectContainer(siteId: string): Promise<ContainerInfo | null> {
	let stdout: string;
	try {
		({ stdout } = await execDocker(['inspect', '--type', 'container', '--format', '{{json .}}', containerNameFor(siteId)]));
	} catch (err) {
		if (isNoSuchError(err)) return null;
		throw err;
	}
	const data = JSON.parse(stdout) as {
		State?: { Running?: boolean };
		Config?: { Labels?: Record<string, string> };
		NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> };
		HostConfig?: { PortBindings?: Record<string, { HostPort?: string }[] | null> };
	};
	const running = data.State?.Running === true;
	const published = data.NetworkSettings?.Ports?.['9200/tcp']?.[0]?.HostPort;
	const bound = data.HostConfig?.PortBindings?.['9200/tcp']?.[0]?.HostPort;
	return {
		running,
		image: data.Config?.Labels?.[IMAGE_LABEL] || null,
		config: data.Config?.Labels?.[CONFIG_LABEL] || null,
		hostPort: running ? parsePort(published) : null,
		boundPort: parsePort(bound),
	};
}

async function isContainerRunning(siteId: string): Promise<boolean> {
	const info = await inspectContainer(siteId);
	return info?.running ?? false;
}

export function versionOfImage(image: string | null): string | null {
	if (!image) return null;
	return image.split(':').pop() ?? null;
}

async function queryContainers(includeStopped: boolean): Promise<AddonContainer[]> {
	const { stdout } = await execDocker([
		'ps',
		...(includeStopped ? ['-a'] : []),
		'--filter',
		`label=${CONTAINER_LABEL}`,
		'--format',
		`{{.Names}}\t{{.Label "${SITE_LABEL}"}}\t{{.State}}`,
	]);
	return stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [name, label, state] = line.split('\t');
			// Containers without the site label carry the ID in their name.
			const fromName = name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : '';
			const siteId = label || fromName;
			return { name, siteId: siteId || null, running: state === 'running' };
		});
}

/** Running add-on containers. Throws on Docker failure. */
export async function listRunningContainers(): Promise<AddonContainer[]> {
	return queryContainers(false);
}

/** Add-on containers in any state. Throws on Docker failure. */
export async function listAllContainers(): Promise<AddonContainer[]> {
	return queryContainers(true);
}

export async function removeContainer(siteId: string): Promise<void> {
	return removeContainerByName(containerNameFor(siteId));
}

export async function removeContainerByName(name: string): Promise<void> {
	try {
		await execDocker(['rm', '-f', name], STOP_TIMEOUT_MS);
	} catch (err) {
		if (isNoSuchError(err)) return;
		throw wrapError(`Failed to remove Elasticsearch container ${name}.`, err);
	}
}

export async function removeVolume(siteId: string): Promise<void> {
	const volume = volumeNameFor(siteId);
	try {
		await execDocker(['volume', 'rm', '-f', volume], STOP_TIMEOUT_MS);
	} catch (err) {
		if (isNoSuchError(err)) return;
		throw wrapError(`Failed to remove Elasticsearch data volume ${volume}.`, err);
	}
}

export async function volumeExists(siteId: string): Promise<boolean> {
	try {
		await execDocker(['volume', 'inspect', volumeNameFor(siteId)]);
		return true;
	} catch (err) {
		if (isNoSuchError(err)) return false;
		throw err;
	}
}

/** Platform of the local copy of the image, or null when it is not present. */
async function localImagePlatform(image: string): Promise<string | null> {
	try {
		const { stdout } = await execDocker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]);
		return stdout.trim() || null;
	} catch (err) {
		if (isNoSuchError(err)) return null;
		throw err;
	}
}

/**
 * Returns the platform to run the image with, pulling the image first when it
 * is not present locally. The registry is only asked for its platforms on a pull.
 */
async function ensureImage(image: string): Promise<string | null> {
	const local = await localImagePlatform(image);
	if (local) return local;
	const platform = await platformFor(image);
	try {
		await execDocker(['pull', ...(platform ? ['--platform', platform] : []), image], PULL_TIMEOUT_MS);
	} catch (err) {
		throw wrapError(`Failed to pull ${image}.`, err);
	}
	return platform;
}

/**
 * Error for a failed `docker run` or `docker start`. A container left in the
 * `created` state after a timeout means the Docker daemon is not starting
 * containers, which a Docker restart fixes.
 */
async function startFailure(siteId: string, version: string, err: unknown): Promise<DockerError> {
	if (err instanceof DockerTimeoutError) {
		const state = await containerState(containerNameFor(siteId)).catch(() => null);
		if (state === 'created') {
			return new DockerError(
				'Docker created the Elasticsearch container but did not start it. Restart Docker, then start the site again.',
				err
			);
		}
	}
	return wrapError(`Failed to start Elasticsearch ${version} for site ${siteId}.`, err);
}

async function containerState(name: string): Promise<string> {
	const { stdout } = await execDocker(['inspect', '--type', 'container', '--format', '{{.State.Status}}', name]);
	return stdout.trim();
}

/**
 * Starts the site's container on `hostPort`, reusing an existing container
 * when its image, port and settings match and recreating it otherwise. The data volume
 * is kept.
 */
export async function startContainer(siteId: string, version: string, hostPort: number): Promise<void> {
	const name = containerNameFor(siteId);
	const volume = volumeNameFor(siteId);
	const image = imageFor(version);

	const info = await inspectContainer(siteId);
	if (info) {
		const matches = info.image === image && info.boundPort === hostPort && info.config === configHashFor(version);
		if (matches && info.running) return;
		if (matches) {
			try {
				await execDocker(['start', name], START_TIMEOUT_MS);
				return;
			} catch (err) {
				throw await startFailure(siteId, version, err);
			}
		}
		if (info.running) await stopContainerByName(name);
		await removeContainer(siteId);
	}

	const platform = await ensureImage(image);

	try {
		await execDocker(
			[
				'run',
				'-d',
				...(platform ? ['--platform', platform] : []),
				'--name',
				name,
				'--label',
				CONTAINER_LABEL,
				'--label',
				`${SITE_LABEL}=${siteId}`,
				'--label',
				`${IMAGE_LABEL}=${image}`,
				'--label',
				`${CONFIG_LABEL}=${configHashFor(version)}`,
				...envFlagsFor(version),
				'-v',
				`${volume}:/usr/share/elasticsearch/data`,
				'-p',
				`127.0.0.1:${hostPort}:9200`,
				image,
			],
			START_TIMEOUT_MS
		);
	} catch (err) {
		throw await startFailure(siteId, version, err);
	}
}

export async function stopContainer(siteId: string): Promise<void> {
	return stopContainerByName(containerNameFor(siteId));
}

export async function stopContainerByName(name: string): Promise<void> {
	try {
		await execDocker(['stop', name], STOP_TIMEOUT_MS);
	} catch (err) {
		if (isNoSuchError(err)) return;
		throw wrapError(`Failed to stop Elasticsearch container ${name}.`, err);
	}
}

async function containerLogsTail(siteId: string, lines = 20): Promise<string> {
	try {
		const { stdout, stderr } = await execDocker(['logs', '--tail', String(lines), containerNameFor(siteId)]);
		return `${stdout}${stderr}`.trim();
	} catch (err) {
		return `(could not read container logs: ${describeError(err)})`;
	}
}

export async function isElasticsearchReady(hostUri: string): Promise<boolean> {
	try {
		const res = await fetch(`${hostUri}/_cluster/health`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { status?: string };
		return body.status === 'green' || body.status === 'yellow';
	} catch {
		return false;
	}
}

/**
 * Polls cluster health until it is green or yellow. Stops early when the
 * container exits, reporting the tail of its logs, or when `isCancelled`
 * returns true.
 */
export async function waitForElasticsearchReady(
	siteId: string,
	hostUri: string,
	isCancelled: () => boolean,
	timeoutMs = 60_000
): Promise<ReadyResult> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (isCancelled()) return { ready: false, exited: false };
		if (await isElasticsearchReady(hostUri)) return { ready: true, exited: false };
		let running = true;
		try {
			running = await isContainerRunning(siteId);
		} catch {
			/* Docker hiccup; keep polling until the deadline */
		}
		if (isCancelled()) return { ready: false, exited: false };
		if (!running) {
			const logs = await containerLogsTail(siteId);
			return { ready: false, exited: true, error: `Elasticsearch container exited during startup.\n${logs}` };
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	return { ready: false, exited: false, error: `Elasticsearch did not become ready within ${Math.round(timeoutMs / 1000)}s.` };
}
