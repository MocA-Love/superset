import type { ReactNode } from "react";
import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type GitOperationDialogTone =
	| "info"
	| "ok"
	| "warn"
	| "danger"
	| "neutral";

/**
 * Subset of shadcn Button variants available to GitOperationDialog actions.
 * Deliberately narrow to keep the dialog surface monochrome — no amber/emerald
 * /sky custom colors. Destructive is the only chromatic variant, reserved for
 * truly irreversible actions (force push, force unlock, discard).
 */
export type GitOperationDialogActionVariant =
	| "primary"
	| "outline"
	| "ghost"
	| "destructive";

export interface GitOperationDialogAction {
	label: string;
	onClick: () => void | Promise<void>;
	variant?: GitOperationDialogActionVariant;
	disabled?: boolean;
}

export interface GitOperationDialogSpec {
	/** Identifier for telemetry and tests (e.g. "push-rejected"). */
	kind: string;
	tone?: GitOperationDialogTone;
	icon?: ReactNode;
	title: string;
	description?: string;
	/** Raw stderr or additional machine-readable details shown in a scrollable block. */
	details?: string;
	/** Arbitrary rich content rendered between description and buttons (checklists, inputs, file lists). */
	extraContent?: ReactNode;
	primaryAction?: GitOperationDialogAction;
	secondaryAction?: GitOperationDialogAction;
	tertiaryAction?: GitOperationDialogAction;
	/** Label of the dismiss/cancel button. Defaults to "閉じる". */
	dismissLabel?: string;
	/** If true, dismiss button is not shown. */
	hideDismiss?: boolean;
}

interface GitOperationDialogState {
	spec: GitOperationDialogSpec | null;
	/**
	 * Monotonic token identifying the currently-rendered dialog. Incremented on
	 * every `open()` so that a late-running action's `finally` can only clear
	 * the dialog it originally opened (not a subsequent one the user opened in
	 * the meantime).
	 */
	dialogId: number;
	isPending: boolean;
	/** @returns the id of the dialog that was just opened. */
	open: (spec: GitOperationDialogSpec) => number;
	/** If `id` is given, only updates when it matches the current dialogId. */
	setPending: (pending: boolean, id?: number) => void;
	/** If `id` is given, only closes when it matches the current dialogId. */
	close: (id?: number) => void;
}

export const useGitOperationDialogStore = create<GitOperationDialogState>()(
	devtools(
		(set) => ({
			spec: null,
			dialogId: 0,
			isPending: false,
			open: (spec) => {
				let nextId = 0;
				set((state) => {
					nextId = state.dialogId + 1;
					return { spec, dialogId: nextId, isPending: false };
				});
				return nextId;
			},
			setPending: (isPending, id) =>
				set((state) =>
					id === undefined || id === state.dialogId ? { isPending } : state,
				),
			close: (id) =>
				set((state) =>
					id === undefined || id === state.dialogId
						? { spec: null, isPending: false }
						: state,
				),
		}),
		{ name: "GitOperationDialogStore" },
	),
);

/** Convenience helper for call sites. Returns the opened dialog id. */
export function openGitOperationDialog(spec: GitOperationDialogSpec): number {
	return useGitOperationDialogStore.getState().open(spec);
}

export function closeGitOperationDialog(id?: number): void {
	useGitOperationDialogStore.getState().close(id);
}
