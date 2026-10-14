import { getServiceContainer } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';

/** Add-on settings stored on each site. Values come from disk, so readers check their type. */
type AddonFields = {
	elasticsearchEnabled?: unknown;
	elasticsearchVersion?: unknown;
	elasticsearchPort?: unknown;
	elasticsearchDataMajor?: unknown;
};

/** Values the add-on writes to those fields. */
type AddonSettings = {
	elasticsearchEnabled?: boolean;
	elasticsearchVersion?: EsVersion;
	elasticsearchPort?: number;
	elasticsearchDataMajor?: number | null;
};

declare module '@getflywheel/local' {
	interface Site extends AddonFields {}
	interface SiteJSON extends AddonFields {}
}

export const SUPPORTED_VERSIONS = ['5.2', '7.17.28'] as const;
export type EsVersion = typeof SUPPORTED_VERSIONS[number];
export const DEFAULT_VERSION: EsVersion = '7.17.28';

export function isSupportedVersion(version: unknown): version is EsVersion {
	return typeof version === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

export function majorOf(version: string): number {
	return parseInt(version, 10);
}

function siteData() {
	return getServiceContainer().cradle.siteData;
}

/** The site, or null when Local does not know it. */
export function getSite(siteId: string): Local.Site | null {
	const site: Local.Site | null | undefined = siteData().getSite(siteId);
	return site ?? null;
}

export function getSiteIds(): string[] {
	return Object.keys(siteData().getSites() ?? {});
}

/** Reads an add-on field, or undefined when the site does not exist. */
function readField<K extends keyof AddonFields>(siteId: string, key: K): unknown {
	const site = getSite(siteId);
	return site ? site[key] : undefined;
}

function writeFields(siteId: string, fields: AddonSettings): void {
	siteData().updateSite(siteId, fields);
}

export function isEnabled(siteId: string): boolean {
	return readField(siteId, 'elasticsearchEnabled') === true;
}

export function setEnabled(siteId: string, enabled: boolean): void {
	writeFields(siteId, { elasticsearchEnabled: enabled });
}

export function getVersion(siteId: string): EsVersion {
	const version = readField(siteId, 'elasticsearchVersion');
	return isSupportedVersion(version) ? version : DEFAULT_VERSION;
}

export function setVersion(siteId: string, version: EsVersion): void {
	writeFields(siteId, { elasticsearchVersion: version });
}

export function getPort(siteId: string): number | null {
	const port = readField(siteId, 'elasticsearchPort');
	return typeof port === 'number' ? port : null;
}

export function setPort(siteId: string, port: number): void {
	writeFields(siteId, { elasticsearchPort: port });
}

/**
 * Ports stored by every site except `siteId`. Cloned sites copy the port, so
 * a port is only usable when no other site holds it.
 */
export function getPortsOfOtherSites(siteId: string): Set<number> {
	const ports = new Set<number>();
	for (const id of getSiteIds()) {
		if (id === siteId) continue;
		const port = getPort(id);
		if (port !== null) ports.add(port);
	}
	return ports;
}

/**
 * Major version of the data stored in the site's volume, or null when unknown.
 */
export function getDataMajor(siteId: string): number | null {
	const major = readField(siteId, 'elasticsearchDataMajor');
	return typeof major === 'number' ? major : null;
}

export function setDataMajor(siteId: string, major: number | null): void {
	writeFields(siteId, { elasticsearchDataMajor: major });
}
