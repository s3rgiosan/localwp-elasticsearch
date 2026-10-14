/** Outcome of an action requested over IPC. */
export type Result = { ok: boolean; error?: string };

/** Panel state returned by the `elasticsearch:status` IPC channel. */
export type Status = {
	dockerAvailable: boolean;
	/** The `docker` CLI could not be found on this machine. */
	dockerMissing: boolean;
	dockerError: string | null;
	siteRunning: boolean;
	containerRunning: boolean;
	containerExists: boolean;
	ready: boolean;
	runningCount: number;
	warningThreshold: number;
	ramPerInstanceMb: number;
	version: string;
	deployedVersion: string | null;
	hostUri: string | null;
	supportedVersions: readonly string[];
	defaultVersion: string;
	epCurrent: string | null;
	epForeign: string | null;
	lastError: string | null;
	majorChangePending: boolean;
};
