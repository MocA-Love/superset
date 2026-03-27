import { createContext, useContext } from "react";

/**
 * Provides the workspace ID to all components within a WorkspacePage subtree.
 *
 * When multiple WorkspacePage instances are mounted simultaneously (via
 * KeepAliveWorkspaces), `useParams()` from the router returns the ACTIVE
 * workspace's ID — not the ID of the workspace the component belongs to.
 * This context ensures each component reads its own workspace's ID.
 */
const WorkspaceIdContext = createContext<string | null>(null);

export const WorkspaceIdProvider = WorkspaceIdContext.Provider;

export function useWorkspaceId(): string {
	const id = useContext(WorkspaceIdContext);
	if (!id) {
		throw new Error("useWorkspaceId must be used within a WorkspaceIdProvider");
	}
	return id;
}
