import { Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { WorkspacePage } from "renderer/routes/_authenticated/_dashboard/workspace/$workspaceId/page";

/**
 * Replaces a plain <Outlet /> for workspace routes, keeping previously visited
 * workspace pages mounted (but hidden) so that Electron <webview> elements
 * inside BrowserPanes are never removed from the DOM.
 *
 * For non-workspace routes (settings, welcome, etc.) it renders the normal
 * <Outlet />.
 *
 * Automatically evicts deleted workspaces from the keep-alive list by comparing
 * visited IDs against the current workspace list from the database.
 */
export function KeepAliveWorkspaces() {
	const matchRoute = useMatchRoute();
	const workspaceMatch = matchRoute({
		to: "/workspace/$workspaceId",
		fuzzy: true,
	});
	const activeWorkspaceId =
		workspaceMatch !== false ? workspaceMatch.workspaceId : null;

	// Track every workspace that has been visited so we can keep them alive.
	const [visitedIds, setVisitedIds] = useState<string[]>([]);
	const visitedSetRef = useRef(new Set<string>());

	// Notify SyncService which workspace is active so only it gets polled.
	// Passing workspaceId=null deactivates all polling (e.g., dashboard view).
	const { mutate: setActiveSyncWorkspace } =
		electronTrpc.workspaces.setActiveSyncWorkspace.useMutation();
	const prevActiveIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (activeWorkspaceId && !visitedSetRef.current.has(activeWorkspaceId)) {
			visitedSetRef.current.add(activeWorkspaceId);
			setVisitedIds(Array.from(visitedSetRef.current));
		}

		// Tell the backend which workspace to poll (or null to stop all)
		if (activeWorkspaceId !== prevActiveIdRef.current) {
			prevActiveIdRef.current = activeWorkspaceId;
			setActiveSyncWorkspace({
				workspaceId: activeWorkspaceId ?? "",
			});
		}
	}, [activeWorkspaceId, setActiveSyncWorkspace]);

	// Evict deleted workspaces: compare visited IDs against the live list.
	const { data: workspaceGroups } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	const existingWorkspaceIds = useMemo(() => {
		if (!workspaceGroups) return null;
		const ids = new Set<string>();
		for (const group of workspaceGroups) {
			for (const ws of group.workspaces) {
				ids.add(ws.id);
			}
		}
		return ids;
	}, [workspaceGroups]);

	useEffect(() => {
		if (!existingWorkspaceIds) return;
		let changed = false;
		for (const id of visitedSetRef.current) {
			if (!existingWorkspaceIds.has(id)) {
				visitedSetRef.current.delete(id);
				changed = true;
			}
		}
		if (changed) {
			setVisitedIds(Array.from(visitedSetRef.current));
		}
	}, [existingWorkspaceIds]);

	// Non-workspace route — fall through to the normal Outlet.
	if (!activeWorkspaceId) {
		return <Outlet />;
	}

	return (
		<>
			{visitedIds.map((id) => {
				const isActive = id === activeWorkspaceId;
				return (
					<div
						key={id}
						className="flex flex-1 min-h-0 min-w-0"
						style={
							isActive
								? undefined
								: {
										position: "fixed",
										left: -9999,
										top: -9999,
										width: "100vw",
										height: "100vh",
										pointerEvents: "none",
									}
						}
					>
						<WorkspacePage workspaceIdOverride={id} isActive={isActive} />
					</div>
				);
			})}
		</>
	);
}
