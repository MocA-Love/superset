import { buildHostRoutingKey } from "@superset/shared/host-routing";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { env } from "renderer/env.renderer";
import {
	getHostServiceHeaders,
	getHostServiceWsToken,
} from "renderer/lib/host-service-auth";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useWorkspaceCreatesStore } from "renderer/stores/workspace-creates";
import { WorkspaceHostIncompatibleState } from "./components/WorkspaceHostIncompatibleState";
import { WorkspaceHostOfflineState } from "./components/WorkspaceHostOfflineState";
import { useRemoteHostStatus } from "./hooks/useRemoteHostStatus";
import { WorkspaceTrpcProvider } from "./providers/WorkspaceTrpcProvider";

export const Route = createFileRoute("/_authenticated/_dashboard/v2-workspace")(
	{
		component: V2WorkspaceLayout,
	},
);

function V2WorkspaceLayout() {
	const matchRoute = useMatchRoute();
	const workspaceMatch = matchRoute({
		to: "/v2-workspace/$workspaceId",
	});
	const workspaceId =
		workspaceMatch !== false ? workspaceMatch.workspaceId : null;
	const collections = useCollections();
	const { machineId, activeHostUrl } = useLocalHostService();
	const { ensureWorkspaceInSidebar } = useDashboardSidebarState();

	const { data: workspaces = [], isReady } = useLiveQuery(
		(q) =>
			q
				.from({ v2Workspaces: collections.v2Workspaces })
				.where(({ v2Workspaces }) => eq(v2Workspaces.id, workspaceId ?? ""))
				.select(({ v2Workspaces }) => ({
					id: v2Workspaces.id,
					organizationId: v2Workspaces.organizationId,
					hostId: v2Workspaces.hostId,
					projectId: v2Workspaces.projectId,
					branch: v2Workspaces.branch,
				})),
		[collections, workspaceId],
	);
	const syncedWorkspace = workspaces?.[0] ?? null;
	const inFlight = useWorkspaceCreatesStore((store) =>
		workspaceId
			? store.entries.find((entry) => entry.snapshot.id === workspaceId)
			: undefined,
	);
	// Fall back to the cloud row cached on the in-flight entry while
	// Electric hasn't yet delivered the synced row. The cloud has already
	// confirmed the workspace at this point — no need to block on sync.
	const workspace = syncedWorkspace ?? inFlight?.cloudRow ?? null;

	const isLocal = workspace?.hostId === machineId;
	const hostUrl = !workspace
		? null
		: isLocal
			? activeHostUrl
			: `${env.RELAY_URL}/hosts/${buildHostRoutingKey(workspace.organizationId, workspace.hostId)}`;

	const lastEnsuredWorkspaceIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!workspace || lastEnsuredWorkspaceIdRef.current === workspace.id)
			return;
		lastEnsuredWorkspaceIdRef.current = workspace.id;
		ensureWorkspaceInSidebar(workspace.id, workspace.projectId);
	}, [ensureWorkspaceInSidebar, workspace]);

	const hostStatus = useRemoteHostStatus(workspace);

	if (!workspaceId || !isReady) {
		return null;
	}

	if (!workspace || !hostUrl) {
		return <Outlet />;
	}

	if (hostStatus.status === "offline") {
		return <WorkspaceHostOfflineState hostName={hostStatus.hostName} />;
	}
	if (hostStatus.status === "incompatible") {
		return (
			<WorkspaceHostIncompatibleState
				hostName={hostStatus.hostName}
				hostVersion={hostStatus.hostVersion}
				minVersion={hostStatus.minVersion}
			/>
		);
	}
	if (hostStatus.status === "loading") {
		return <div className="flex h-full w-full" />;
	}

	return (
		<WorkspaceTrpcProvider
			cacheKey={workspace.id}
			key={`${workspace.id}:${hostUrl}`}
			hostUrl={hostUrl}
			headers={() => getHostServiceHeaders(hostUrl)}
			wsToken={() => getHostServiceWsToken(hostUrl)}
		>
			<Outlet />
		</WorkspaceTrpcProvider>
	);
}
