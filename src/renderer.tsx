import * as React from 'react';
import type * as LocalComponents from '@getflywheel/local-components';
import type { Result, Status } from './types';

// Provided by Local at runtime (not bundled); the import above is types only.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Banner, Button, FlyModal, FlySelect, Switch, TableListRow, Text, TextButton } = require(
	'@getflywheel/local-components',
) as typeof LocalComponents;

const { useCallback, useEffect, useMemo, useRef, useState } = React;

const DEFAULT_STATUS: Status = {
	dockerAvailable: true,
	dockerMissing: false,
	dockerError: null,
	siteRunning: false,
	containerRunning: false,
	containerExists: false,
	ready: false,
	runningCount: 0,
	warningThreshold: 2,
	ramPerInstanceMb: 0,
	version: '',
	deployedVersion: null,
	hostUri: null,
	supportedVersions: [],
	defaultVersion: '',
	epCurrent: null,
	epForeign: null,
	lastError: null,
	majorChangePending: false,
};

const POLL_NOT_READY_MS = 2000;
const POLL_READY_MS = 5000;
const POLL_IDLE_MS = 10000;

/** First line of a row's value, as tall as the row label so both share a center line. */
const ROW_LINE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 48 };

const ROW_CLASS = 'LocalElasticsearch__Row';

/**
 * Top-aligns the value cell of each row. TableListRow cells align on the text
 * baseline, which shifts rows whose first line holds a switch or a select.
 */
const ROW_CSS = `.TableListRow.${ROW_CLASS} > div { vertical-align: top; }`;

function addRowStyles(): void {
	if (document.getElementById(ROW_CLASS)) return;
	const style = document.createElement('style');
	style.id = ROW_CLASS;
	style.textContent = ROW_CSS;
	document.head.appendChild(style);
}

/** Banners below a row's first line. */
const ROW_NOTICES: React.CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'flex-start',
	gap: 8,
	paddingBottom: 12,
};

