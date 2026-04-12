/**
 * Convert a classified git error into a GitOperationDialogSpec and open the
 * unified dialog. Call sites only provide the handlers that make sense for
 * their operation — the builder picks which to show per kind.
 */

import {
	type GitOperationDialogSpec,
	openGitOperationDialog,
} from "renderer/stores/git-operation-dialog";
import {
	type ClassifiedGitError,
	classifyGitError,
	type GitErrorKind,
	type GitOperationContext,
} from "./classifyGitError";

export interface GitErrorHandlers {
	/** Retry the exact same mutation that just failed. */
	retry?: () => void;
	/** For push-rejected: pull with rebase then retry the push. */
	pullRebaseAndRetryPush?: () => void;
	/** For push-rejected / force push scenarios. Dangerous — only show when provided. */
	forcePushWithLease?: () => void;
	/** For pull-conflict / stash-pop-conflict: open the first conflict file. */
	openConflictFiles?: (files: string[]) => void;
	/** For pull-conflict: abort the rebase/merge in progress. */
	abortOperation?: () => void;
	/** For pull-overwrite: stash local changes then retry pull. */
	stashAndRetry?: () => void;
	/** For pull-overwrite: discard local changes then retry pull. */
	discardAndRetry?: () => void;
	/** For auth-failed: open GitHub settings / re-login flow. */
	openAuthSettings?: () => void;
	/** For commit-identity-missing: present an inline name/email form. */
	openIdentitySetup?: () => void;
	/** For commit-gpg-failed: commit once without signing. */
	commitWithoutSigning?: () => void;
	/** For commit-hook-failed: bypass hooks and retry. */
	retryWithoutHooks?: () => void;
	/** For commit-hook-failed: copy the stderr to clipboard. */
	copyDetails?: () => void;
	/** For push-partial-success: retry just the post-push fetch. */
	fetchOnlyRetry?: () => void;
	/** For pr-not-mergeable / pr-already-done: open the PR page. */
	openPullRequestUrl?: () => void;
	/** For index-lock: force-remove the stale lock file. */
	forceUnlockIndex?: () => void;
	/** For non-git-repo: open the init git dialog. */
	openInitGitDialog?: () => void;
	/** For detached-head: open create branch dialog. */
	openCreateBranchDialog?: () => void;
	/** For push-protected-branch: open create branch dialog to move commits. */
	createBranchAndMoveCommits?: () => void;
}

interface BuildSpecArgs {
	classified: ClassifiedGitError;
	handlers: GitErrorHandlers;
}

function renderConflictFilesContent(files: string[] | undefined) {
	if (!files || files.length === 0) return undefined;
	return (
		files
			.slice(0, 10)
			.map((f) => `• ${f}`)
			.join("\n") +
		(files.length > 10 ? `\n… ほか ${files.length - 10} 件` : "")
	);
}

