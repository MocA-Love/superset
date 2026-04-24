import { electronTrpc } from "renderer/lib/electron-trpc";
import { ProjectWorktreeAutoSync } from "renderer/routes/_authenticated/_dashboard/project/$projectId/components/ProjectWorktreeAutoSync";
import { ProjectWorktreeAutoImport } from "./ProjectWorktreeAutoImport";

/**
 * Drives auto-import / auto-remove for every tracked project.
 *
 * Mounted once at the _authenticated layout so the sync runs while the user
 * is on any signed-in screen (dashboard, settings, workspace, v2) — not only
 * on the project onboarding page where the controls were originally wired.
 */
export function WorktreeAutoSyncManager() {
	const { data: projects = [] } = electronTrpc.projects.getRecents.useQuery();

	return (
		<>
			{projects.map((project) => (
				<ProjectWorktreeSyncPair key={project.id} projectId={project.id} />
			))}
		</>
	);
}

function ProjectWorktreeSyncPair({ projectId }: { projectId: string }) {
	return (
		<>
			<ProjectWorktreeAutoImport projectId={projectId} />
			<ProjectWorktreeAutoSync projectId={projectId} />
		</>
	);
}
