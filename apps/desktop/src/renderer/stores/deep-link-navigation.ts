import { create } from "zustand";

const WORKSPACE_NAVIGATION_INTENT_TTL_MS = 30_000;

export type WorkspaceNavigationIntentSource =
	| "deep-link"
	| "notification"
	| "route-search";

export interface WorkspaceNavigationIntentInput {
	workspaceId: string;
	tabId?: string;
	paneId?: string;
	file?: string;
	line?: number;
	column?: number;
	source: WorkspaceNavigationIntentSource;
}

export interface WorkspaceNavigationIntent
	extends WorkspaceNavigationIntentInput {
	id: string;
	createdAt: number;
	expiresAt: number;
	tabHandled: boolean;
	fileHandled: boolean;
}

interface DeepLinkNavigationState {
	pendingWorkspaceIntent: WorkspaceNavigationIntent | null;
	replacePendingWorkspaceIntent: (
		intent: WorkspaceNavigationIntentInput,
	) => void;
	markPendingWorkspaceIntentTabHandled: (intentId: string) => void;
	markPendingWorkspaceIntentFileHandled: (intentId: string) => void;
	clearPendingWorkspaceIntent: (intentId?: string) => void;
	prunePendingWorkspaceIntent: () => void;
}

const createWorkspaceNavigationIntent = (
	intent: WorkspaceNavigationIntentInput,
): WorkspaceNavigationIntent | null => {
	const now = Date.now();
	const tabId = intent.tabId?.trim() || undefined;
	const file = intent.file?.trim() || undefined;
	const paneId = tabId ? intent.paneId?.trim() || undefined : undefined;
	const line = file ? intent.line : undefined;
	const column = file ? intent.column : undefined;

	if (!tabId && !file) {
		return null;
	}

	return {
		...intent,
		tabId,
		paneId,
		file,
		line,
		column,
		id: `${now}:${Math.random().toString(36).slice(2, 10)}`,
		createdAt: now,
		expiresAt: now + WORKSPACE_NAVIGATION_INTENT_TTL_MS,
		tabHandled: !tabId,
		fileHandled: !file,
	};
};

const isWorkspaceNavigationIntentComplete = (
	intent: WorkspaceNavigationIntent,
): boolean => intent.tabHandled && intent.fileHandled;

const isWorkspaceNavigationIntentExpired = (
	intent: WorkspaceNavigationIntent,
): boolean => intent.expiresAt <= Date.now();

export const useDeepLinkNavigationStore = create<DeepLinkNavigationState>(
	(set) => ({
		pendingWorkspaceIntent: null,
		replacePendingWorkspaceIntent: (intent) => {
			const nextIntent = createWorkspaceNavigationIntent(intent);
			set({
				pendingWorkspaceIntent: nextIntent,
			});
		},
		markPendingWorkspaceIntentTabHandled: (intentId) =>
			set((state) => {
				const pendingWorkspaceIntent = state.pendingWorkspaceIntent;
				if (!pendingWorkspaceIntent || pendingWorkspaceIntent.id !== intentId) {
					return state;
				}

				const nextIntent = {
					...pendingWorkspaceIntent,
					tabHandled: true,
				};

				return {
					pendingWorkspaceIntent: isWorkspaceNavigationIntentComplete(
						nextIntent,
					)
						? null
						: nextIntent,
				};
			}),
		markPendingWorkspaceIntentFileHandled: (intentId) =>
			set((state) => {
				const pendingWorkspaceIntent = state.pendingWorkspaceIntent;
				if (!pendingWorkspaceIntent || pendingWorkspaceIntent.id !== intentId) {
					return state;
				}

				const nextIntent = {
					...pendingWorkspaceIntent,
					fileHandled: true,
				};

				return {
					pendingWorkspaceIntent: isWorkspaceNavigationIntentComplete(
						nextIntent,
					)
						? null
						: nextIntent,
				};
			}),
		clearPendingWorkspaceIntent: (intentId) =>
			set((state) => {
				if (!intentId) {
					return { pendingWorkspaceIntent: null };
				}

				if (state.pendingWorkspaceIntent?.id !== intentId) {
					return state;
				}

				return { pendingWorkspaceIntent: null };
			}),
		prunePendingWorkspaceIntent: () =>
			set((state) => {
				const pendingWorkspaceIntent = state.pendingWorkspaceIntent;
				if (
					!pendingWorkspaceIntent ||
					!isWorkspaceNavigationIntentExpired(pendingWorkspaceIntent)
				) {
					return state;
				}

				return { pendingWorkspaceIntent: null };
			}),
	}),
);