function buildSpec({
	classified,
	handlers,
}: BuildSpecArgs): GitOperationDialogSpec {
	const { kind, rawMessage, data } = classified;

	switch (kind) {
		case "push-rejected":
			return {
				kind,
				tone: "warn",
				title: "リモートに新しいコミットがあります",
				description:
					"push できませんでした。リモートにローカルにない変更があります。先にリモートの変更を取り込んでから再 push してください。",
				details: rawMessage,
				primaryAction: handlers.pullRebaseAndRetryPush
					? {
							label: "pull --rebase して再push",
							variant: "ok",
							onClick: handlers.pullRebaseAndRetryPush,
						}
					: undefined,
				secondaryAction: handlers.forcePushWithLease
					? {
							label: "force push (lease)",
							variant: "danger",
							onClick: handlers.forcePushWithLease,
						}
					: undefined,
			};

		case "push-protected-branch":
			return {
				kind,
				tone: "danger",
				title: "このブランチは保護されています",
				description:
					"リモート側の保護ルールで直接 push が禁止されています。新しいブランチを作って Pull Request を出してください。",
				details: rawMessage,
				primaryAction: handlers.createBranchAndMoveCommits
					? {
							label: "新ブランチを作って移す",
							variant: "ok",
							onClick: handlers.createBranchAndMoveCommits,
						}
					: undefined,
			};

		case "push-no-remote-for-pr":
			return {
				kind,
				tone: "warn",
				title: "PR の head リポジトリ用の remote が見つかりません",
				description:
					"この PR は別のリポジトリ (fork) に push する必要がありますが、対応する git remote が登録されていません。",
				details: rawMessage,
				primaryAction: handlers.retry
					? { label: "再試行", variant: "primary", onClick: handlers.retry }
					: undefined,
			};

		case "pull-conflict": {
			const list = renderConflictFilesContent(data.conflictFiles);
			return {
				kind,
				tone: "danger",
				title: "pull 中に競合が発生しました",
				description:
					"rebase を一時停止しています。競合を解決してから続行するか、rebase を中断してください。",
				details: list ?? rawMessage,
				primaryAction:
					handlers.openConflictFiles &&
					data.conflictFiles &&
					data.conflictFiles.length > 0
						? {
								label: "競合ファイルを開く",
								variant: "accent",
								onClick: () =>
									handlers.openConflictFiles?.(data.conflictFiles ?? []),
							}
						: undefined,
				secondaryAction: handlers.abortOperation
					? {
							label: "rebase を中断",
							variant: "warn",
							onClick: handlers.abortOperation,
						}
					: undefined,
			};
		}

		case "pull-overwrite":
			return {
				kind,
				tone: "warn",
				title: "未コミットの変更があるため pull できません",
				description:
					"次のファイルはリモートの更新と重なっており、このまま pull すると失われます。",
				details: renderConflictFilesContent(data.overwriteFiles) ?? rawMessage,
				primaryAction: handlers.stashAndRetry
					? {
							label: "stash してから pull",
							variant: "ok",
							onClick: handlers.stashAndRetry,
						}
					: undefined,
				secondaryAction: handlers.discardAndRetry
					? {
							label: "変更を破棄して pull",
							variant: "danger",
							onClick: handlers.discardAndRetry,
						}
					: undefined,
			};

		case "pull-upstream-missing":
			return {
				kind,
				tone: "warn",
				title: "追跡先のリモートブランチが見つかりません",
				description:
					"upstream が削除されたか、まだ publish されていません。このブランチを再 publish するか、追跡先を付け替えてください。",
				details: rawMessage,
				primaryAction: handlers.retry
					? {
							label: "このブランチを publish",
							variant: "primary",
							onClick: handlers.retry,
						}
					: undefined,
			};

		case "commit-hook-failed":
			return {
				kind,
				tone: "danger",
				title: data.hookName
					? `${data.hookName} フックでコミットが拒否されました`
					: "Git フックでコミットが拒否されました",
				description:
					"フックがエラーを返したため、コミットは作成されていません。内容を確認して修正するか、フックを一時的に無視して commit を進めることができます。",
				details: rawMessage,
				primaryAction: handlers.retry
					? {
							label: "修正して再 commit",
							variant: "primary",
							onClick: handlers.retry,
						}
					: undefined,
				secondaryAction: handlers.retryWithoutHooks
					? {
							label: "フックを無視して commit",
							variant: "warn",
							onClick: handlers.retryWithoutHooks,
						}
					: undefined,
				tertiaryAction: handlers.copyDetails
					? {
							label: "出力をコピー",
							variant: "outline",
							onClick: handlers.copyDetails,
						}
					: undefined,
			};

		case "commit-gpg-failed":
			return {
				kind,
				tone: "warn",
				title: "GPG 署名に失敗しました",
				description:
					"commit.gpgsign が有効ですが、署名キーが見つからない / 期限切れ / passphrase が不一致のためコミットを確定できません。",
				details: rawMessage,
				primaryAction: handlers.commitWithoutSigning
					? {
							label: "署名なしでこの commit を作る",
							variant: "primary",
							onClick: handlers.commitWithoutSigning,
						}
					: undefined,
			};

		case "commit-identity-missing":
			return {
				kind,
				tone: "info",
				title: "コミット作者情報が未設定です",
				description:
					"Git の user.name / user.email が設定されていないためコミットできません。ターミナルで以下を実行してください。",
				details: `git config user.name "Your Name"\ngit config user.email "you@example.com"`,
				primaryAction: handlers.retry
					? {
							label: "設定後に再試行",
							variant: "primary",
							onClick: handlers.retry,
						}
					: undefined,
			};

		case "nothing-to-commit":
			return {
				kind,
				tone: "info",
				title: "コミットする変更がありません",
				description:
					"staged エリアが空です。ファイルを stage してから再度お試しください。",
				primaryAction: handlers.retry
					? {
							label: "最新状態に更新",
							variant: "primary",
							onClick: handlers.retry,
						}
					: undefined,
			};

		case "auth-failed":
			return {
				kind,
				tone: "danger",
				title: "GitHub の認証に失敗しました",
				description:
					"リモート操作が拒否されました。Personal Access Token の期限切れ / 権限不足 / SSH 鍵の不一致が考えられます。",
				details: rawMessage,
				primaryAction: handlers.openAuthSettings
					? {
							label: "認証設定を開く",
							variant: "primary",
							onClick: handlers.openAuthSettings,
						}
					: undefined,
				secondaryAction: handlers.retry
					? { label: "再試行", variant: "outline", onClick: handlers.retry }
					: undefined,
			};

		case "network-error":
			return {
				kind,
				tone: "warn",
				title: "リモートに接続できません",
				description:
					"GitHub に到達できませんでした。ネットワーク / プロキシ / VPN / DNS を確認してください。",
				details: rawMessage,
				primaryAction: handlers.retry
					? {
							label: "もう一度試す",
							variant: "primary",
							onClick: handlers.retry,
						}
					: undefined,
			};

		case "no-remote":
			return {
				kind,
				tone: "info",
				title: "リモートが設定されていません",
				description:
					"このリポジトリには remote が無いため push / pull できません。GitHub に publish するか、remote URL を設定してください。",
				details: rawMessage,
			};

		case "stash-pop-conflict": {
			const list = renderConflictFilesContent(data.conflictFiles);
			return {
				kind,
				tone: "danger",
				title: "stash の適用で競合が発生しました",
				description:
					"stash の内容と現在の作業ツリーが競合しています。stash 自体はまだ残っているので、解決してから drop できます。",
				details: list ?? rawMessage,
				primaryAction:
					handlers.openConflictFiles &&
					data.conflictFiles &&
					data.conflictFiles.length > 0
						? {
								label: "競合ファイルを開く",
								variant: "accent",
								onClick: () =>
									handlers.openConflictFiles?.(data.conflictFiles ?? []),
							}
						: undefined,
			};
		}

		case "nothing-to-stash":
			return {
				kind,
				tone: "info",
				title: "退避する変更がありません",
				description: "作業ツリーはクリーンです。stash する必要はありません。",
			};

		case "pr-not-mergeable":
			return {
				kind,
				tone: "danger",
				title: "この PR はまだマージできません",
				description:
					"GitHub 側のチェックに通っていない項目があります。コンフリクト / 必須レビュー / CI を確認してください。",
				details: rawMessage,
				primaryAction: handlers.openPullRequestUrl
					? {
							label: "GitHub で開く",
							variant: "primary",
							onClick: handlers.openPullRequestUrl,
						}
					: undefined,
				secondaryAction: handlers.retry
					? {
							label: "状態を再取得",
							variant: "outline",
							onClick: handlers.retry,
						}
					: undefined,
			};

		case "pr-already-done":
			return {
				kind,
				tone: "info",
				title: "この PR はすでに閉じられています",
				description:
					"merge 済みまたは close 済みのためマージ操作は不要です。ローカルの状態が古い可能性があります。",
				details: rawMessage,
				primaryAction: handlers.openPullRequestUrl
					? {
							label: "GitHub で開く",
							variant: "primary",
							onClick: handlers.openPullRequestUrl,
						}
					: undefined,
				secondaryAction: handlers.retry
					? { label: "状態を更新", variant: "outline", onClick: handlers.retry }
					: undefined,
			};

		case "pr-not-found":
			return {
				kind,
				tone: "info",
				title: "このブランチに対応する Pull Request が見つかりません",
				description: "先に PR を作成してからマージしてください。",
				details: rawMessage,
			};

		case "index-lock":
			return {
				kind,
				tone: "warn",
				title: "別の Git 操作が実行中です",
				description:
					".git/index.lock が残っています。他のエディタ / CLI が編集中か、前回の操作が異常終了した可能性があります。",
				details: rawMessage,
				primaryAction: handlers.retry
					? {
							label: "もう一度試す",
							variant: "primary",
							onClick: handlers.retry,
						}
					: undefined,
				secondaryAction: handlers.forceUnlockIndex
					? {
							label: "強制的に解除",
							variant: "danger",
							onClick: handlers.forceUnlockIndex,
						}
					: undefined,
			};

		case "detached-head":
			return {
				kind,
				tone: "warn",
				title: "ブランチが選ばれていません",
				description:
					"現在 detached HEAD のためこの操作はできません。新しいブランチを作るか、既存のブランチに切り替えてください。",
				details: rawMessage,
				primaryAction: handlers.openCreateBranchDialog
					? {
							label: "ブランチを作る",
							variant: "primary",
							onClick: handlers.openCreateBranchDialog,
						}
					: undefined,
			};

		case "permission-denied":
			return {
				kind,
				tone: "danger",
				title: "ファイルの権限エラーです",
				description:
					"対象のファイルに書き込み権限がないか、他のプロセスが使用中です。",
				details: rawMessage,
				primaryAction: handlers.retry
					? { label: "再試行", variant: "primary", onClick: handlers.retry }
					: undefined,
			};

		case "branch-name-collision":
			return {
				kind,
				tone: "warn",
				title: "同名のブランチがすでにあります",
				description: "別の名前を入力するか、既存ブランチに切り替えてください。",
				details: rawMessage,
			};

		case "branch-behind-upstream":
			return {
				kind,
				tone: "warn",
				title: "ブランチが upstream より遅れています",
				description:
					"先にリモートの変更を取り込む必要があります。pull/rebase してから再実行してください。",
				details: rawMessage,
				primaryAction: handlers.pullRebaseAndRetryPush
					? {
							label: "pull --rebase して再試行",
							variant: "primary",
							onClick: handlers.pullRebaseAndRetryPush,
						}
					: undefined,
			};

		case "non-git-repo":
			return {
				kind,
				tone: "info",
				title: "このフォルダは Git リポジトリではありません",
				description:
					"Git を初期化すると Changes タブで履歴管理ができるようになります。",
				primaryAction: handlers.openInitGitDialog
					? {
							label: "Initialize Git",
							variant: "primary",
							onClick: handlers.openInitGitDialog,
						}
					: undefined,
			};
		default:
			return {
				kind: "generic-error",
				tone: "danger",
				title: "Git 操作でエラーが発生しました",
				description: "詳細は下の出力を確認してください。",
				details: rawMessage,
				primaryAction: handlers.retry
					? { label: "再試行", variant: "primary", onClick: handlers.retry }
					: undefined,
			};
	}
}

/**
 * Classify an error and open the GitOperationDialog with a kind-appropriate
 * spec. Call this from mutation onError handlers in place of `toast.error`.
 */
export function showGitErrorDialog(
	error: unknown,
	context: GitOperationContext,
	handlers: GitErrorHandlers = {},
): GitErrorKind {
	const classified = classifyGitError(error, context);
	const spec = buildSpec({ classified, handlers });
	openGitOperationDialog(spec);
	return classified.kind;
}
