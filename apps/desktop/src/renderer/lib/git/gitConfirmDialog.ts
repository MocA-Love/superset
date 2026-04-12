/**
 * Helper for building confirmation dialogs on top of GitOperationDialog.
 * Use for user-decision flows like merge-pr / bulk-stage / workflow-dispatch
 * — anywhere you want to pause a destructive or irreversible action behind a
 * consistent modal instead of a toast or native confirm.
 */

import type { ReactNode } from "react";
import {
	type GitOperationDialogActionVariant,
	type GitOperationDialogTone,
	openGitOperationDialog,
} from "renderer/stores/git-operation-dialog";

export interface GitConfirmDialogOptions {
	kind: string;
	tone?: GitOperationDialogTone;
	title: string;
	description?: string;
	details?: string;
	extraContent?: ReactNode;
	confirmLabel: string;
	confirmVariant?: GitOperationDialogActionVariant;
	onConfirm: () => void | Promise<void>;
	secondaryLabel?: string;
	onSecondary?: () => void | Promise<void>;
	dismissLabel?: string;
}

export function showGitConfirmDialog(options: GitConfirmDialogOptions): void {
	openGitOperationDialog({
		kind: options.kind,
		tone: options.tone ?? "warn",
		title: options.title,
		description: options.description,
		details: options.details,
		extraContent: options.extraContent,
		dismissLabel: options.dismissLabel ?? "キャンセル",
		primaryAction: {
			label: options.confirmLabel,
			variant: options.confirmVariant ?? "primary",
			onClick: options.onConfirm,
		},
		secondaryAction: options.onSecondary
			? {
					label: options.secondaryLabel ?? "その他の操作",
					variant: "outline",
					onClick: options.onSecondary,
				}
			: undefined,
	});
}
