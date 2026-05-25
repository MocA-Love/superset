import { CLIError } from "@superset/cli-framework";
import { getHostId } from "@superset/shared/host-info";

export interface HostFlags {
	host: string | undefined;
	local: boolean | undefined;
}

export function resolveHostFilter(flags: HostFlags): string | undefined {
	if (flags.host && flags.local) {
		throw new CLIError(
			"Pass either --host or --local, not both",
			"Use --local for this machine, --host <id> for a specific host.",
		);
	}
	if (flags.local) return getHostId();
	return flags.host ?? undefined;
}

export function requireHostTarget(flags: HostFlags): string {
	const resolved = resolveHostFilter(flags);
	if (!resolved) {
		throw new CLIError(
			"Target host required",
			"Pass --local for this machine, or --host <id> for a specific host.",
		);
	}
	return resolved;
}
