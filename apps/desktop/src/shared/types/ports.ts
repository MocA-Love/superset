export type { DetectedPort } from "@superset/port-scanner";

export interface StaticPort {
	port: number;
	label: string;
	workspaceId: string;
}

export interface StaticPortsResult {
	exists: boolean;
	ports: Omit<StaticPort, "workspaceId">[] | null;
	error: string | null;
}

export interface EnrichedPort {
	port: number;
	workspaceId: string;
	label: string | null;
	/** Whether this port is currently detected as listening. */
	detected: boolean;
	/** Detection info — only present when `detected` is true. */
	pid: number | null;
	processName: string | null;
	terminalId: string | null;
	detectedAt: number | null;
	address: string | null;
	/**
	 * null → port belongs to the local Electron port manager.
	 * string → URL of the remote host-service that owns this port; kill routes there.
	 */
	hostUrl: string | null;
}
