export const RESOURCE_MONITOR_REFETCH_INTERVAL_MS = 2_000;

export function shouldQueryResourceMonitor({
	enabled,
	open,
}: {
	enabled: boolean;
	open: boolean;
}) {
	return enabled && open;
}

export function getResourceMonitorRefetchInterval(open: boolean) {
	return open ? RESOURCE_MONITOR_REFETCH_INTERVAL_MS : false;
}
