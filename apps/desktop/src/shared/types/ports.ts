export interface DetectedPort {
	port: number;
	pid: number;
	processName: string;
	paneId: string;
	workspaceId: string;
	detectedAt: number;
	address: string;
}

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
	paneId: string | null;
	detectedAt: number | null;
	address: string | null;
}
