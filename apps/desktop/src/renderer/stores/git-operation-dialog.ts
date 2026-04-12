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
	isPending: boolean;
	open: (spec: GitOperationDialogSpec) => void;
	setPending: (pending: boolean) => void;
	close: () => void;
}

export const useGitOperationDialogStore = create<GitOperationDialogState>()(
	devtools(
		(set) => ({
			spec: null,
			isPending: false,
			open: (spec) => set({ spec, isPending: false }),
			setPending: (isPending) => set({ isPending }),
			close: () => set({ spec: null, isPending: false }),
		}),
		{ name: "GitOperationDialogStore" },
	),
);

/** Convenience helper for call sites. */
export function openGitOperationDialog(spec: GitOperationDialogSpec): void {
	useGitOperationDialogStore.getState().open(spec);
}

export function closeGitOperationDialog(): void {
	useGitOperationDialogStore.getState().close();
}
