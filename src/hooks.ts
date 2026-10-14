import { HooksMain } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import { onSiteDeleted, onSiteStarted, onSiteStopped } from './lifecycle';

let registered = false;

/** Site ID from a siteDeleted payload, which is either the ID or a site object. */
function siteIdOf(value: unknown): string | null {
	if (typeof value === 'string') return value || null;
	if (typeof value !== 'object' || value === null) return null;
	const { id } = value as { id?: unknown };
	return typeof id === 'string' && id !== '' ? id : null;
}

export function registerHooks(): void {
	if (registered) return;
	registered = true;

	// The start and stop handlers queue their work and return, so Local never waits on Docker.
	HooksMain.addAction('siteStarted', (site: Local.Site) => {
		onSiteStarted(site.id);
	});

	HooksMain.addAction('siteStopped', (site: Local.Site) => {
		onSiteStopped(site.id);
	});

	// Local fires siteDeleted after removing the site's data.
	HooksMain.addAction('siteDeleted', async (payload: string | { id: string }) => {
		const siteId = siteIdOf(payload);
		if (!siteId) return;
		try {
			await onSiteDeleted(siteId);
		} catch (err) {
			console.error('[elasticsearch] siteDeleted handler failed:', err);
		}
	});
}
