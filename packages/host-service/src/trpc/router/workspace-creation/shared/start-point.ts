import {
	asLocalRef,
	asRemoteRef,
	type ResolvedRef,
} from "../../../../runtime/git/refs";

/**
 * Build a `ResolvedRef` directly from the picker-supplied hint without
 * probing git. Used when the caller already knows whether the row was
 * local or remote-only — the picker has this info per row.
 *
 * FORK NOTE: `baseBranchSource` captures the picker's intent so the
 * server doesn't re-probe — avoids stale cached remote refs winning.
 */
export function buildStartPointFromHint(
	branch: string,
	source: "local" | "remote-tracking",
): ResolvedRef {
	if (source === "local") {
		return {
			kind: "local",
			fullRef: asLocalRef(branch),
			shortName: branch,
		};
	}
	const remote = "origin";
	return {
		kind: "remote-tracking",
		fullRef: asRemoteRef(remote, branch),
		shortName: branch,
		remote,
		remoteShortName: `${remote}/${branch}`,
	};
}
