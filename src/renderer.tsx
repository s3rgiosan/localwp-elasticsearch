import * as React from 'react';
// Provided by Local at runtime (not bundled).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TableListRow, Switch, FlySelect, TextButton } = require('@getflywheel/local-components') as {
	TableListRow: React.ComponentType<{
		label: string;
		children?: React.ReactNode;
		key?: string;
		alignMiddle?: boolean;
	}>;
	Switch: React.ComponentType<{
		checked?: boolean;
		disabled?: boolean;
		tiny?: boolean;
		flat?: boolean;
		name?: string;
		onChange?: (name: string, checked: boolean) => void;
	}>;
	FlySelect: React.ComponentType<{
		value: string;
		options: Record<string, string>;
		disabled?: boolean;
		onChange?: (value: string) => void;
	}>;
	TextButton: React.ComponentType<{
		onClick?: (e: React.MouseEvent) => void;
		disabled?: boolean;
		children?: React.ReactNode;
		style?: React.CSSProperties;
	}>;
};

const { useCallback, useEffect, useState } = React;

type Status = {
	dockerAvailable: boolean;
	containerRunning: boolean;
	containerExists: boolean;
	runningCount: number;
	warningThreshold: number;
	version: string;
	deployedVersion: string | null;
	hostUri: string | null;
	ready: boolean;
	supportedVersions: readonly string[];
	defaultVersion: string;
	epCurrent: string | null;
};

const DEFAULT_STATUS: Status = {
	dockerAvailable: true,
	containerRunning: false,
	containerExists: false,
	runningCount: 0,
	warningThreshold: 2,
	version: '',
	deployedVersion: null,
	hostUri: null,
	ready: false,
	supportedVersions: [],
	defaultVersion: '',
	epCurrent: null,
};

function majorOf(v: string): number {
	return parseInt(v, 10);
}

type SiteProps = { id: string; name: string; [key: string]: any };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#5d5e5e' }}>
			<div style={{ fontWeight: 500, fontSize: 14, lineHeight: '30px', alignSelf: 'flex-start' }}>{label}:</div>
			<div style={{ fontSize: 14 }}>{children}</div>
		</div>
	);
}

