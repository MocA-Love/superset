/**
 * Map GitOperationWarning values from backend responses (push/sync) to
 * user-visible auto-repair notifications in the unified GitOperationDialog.
 */

import {
	type GitOperationDialogSpec,
	openGitOperationDialog,
} from "renderer/stores/git-operation-dialog";

export type GitOperationWarning =
	| { kind: "auto-published-upstream"; branch: string }
	| { kind: "post-push-fetch-failed"; message: string }
	| { kind: "push-retargeted"; remote: string; targetBranch: string }
	| { kind: "post-checkout-hook-failed"; message: string };

export interface GitWarningHandlers {
	/** Only for post-push-fetch-failed: retry the follow-up fetch. */
	fetchOnlyRetry?: () => void;
	/** For auto-published-upstream: open PR create / remote page. */
	createPullRequest?: () => void;
	/** For push-retargeted: jump to the existing PR. */
	openPullRequestUrl?: () => void;
}

function buildWarningSpec(
	warning: GitOperationWarning,
	handlers: GitWarningHandlers,
): GitOperationDialogSpec | null {
	switch (warning.kind) {
		case "post-push-fetch-failed":
			return {
				kind: "push-partial-success",
				tone: "info",
				title: "push は成功しましたが最新情報の取得に失敗しました",
				description:
					"リモートへの反映は完了しています。ローカル表示を更新するための fetch だけが失敗しました。",
				details: warning.message,
				primaryAction: handlers.fetchOnlyRetry
					? {
							label: "fetch だけ再試行",
							variant: "primary",
							onClick: handlers.fetchOnlyRetry,
						}
					: undefined,
			};
		case "auto-published-upstream":
			return {
				kind: "sync-auto-published-upstream",
				tone: "info",
				title: "upstream が無かったため自動で publish しました",
				description: `このブランチ (${warning.branch}) をリモートに publish し、追跡設定を作成しました。`,
				primaryAction: handlers.createPullRequest
					? {
							label: "PR を作る",
							variant: "primary",
							onClick: handlers.createPullRequest,
						}
					: undefined,
			};
		case "push-retargeted":
			return {
				kind: "push-retargeted-existing-pr-head",
				tone: "info",
				title: "push 先を既存 PR の head ブランチに切り替えました",
				description: `tracking と既存 PR の head がズレていたので、${warning.remote}/${warning.targetBranch} に push しました。`,
				primaryAction: handlers.openPullRequestUrl
					? {
							label: "PR を開く",
							variant: "primary",
							onClick: handlers.openPullRequestUrl,
						}
					: undefined,
			};
		case "post-checkout-hook-failed":
			return {
				kind: "post-checkout-hook-failed-nonfatal",
				tone: "warn",
				title:
					"ブランチは切り替わりましたが post-checkout フックが失敗しました",
				description:
					"切替自体は成功していますが、husky などの post-checkout フックが非 0 で終わっています。依存インストールや build script が走っていない可能性があります。",
				details: warning.message,
			};
		default:
			return null;
	}
}

/**
 * Show the first actionable warning from a response. Returns true if a dialog
 * was opened. If multiple warnings arrive together, surface the most important
 * one (post-push-fetch-failed > push-retargeted > auto-published-upstream).
 */
export function showGitWarningDialog(
	warnings: readonly GitOperationWarning[] | undefined,
	handlers: GitWarningHandlers = {},
): boolean {
	if (!warnings || warnings.length === 0) return false;
	const priority: GitOperationWarning["kind"][] = [
		"post-push-fetch-failed",
		"push-retargeted",
		"post-checkout-hook-failed",
		"auto-published-upstream",
	];
	for (const kind of priority) {
		const match = warnings.find((w) => w.kind === kind);
		if (match) {
			const spec = buildWarningSpec(match, handlers);
			if (spec) {
				openGitOperationDialog(spec);
				return true;
			}
		}
	}
	return false;
}
