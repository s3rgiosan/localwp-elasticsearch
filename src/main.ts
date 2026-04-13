import * as LocalMain from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	containerExists,
	ensureNetworkConnected,
	findFreePort,
	getDeployedVersion,
	getHostUri,
	isContainerRunning,
	isDockerAvailable,
	isElasticsearchReady,
	listRunningContainers,
	removeContainer,
	removeVolume,
	startContainer,
	stopContainer,
	stopContainerByName,
} from './docker';
import { registerHooks } from './hooks';
import { getEpHostConstant, removeEpHostConstant, setEpHostConstant } from './wpcli';
import {
	DEFAULT_VERSION,
	SUPPORTED_VERSIONS,
	getPort,
	getVersion,
	initStorage,
	isEnabled,
	setEnabled,
	setPort,
	setVersion,
	type EsVersion,
} from './storage';

const RAM_WARNING_THRESHOLD = 2;

function majorOf(v: string): number {
	return parseInt(v, 10);
}

async function ensurePort(siteId: string): Promise<number> {
	let p = getPort(siteId);
	if (p) return p;
	p = await findFreePort();
	setPort(siteId, p);
	return p;
}

async function reconcileVersions(): Promise<void> {
	try {
		const sites = LocalMain.SiteData.getSites();
		for (const siteId of Object.keys(sites)) {
			const deployed = await getDeployedVersion(siteId);
			if (!deployed) continue;
			const stored = getVersion(siteId);
			if (majorOf(stored) !== majorOf(deployed) && (SUPPORTED_VERSIONS as readonly string[]).includes(deployed)) {
				setVersion(siteId, deployed as EsVersion);
			}
		}
	} catch (err) {
		console.error('[elasticsearch] version reconcile failed:', err);
	}
}

export default function (context: LocalMain.AddonMainContext): void {
	const { electron } = context;

	initStorage();
	registerHooks();
	reconcileVersions().catch((err) =>
		console.error('[elasticsearch] version reconcile failed:', err)
	);

	let shuttingDown = false;
	electron.app.on('before-quit', (event: any) => {
		if (shuttingDown) return;
		event.preventDefault();
		shuttingDown = true;
		(async () => {
			try {
				const names = await listRunningContainers();
				await Promise.all(names.map((n) => stopContainerByName(n)));
			} catch (err) {
				console.error('[elasticsearch] shutdown stop failed:', err);
			} finally {
				electron.app.quit();
			}
		})();
	});

	electron.ipcMain.handle('elasticsearch:isEnabled', (_e: any, siteId: string) =>
		isEnabled(siteId)
	);

	electron.ipcMain.handle(
		'elasticsearch:setEnabled',
		async (_e: any, siteId: string, enabled: boolean) => {
			setEnabled(siteId, enabled);
			try {
				const running = await isContainerRunning(siteId);
				if (enabled && !running && (await containerExists(siteId))) {
					const port = await ensurePort(siteId);
					await startContainer(siteId, getVersion(siteId), port);
					await ensureNetworkConnected(siteId);
				} else if (!enabled && running) {
					await stopContainer(siteId);
				}
			} catch (err) {
				console.error('[elasticsearch] setEnabled handler failed:', err);
			}
			return enabled;
		}
	);

	electron.ipcMain.handle(
		'elasticsearch:setEpEnabled',
		async (_e: any, siteId: string, enabled: boolean) => {
			const site = LocalMain.SiteData.getSite(siteId);
			if (!site) return false;
			try {
				if (enabled) {
					const hostUri = await getHostUri(siteId);
					if (!hostUri) return false;
					await setEpHostConstant(site, hostUri);
					return true;
				}
				await removeEpHostConstant(site);
				return false;
			} catch (err) {
				console.error('[elasticsearch] setEpEnabled handler failed:', err);
				return enabled;
			}
		}
	);

	electron.ipcMain.handle('elasticsearch:status', async (_e: any, siteId: string) => {
		const site = LocalMain.SiteData.getSite(siteId);
		const [dockerAvailable, running, hostUri, exists, deployedVersion, epCurrent] = await Promise.all([
			isDockerAvailable(),
			listRunningContainers(),
			getHostUri(siteId),
			containerExists(siteId),
			getDeployedVersion(siteId),
			site ? getEpHostConstant(site) : Promise.resolve(null),
		]);
		const containerRunning = running.some((n) => n === `localwp-elasticsearch-${siteId}`);
		const ready = containerRunning && hostUri ? await isElasticsearchReady(hostUri) : false;
		return {
			dockerAvailable,
			containerRunning,
			containerExists: exists,
			ready,
			runningCount: running.length,
			warningThreshold: RAM_WARNING_THRESHOLD,
			version: getVersion(siteId),
			deployedVersion,
			hostUri,
			supportedVersions: SUPPORTED_VERSIONS,
			defaultVersion: DEFAULT_VERSION,
			epCurrent,
		};
	});

	electron.ipcMain.handle('elasticsearch:recreateVolume', async (_e: any, siteId: string) => {
		try {
			await removeContainer(siteId);
			await removeVolume(siteId);
			if (isEnabled(siteId)) {
				const port = await ensurePort(siteId);
				await startContainer(siteId, getVersion(siteId), port);
				await ensureNetworkConnected(siteId);
			}
			return true;
		} catch (err) {
			console.error('[elasticsearch] recreateVolume failed:', err);
			return false;
		}
	});

	electron.ipcMain.handle(
		'elasticsearch:setVersion',
		(_e: any, siteId: string, version: EsVersion) => {
			setVersion(siteId, version);
			return version;
		}
	);
}

export type { Local };
