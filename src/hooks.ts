import { HooksMain } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	ensureNetworkConnected,
	findFreePort,
	getHostUri,
	isContainerRunning,
	startContainer,
	stopContainer,
	waitForElasticsearchReady,
} from './docker';
import { getPort, getVersion, isEnabled, setPort } from './storage';

export function registerHooks(): void {
	HooksMain.addAction('siteStarted', async (site: Local.Site) => {
		if (!isEnabled(site.id)) return;
		try {
			let port = getPort(site.id);
			if (!port) {
				port = await findFreePort();
				setPort(site.id, port);
			}
			await startContainer(site.id, getVersion(site.id), port);
			await ensureNetworkConnected(site.id);
			const hostUri = await getHostUri(site.id);
			if (hostUri) await waitForElasticsearchReady(hostUri);
		} catch (err) {
			console.error('[elasticsearch] siteStarted handler failed:', err);
		}
	});

	HooksMain.addAction('siteStopped', async (site: Local.Site) => {
		try {
			if (await isContainerRunning(site.id)) {
				await stopContainer(site.id);
			}
		} catch (err) {
			console.error('[elasticsearch] siteStopped handler failed:', err);
		}
	});
}
