import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type GitHubStatusQuerySurface,
	getGitHubStatusQueryPolicy,
} from "./githubQueryPolicy";

interface UseHoverGitHubStatusOptions {
	workspaceId: string | null | undefined;
	surface: GitHubStatusQuerySurface;
	isWorktree: boolean;
}

export function useHoverGitHubStatus({
	workspaceId,
	surface,
	isWorktree,
}: UseHoverGitHubStatusOptions) {
	const [hasHovered, setHasHovered] = useState(false);

	const queryPolicy = getGitHubStatusQueryPolicy(surface, {
		hasWorkspaceId: !!workspaceId,
		isActive: hasHovered && isWorktree,
	});

	const {
		data: githubStatus,
		dataUpdatedAt,
		isStale,
		refetch,
	} = electronTrpc.workspaces.getGitHubStatus.useQuery(
		{ workspaceId: workspaceId ?? "" },
		queryPolicy,
	);

	const pendingRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (pendingRefetchRef.current) clearTimeout(pendingRefetchRef.current);
		},
		[],
	);

	const onMouseEnter = () => {
		if (!hasHovered) {
			setHasHovered(true);
			return;
		}

		if (isStale) {
			if (pendingRefetchRef.current) {
				clearTimeout(pendingRefetchRef.current);
				pendingRefetchRef.current = null;
			}
			void refetch();
			return;
		}

		if (!pendingRefetchRef.current) {
			const msUntilStale = queryPolicy.staleTime - (Date.now() - dataUpdatedAt);
			pendingRefetchRef.current = setTimeout(
				() => {
					pendingRefetchRef.current = null;
					void refetch();
				},
				Math.max(0, msUntilStale),
			);
		}
	};

	return { githubStatus, hasHovered, onMouseEnter };
}
