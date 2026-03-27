import { Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { WorkspacePage } from "renderer/routes/_authenticated/_dashboard/workspace/$workspaceId/page";

/**
 * Replaces a plain <Outlet /> for workspace routes, keeping previously visited
 * workspace pages mounted (but hidden) so that Electron <webview> elements
 * inside BrowserPanes are never removed from the DOM.
 *
 * For non-workspace routes (settings, welcome, etc.) it renders the normal
 * <Outlet />.
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

	useEffect(() => {
		if (activeWorkspaceId && !visitedSetRef.current.has(activeWorkspaceId)) {
			visitedSetRef.current.add(activeWorkspaceId);
			setVisitedIds(Array.from(visitedSetRef.current));
		}
	}, [activeWorkspaceId]);

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