type SiteProps = { id: string; name: string; [key: string]: any };

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** `label` names the Tools tab entry; Local reads it from the element's props. */
function ElasticsearchPanel({ site, electron }: { site: SiteProps; electron: any; label: string }) {
	const ipc = electron.ipcRenderer;
	const [enabled, setEnabled] = useState(false);
	const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [pollError, setPollError] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [switchEpoch, setSwitchEpoch] = useState(0);
	const mountedRef = useRef(true);
	const requestSeqRef = useRef(0);
	const enabledRef = useRef(false);
	const statusRef = useRef<Status>(DEFAULT_STATUS);
	const siteStartingRef = useRef(false);
	const kickRef = useRef<() => void>(() => undefined);
	const lastSiteStatusRef = useRef(site.status);
	const cancelRef = useRef<HTMLDivElement>(null);

	const siteStarting = site.status === 'starting';
	siteStartingRef.current = siteStarting;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Fetches enabled state and status. Only the most recently issued request is applied,
	// and only while this panel is mounted. Returns true when the response was applied.
	const refresh = useCallback(async (): Promise<boolean> => {
		requestSeqRef.current += 1;
		const seq = requestSeqRef.current;
		try {
			const [e, s] = await Promise.all([
				ipc.invoke('elasticsearch:isEnabled', site.id) as Promise<boolean>,
				ipc.invoke('elasticsearch:status', site.id) as Promise<Status>,
			]);
			if (!mountedRef.current || seq !== requestSeqRef.current) return false;
			enabledRef.current = e;
			statusRef.current = s;
			setEnabled(e);
			setStatus(s);
			setLoaded(true);
			setPollError(null);
			return true;
		} catch (err) {
			if (mountedRef.current && seq === requestSeqRef.current) setPollError(errorMessage(err));
			return false;
		}
	}, [site.id, ipc]);

	// Self-scheduling poll: the next request starts only after the previous one settles.
	// Started on mount and on site change; the cadence follows the latest status.
	useEffect(() => {
		let cancelled = false;
		let inFlight = false;
		let rerun = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const delay = (): number => {
			const s = statusRef.current;
			const active = enabledRef.current && s.dockerAvailable && (s.siteRunning || siteStartingRef.current);
			if (!active) return POLL_IDLE_MS;
			return s.ready ? POLL_READY_MS : POLL_NOT_READY_MS;
		};

		const poll = async () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			if (inFlight) {
				rerun = true;
				return;
			}
			inFlight = true;
			await refresh();
			inFlight = false;
			if (cancelled) return;
			if (rerun) {
				rerun = false;
				poll();
				return;
			}
			timer = setTimeout(poll, delay());
		};

		kickRef.current = poll;
		poll();

		return () => {
			cancelled = true;
			kickRef.current = () => undefined;
			if (timer) clearTimeout(timer);
		};
	}, [refresh]);

	// Re-read status right away when Local reports a site status change.
	useEffect(() => {
		if (lastSiteStatusRef.current !== site.status) kickRef.current();
		lastSiteStatusRef.current = site.status;
	}, [site.status]);

	// The dialog only makes sense while a major change is pending.
	useEffect(() => {
		if (!status.majorChangePending) setConfirmOpen(false);
	}, [status.majorChangePending]);

	// Focus Cancel once the dialog content is mounted.
	useEffect(() => {
		if (!confirmOpen) return undefined;
		const id = setTimeout(() => cancelRef.current?.querySelector('button')?.focus(), 0);
		return () => clearTimeout(id);
	}, [confirmOpen]);

	const run = async (action: () => Promise<Result>) => {
		setBusy(true);
		setActionError(null);
		try {
			const result = await action();
			if (mountedRef.current) setActionError(result.ok ? null : result.error || 'The action failed.');
		} catch (err) {
			if (mountedRef.current) setActionError(errorMessage(err));
		} finally {
			await refresh();
			if (mountedRef.current) {
				// Switch keeps its own toggled state; remounting re-syncs it with the real value.
				setSwitchEpoch((n) => n + 1);
				setBusy(false);
			}
		}
	};

	const onToggle = (_name: string, next: boolean) =>
		run(async () => {
			const result = (await ipc.invoke('elasticsearch:setEnabled', site.id, next)) as Result & {
				enabled: boolean;
			};
			if (mountedRef.current) {
				enabledRef.current = result.enabled;
				setEnabled(result.enabled);
			}
			return result;
		});

	const onEpToggle = (_name: string, next: boolean) =>
		run(() => ipc.invoke('elasticsearch:setEpEnabled', site.id, next) as Promise<Result>);

	const onVersionChange = (next: string) =>
		run(() => ipc.invoke('elasticsearch:setVersion', site.id, next) as Promise<Result>);

	const onRecreate = () => {
		setConfirmOpen(false);
		return run(() => ipc.invoke('elasticsearch:recreateVolume', site.id) as Promise<Result>);
	};

	const versionOptions = useMemo(() => {
		const out: Record<string, string> = {};
		for (const v of status.supportedVersions) {
			out[v] = v === status.defaultVersion ? `${v} (default)` : v;
		}
		return out;
	}, [status.supportedVersions, status.defaultVersion]);

	const dockerDown = !status.dockerAvailable;
	const locked = !loaded;
	const overThreshold = status.runningCount > status.warningThreshold;
	const epOn = !!status.epCurrent;
	const epCanTurnOn = enabled && status.ready && !busy;
	const epDisabled = locked || busy || (epOn ? false : !epCanTurnOn);
	const versionDiffers = !!status.deployedVersion && status.deployedVersion !== status.version;
	const showRestartHint =
		enabled &&
		versionDiffers &&
		!status.majorChangePending &&
		status.containerExists &&
		!status.siteRunning;
	const showCreateHint = enabled && !status.containerExists && !status.siteRunning;
	const dockerBanner = status.dockerError || (status.dockerMissing ? 'Docker not found' : 'Docker not running');
	const shownActionError = actionError && actionError !== status.lastError ? actionError : null;

	let stateLabel: string;
	if (!loaded) {
		stateLabel = '…';
	} else if (dockerDown) {
		stateLabel = status.dockerMissing ? 'Docker not found' : 'Docker not running';
	} else if (!enabled) {
		stateLabel = 'Disabled';
	} else if (!status.siteRunning || !status.containerRunning) {
		stateLabel = 'Stopped';
	} else if (!status.ready) {
		stateLabel = 'Starting…';
	} else {
		stateLabel = 'Running';
	}

	return (
		<>
			<TableListRow className={ROW_CLASS} key="elasticsearch" label="Elasticsearch">
				<div style={ROW_LINE}>
					<Switch
						key={`${enabled}-${switchEpoch}`}
						tiny
						flat
						checked={enabled}
						disabled={locked || dockerDown || busy}
						onChange={onToggle}
					/>
					{showCreateHint && <Text size="caption">Container is created on next site start.</Text>}
				</div>
				{(dockerDown || pollError || shownActionError || status.lastError) && (
					<div style={ROW_NOTICES}>
						{dockerDown && <Banner variant="warning">{dockerBanner}</Banner>}
						{pollError && <Banner variant="error">{pollError}</Banner>}
						{shownActionError && <Banner variant="error">{shownActionError}</Banner>}
						{status.lastError && <Banner variant="error">{status.lastError}</Banner>}
					</div>
				)}
			</TableListRow>
			<TableListRow className={ROW_CLASS} key="elasticsearch-state" label="State">
				<div style={ROW_LINE}>
					<Text>{stateLabel}</Text>
				</div>
			</TableListRow>
			<TableListRow className={ROW_CLASS} key="elasticsearch-host" label="Host">
				<div style={ROW_LINE}>
					{enabled && status.ready && status.hostUri ? (
						<Text style={{ userSelect: 'text', cursor: 'text' }}>{status.hostUri}</Text>
					) : (
						<Text>—</Text>
					)}
				</div>
			</TableListRow>
			<TableListRow className={ROW_CLASS} key="elasticsearch-version" label="Version">
				<div style={ROW_LINE}>
					<FlySelect
						value={status.version || status.defaultVersion}
						options={versionOptions}
						disabled={locked || dockerDown || !enabled || busy || !status.supportedVersions.length}
						onChange={onVersionChange}
					/>
					{showRestartHint && <Text size="caption">Applies on next site start</Text>}
				</div>
				{status.majorChangePending && (
					<div style={ROW_NOTICES}>
						<Banner variant="warning">
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
								<Text>
									Changing the major version requires recreating the Elasticsearch container and its
									data volume. Indices built for the previous major version are not compatible. If
									Elasticsearch is enabled and the site is running, the new container starts
									immediately. Otherwise it starts on the next site start. Run an ElasticPress index
									sync afterwards.
								</Text>
								<Button intent="destructive" disabled={locked || busy || dockerDown} onClick={() => setConfirmOpen(true)}>
									Delete data and recreate
								</Button>
							</div>
						</Banner>
					</div>
				)}
			</TableListRow>
			{overThreshold && (
				<TableListRow className={ROW_CLASS} key="elasticsearch-ram" label="Memory">
					<div style={ROW_LINE}>
						<Banner variant="warning">
							{status.runningCount} ES instances running (~{status.runningCount * status.ramPerInstanceMb}MB
							RAM)
						</Banner>
					</div>
				</TableListRow>
			)}
			<TableListRow className={ROW_CLASS} key="elasticsearch-ep" label="ElasticPress">
				<div style={ROW_LINE}>
					<Switch key={`${epOn}-${switchEpoch}`} tiny flat checked={epOn} disabled={epDisabled} onChange={onEpToggle} />
				</div>
				{status.epForeign && (
					<div style={ROW_NOTICES}>
						<Banner variant="warning">
							EP_HOST is also defined in wp-config.php ({status.epForeign}). Turning ElasticPress on
							comments it out; turning it off restores it.
						</Banner>
					</div>
				)}
			</TableListRow>
			<FlyModal
				contentLabel="Delete Elasticsearch data and recreate"
				isOpen={confirmOpen}
				onRequestClose={() => setConfirmOpen(false)}
			>
				<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
					<Text>
						This removes the Elasticsearch container and data volume of {site.name}. This cannot be undone.
					</Text>
					<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
						<Button intent="destructive" disabled={busy} onClick={onRecreate}>
							Delete data and recreate
						</Button>
						<div ref={cancelRef}>
								<TextButton onClick={() => setConfirmOpen(false)}>Cancel</TextButton>
						</div>
					</div>
				</div>
			</FlyModal>
		</>
	);
}

export default function (context: any): void {
	const { hooks, electron } = context;
	if (!hooks?.addContent) return;
	addRowStyles();
	hooks.addContent('siteInfoUtilities', (site: SiteProps) => (
		<ElasticsearchPanel key={site.id} label="Elasticsearch" site={site} electron={electron} />
	));
}