function ElasticsearchPanel({ site, electron }: { site: SiteProps; electron: any }) {
	const ipc = electron.ipcRenderer;
	const [enabled, setEnabled] = useState(false);
	const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const [e, s] = await Promise.all([
			ipc.invoke('elasticsearch:isEnabled', site.id) as Promise<boolean>,
			ipc.invoke('elasticsearch:status', site.id) as Promise<Status>,
		]);
		setEnabled(e);
		setStatus(s);
	}, [site.id, ipc]);

	useEffect(() => {
		refresh();
	}, [refresh, site.status]);

	useEffect(() => {
		const siteHalted = site.status === 'halted' || site.status === 'stopped';
		if (!enabled || siteHalted || status.ready) return;
		const id = setInterval(refresh, 2000);
		return () => clearInterval(id);
	}, [enabled, site.status, status.ready, refresh]);

	const onToggle = async (_name: string, next: boolean) => {
		setBusy(true);
		try {
			await ipc.invoke('elasticsearch:setEnabled', site.id, next);
			setEnabled(next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const onEpToggle = async (_name: string, next: boolean) => {
		setBusy(true);
		try {
			await ipc.invoke('elasticsearch:setEpEnabled', site.id, next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const onVersionChange = async (next: string) => {
		setBusy(true);
		try {
			await ipc.invoke('elasticsearch:setVersion', site.id, next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const versionOptions = React.useMemo(() => {
		const out: Record<string, string> = {};
		for (const v of status.supportedVersions) {
			out[v] = v === status.defaultVersion ? `${v} (default)` : v;
		}
		return out;
	}, [status.supportedVersions, status.defaultVersion]);

	const overThreshold = status.runningCount > status.warningThreshold;
	const versionChangePending =
		!!status.deployedVersion && status.deployedVersion !== status.version;
	const majorMismatch =
		!!status.deployedVersion &&
		majorOf(status.deployedVersion) !== majorOf(status.version);

	const siteHalted = site.status === 'halted' || site.status === 'stopped';
	const siteRunning = site.status === 'running';
	const stateLabel = !status.dockerAvailable
		? 'Docker not running'
		: !enabled
			? 'Disabled'
			: siteHalted || !status.containerRunning
				? 'Stopped'
				: !status.ready
					? 'Starting…'
					: 'Running';

	return (
		<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 14 }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<Switch tiny flat checked={enabled} disabled={busy} onChange={onToggle} />
				{enabled && status.dockerAvailable && !majorMismatch && !status.deployedVersion && (
					<span style={{ color: '#5d5e5e', fontSize: 14 }}>
						{siteRunning ? 'Restart site to create the container' : 'Start site to create the container'}
					</span>
				)}
			</div>
			<Field label="State">{stateLabel}</Field>
			<Field label="Host">
				{enabled && status.ready && status.hostUri ? (
					<span style={{ userSelect: 'text', cursor: 'text' }}>{status.hostUri}</span>
				) : (
					<span style={{ color: '#5d5e5e' }}>—</span>
				)}
			</Field>
			<Field label="Version">
				<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<FlySelect
							value={status.version || status.defaultVersion}
							options={versionOptions}
							disabled={!enabled || busy || !status.supportedVersions.length}
							onChange={onVersionChange}
						/>
						{enabled && status.dockerAvailable && !majorMismatch && versionChangePending && (
							<span style={{ color: '#5d5e5e', fontSize: 14 }}>Restart site to apply</span>
						)}
					</div>
					{majorMismatch && (
						<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, maxWidth: 640 }}>
							<div style={{ fontSize: 14, color: '#5d5e5e', lineHeight: 1.5 }}>
								Major version change detected. The existing Elasticsearch container and its
								data volume need to be recreated — indices built for the previous major version
								are not compatible with the new one. Clicking "Confirm" will remove the current
								container and its data. You'll then need to stop and start the site for the new
								Elasticsearch instance to come up, and run an ElasticPress index sync to
								repopulate your data.
							</div>
							<TextButton
								disabled={busy}
								style={{ alignSelf: 'flex-start', padding: 0 }}
								onClick={async () => {
									if (busy) return;
									if (!window.confirm('Delete the current Elasticsearch container and data volume?')) return;
									setBusy(true);
									try {
										await ipc.invoke('elasticsearch:recreateVolume', site.id);
										await refresh();
									} finally {
										setBusy(false);
									}
								}}
							>
								Confirm
							</TextButton>
						</div>
					)}
				</div>
			</Field>
			{overThreshold && (
				<span style={{ color: '#f5c16c', fontSize: 14 }}>
					{status.runningCount} ES instances running (~{status.runningCount * 512}MB RAM)
				</span>
			)}
			<Field label="ElasticPress">
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<Switch
						tiny
						flat
						checked={!!status.epCurrent}
						disabled={!enabled || busy || !status.ready}
						onChange={onEpToggle}
					/>
					{status.epCurrent && status.hostUri && status.epCurrent !== status.hostUri && (
						<span style={{ color: '#f5c16c', fontSize: 14 }}>
							EP_HOST in wp-config.php ({status.epCurrent}) doesn't match ({status.hostUri})
						</span>
					)}
				</div>
			</Field>
		</div>
	);
}

export default function (context: any): void {
	const { hooks, electron } = context;
	if (!hooks?.addContent) return;
	hooks.addContent('siteInfoUtilities', (site: SiteProps) => (
		<TableListRow alignMiddle key="elasticsearch" label="Elasticsearch">
			<ElasticsearchPanel site={site} electron={electron} />
		</TableListRow>
	));
}
