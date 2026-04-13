import type { GitHubStatus } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { ButtonGroup } from "@superset/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useRef, useState } from "react";
import {
	VscArrowDown,
	VscArrowUp,
	VscCheck,
	VscChevronDown,
	VscLinkExternal,
	VscRefresh,
	VscSync,
} from "react-icons/vsc";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { showGitErrorDialog } from "renderer/lib/git/gitErrorDialog";
import { showGitWarningDialog } from "renderer/lib/git/gitWarningDialog";
import { CreatePullRequestBaseRepoDialog } from "renderer/screens/main/components/CreatePullRequestBaseRepoDialog";
import { useCreateOrOpenPR } from "renderer/screens/main/hooks";
import { openGitOperationDialog } from "renderer/stores/git-operation-dialog";
import { getPrimaryAction } from "./utils/getPrimaryAction";
import { getPushActionCopy } from "./utils/getPushActionCopy";

type CommitInputPullRequest = NonNullable<GitHubStatus["pr"]>;

interface CommitInputProps {
	worktreePath: string;
	hasStagedChanges: boolean;
	unstagedChangeCount: number;
	pushCount: number;
	pullCount: number;
	hasUpstream: boolean;
	pullRequest?: CommitInputPullRequest | null;
	canCreatePR: boolean;
	shouldAutoCreatePRAfterPublish: boolean;
	onRefresh: () => void;
	commitMessage: string;
	onCommitMessageChange: (message: string) => void;
}

export function CommitInput({
	worktreePath,
	hasStagedChanges,
	unstagedChangeCount,
	pushCount,
	pullCount,
	hasUpstream,
	pullRequest,
	canCreatePR,
	shouldAutoCreatePRAfterPublish,
	onRefresh,
	commitMessage,
	onCommitMessageChange: setCommitMessage,
}: CommitInputProps) {
	const [isOpen, setIsOpen] = useState(false);

	const { data: smartCommit } = electronTrpc.settings.getSmartCommit.useQuery(
		undefined,
		{ staleTime: 10_000 },
	);
	const smartCommitEnabled = smartCommit?.enabled ?? false;
	const smartCommitMode = smartCommit?.changes ?? "all";

	const { data: autoStashEnabled = false } =
		electronTrpc.settings.getAutoStash.useQuery(undefined, {
			staleTime: 10_000,
		});
	const { data: postCommitCommand = "none" } =
		electronTrpc.settings.getPostCommitCommand.useQuery(undefined, {
			staleTime: 10_000,
		});
	// Read the latest setting inside mutation callbacks without recreating
	// the mutation when the value changes.
	const postCommitCommandRef = useRef(postCommitCommand);
	postCommitCommandRef.current = postCommitCommand;
	// When auto-stash is orchestrating a pull/sync, we want the custom
	// Japanese dialogs (pull-failed-with-stash / pop-conflict) to own the
	// error UX. This ref is used by the default onError handlers below to
	// opt out — otherwise both the built-in pull-error dialog and our
	// dialog would fire for the same failure.
	const autoStashInFlightRef = useRef(false);

	const stashIncludeUntrackedMutation =
		electronTrpc.changes.stashIncludeUntracked.useMutation();
	const stashPopMutation = electronTrpc.changes.stashPop.useMutation();
	const stageAllMutation = electronTrpc.changes.stageAll.useMutation();
	const stageTrackedMutation = electronTrpc.changes.stageTracked.useMutation();

	const commitMutation = electronTrpc.changes.commit.useMutation({
		onSuccess: () => {
			toast.success("Committed");
			setCommitMessage("");
			onRefresh();
		},
		onError: (error, variables) => {
			// Retry must use the message that was actually submitted — not the
			// current textarea value. Otherwise editing the input after a failed
			// commit would silently change what gets retried.
			const submittedMessage = variables.message;
			showGitErrorDialog(error, "commit", {
				retry: () => {
					commitMutation.mutate({
						worktreePath,
						message: submittedMessage,
					});
				},
				retryWithoutHooks: () => {
					commitMutation.mutate({
						worktreePath,
						message: submittedMessage,
						skipHooks: true,
					});
				},
			});
		},
	});

	const pushMutation = electronTrpc.changes.push.useMutation({
		onSuccess: (result) => {
			toast.success("Pushed");
			onRefresh();
			showGitWarningDialog(result?.warnings, {
				fetchOnlyRetry: () => fetchMutation.mutate({ worktreePath }),
				createPullRequest: () => createOrOpenPR(),
				openPullRequestUrl: () => {
					if (pullRequest?.url) {
						window.open(pullRequest.url, "_blank", "noopener,noreferrer");
					}
				},
			});
		},
		onError: (error) => {
			showGitErrorDialog(error, "push", {
				retry: () => pushMutation.mutate({ worktreePath, setUpstream: true }),
				pullRebaseAndRetryPush: () => {
					pullMutation.mutate(
						{ worktreePath },
						{
							onSuccess: () =>
								pushMutation.mutate({ worktreePath, setUpstream: true }),
						},
					);
				},
			});
		},
	});

	const pullMutation = electronTrpc.changes.pull.useMutation({
		onSuccess: () => {
			toast.success("Pulled");
			onRefresh();
		},
		onError: (error) => {
			if (autoStashInFlightRef.current) {
				return;
			}
			showGitErrorDialog(error, "pull", {
				retry: () => pullMutation.mutate({ worktreePath }),
				stashAndRetry: () => {
					// stash → pull → stash pop. Skipping the pop would silently
					// leave the user's local changes on the stash stack after a
					// successful pull, which is almost never what the user
					// expected when they chose "stash してから pull".
					stashIncludeUntrackedMutation.mutate(
						{ worktreePath },
						{
							onSuccess: () => {
								pullMutation.mutate(
									{ worktreePath },
									{
										onSuccess: () => {
											stashPopMutation.mutate(
												{ worktreePath },
												{
													onError: (popError) =>
														showGitErrorDialog(popError, "stash-pop"),
												},
											);
										},
									},
								);
							},
							onError: (stashError) => showGitErrorDialog(stashError, "stash"),
						},
					);
				},
			});
		},
	});

	const syncMutation = electronTrpc.changes.sync.useMutation({
		onSuccess: (result) => {
			toast.success("Synced");
			onRefresh();
			showGitWarningDialog(result?.warnings, {
				fetchOnlyRetry: () => fetchMutation.mutate({ worktreePath }),
				createPullRequest: () => createOrOpenPR(),
				openPullRequestUrl: () => {
					if (pullRequest?.url) {
						window.open(pullRequest.url, "_blank", "noopener,noreferrer");
					}
				},
			});
		},
		onError: (error) => {
			if (autoStashInFlightRef.current) {
				return;
			}
			showGitErrorDialog(error, "sync", {
				retry: () => syncMutation.mutate({ worktreePath }),
				pullRebaseAndRetryPush: () => {
					pullMutation.mutate(
						{ worktreePath },
						{
							onSuccess: () =>
								pushMutation.mutate({ worktreePath, setUpstream: true }),
						},
					);
				},
			});
		},
	});

	const {
		createOrOpenPR,
		isPending: isCreateOrOpenPRPending,
		baseRepoDialog,
	} = useCreateOrOpenPR({
		worktreePath,
		onSuccess: onRefresh,
	});

	const fetchMutation = electronTrpc.changes.fetch.useMutation({
		onSuccess: () => {
			toast.success("Fetched");
			onRefresh();
		},
		onError: (error) => {
			showGitErrorDialog(error, "fetch", {
				retry: () => fetchMutation.mutate({ worktreePath }),
			});
		},
	});

	const isPending =
		commitMutation.isPending ||
		pushMutation.isPending ||
		pullMutation.isPending ||
		syncMutation.isPending ||
		isCreateOrOpenPRPending ||
		fetchMutation.isPending ||
		stageAllMutation.isPending ||
		stageTrackedMutation.isPending ||
		stashIncludeUntrackedMutation.isPending ||
		stashPopMutation.isPending;

	// Smart commit lets the user commit with an empty index as long as
	// there is at least one unstaged change to auto-stage.
	const smartCommitAvailable =
		smartCommitEnabled && !hasStagedChanges && unstagedChangeCount > 0;
	const willSmartCommit = smartCommitAvailable;
	const canCommit =
		(hasStagedChanges || smartCommitAvailable) && commitMessage.trim();
	const hasExistingPR = Boolean(pullRequest);
	const prUrl = pullRequest?.url;
	const pushActionCopy = getPushActionCopy({
		hasUpstream,
		pushCount,
		pullRequest,
	});

	const commitLabel = willSmartCommit
		? `Commit All (${unstagedChangeCount})`
		: "Commit";
	const commitTooltip = willSmartCommit
		? smartCommitMode === "tracked"
			? `Stage ${unstagedChangeCount} tracked changes, then commit`
			: `Stage ${unstagedChangeCount} changes (including untracked), then commit`
		: undefined;

	// Kicks off the configured post-commit command once the commit itself
	// has succeeded. Uses a ref so the value reflects the latest setting
	// without recreating the commit mutation on every setting change, and
	// chains into the existing push / sync mutations so their own
	// onSuccess (toast / warnings / PR flow) and onError (retry dialogs)
	// handlers still run untouched.
	const runPostCommitCommand = () => {
		const command = postCommitCommandRef.current;
		if (command === "push") {
			pushMutation.mutate({ worktreePath, setUpstream: true });
		} else if (command === "sync") {
			// handleSync routes through the auto-stash orchestrator so it
			// also stays compatible with git.autoStash.
			handleSync();
		}
	};

	const handleCommit = () => {
		if (!canCommit) return;
		runCommitWithCallback(runPostCommitCommand);
	};

	const handlePush = () => {
		const isPublishing = !hasUpstream;
		pushMutation.mutate(
			{ worktreePath, setUpstream: true },
			{
				onSuccess: () => {
					if (
						isPublishing &&
						!hasExistingPR &&
						shouldAutoCreatePRAfterPublish
					) {
						createOrOpenPR();
					}
				},
			},
		);
	};
	const hasLocalChanges = hasStagedChanges || unstagedChangeCount > 0;

	/**
	 * Auto-stash orchestration for pull / sync. When the user has enabled
	 * `git.autoStash` and their working tree has local changes, we:
	 *   1. stash (include untracked)
	 *   2. run the network op
	 *   3. on success: stash pop (restore local changes)
	 *   4. on network failure: leave the stash intact and show a Japanese
	 *      dialog telling the user their changes are safe on the stack
	 *   5. on pop failure (usually a conflict): show a different Japanese
	 *      dialog and do not auto-retry — the user will resolve manually
	 *
	 * When auto-stash is disabled, or the working tree is already clean,
	 * fall through to the plain mutation (no extra steps).
	 */
	const showAutoStashPullFailedDialog = (errorMessage: string) => {
		openGitOperationDialog({
			kind: "auto-stash-pull-failed",
			tone: "warn",
			title: "Pull に失敗しました",
			description:
				"ローカルの変更は stash に退避されたままです。Git の状態を確認してから、手動で `git stash pop` で変更を復元してください。",
			details: errorMessage,
		});
	};
	const showAutoStashPopConflictDialog = (errorMessage: string) => {
		openGitOperationDialog({
			kind: "auto-stash-pop-conflict",
			tone: "warn",
			title: "Stash の復元で競合が発生しました",
			description:
				"Pull は成功しましたが、stash の pop でコンフリクトが起きました。stash stack に変更が残っているので、手動で `git stash pop` を実行してコンフリクトを解決してください。",
			details: errorMessage,
		});
	};

	const runPullOrSyncWithAutoStash = (operation: "pull" | "sync") => {
		const runNetworkOp = (onDone: () => void) => {
			const mutation = operation === "pull" ? pullMutation : syncMutation;
			mutation.mutate(
				{ worktreePath },
				{
					onSuccess: () => onDone(),
					onError: (error) => {
						// Only fires when autoStashInFlightRef is true (see guard in
						// the mutation definition above). Clear the flag and show the
						// auto-stash specific Japanese dialog instead of the default
						// pull/sync error flow.
						autoStashInFlightRef.current = false;
						const message =
							error instanceof Error ? error.message : String(error);
						showAutoStashPullFailedDialog(message);
					},
				},
			);
		};

		if (!autoStashEnabled || !hasLocalChanges) {
			const mutation = operation === "pull" ? pullMutation : syncMutation;
			mutation.mutate({ worktreePath });
			return;
		}

		autoStashInFlightRef.current = true;
		stashIncludeUntrackedMutation.mutate(
			{ worktreePath },
			{
				onSuccess: () => {
					runNetworkOp(() => {
						stashPopMutation.mutate(
							{ worktreePath },
							{
								onSuccess: () => {
									autoStashInFlightRef.current = false;
								},
								onError: (popError) => {
									autoStashInFlightRef.current = false;
									const message =
										popError instanceof Error
											? popError.message
											: String(popError);
									showAutoStashPopConflictDialog(message);
								},
							},
						);
					});
				},
				onError: (stashError) => {
					autoStashInFlightRef.current = false;
					showGitErrorDialog(stashError, "stash");
				},
			},
		);
	};

	const handlePull = () => runPullOrSyncWithAutoStash("pull");
	const handleSync = () => runPullOrSyncWithAutoStash("sync");
	const handleFetch = () => fetchMutation.mutate({ worktreePath });
	// Fix C: Fetch & Pull must go through the auto-stash orchestrator so
	// that git.autoStash is honoured, matching the behaviour of the plain
	// Pull button.
	const handleFetchAndPull = () => {
		fetchMutation.mutate(
			{ worktreePath },
			{ onSuccess: () => runPullOrSyncWithAutoStash("pull") },
		);
	};
	const handleCreatePR = () => {
		if (!canCreatePR) return;
		createOrOpenPR();
	};
	const handleOpenPR = () => prUrl && window.open(prUrl, "_blank");

	// Fix B: Commit+Push / Commit+Push+PR must run the same smart-commit
	// staging logic as the primary Commit button so that git.enableSmartCommit
	// is honoured when the staging area is empty.
	const runCommitWithCallback = (onCommitSuccess: () => void) => {
		const message = commitMessage.trim();
		if (willSmartCommit) {
			const stageMutation =
				smartCommitMode === "tracked" ? stageTrackedMutation : stageAllMutation;
			stageMutation.mutate(
				{ worktreePath },
				{
					onSuccess: () => {
						commitMutation.mutate(
							{ worktreePath, message },
							{ onSuccess: onCommitSuccess },
						);
					},
					onError: (error) => {
						showGitErrorDialog(error, "stage");
					},
				},
			);
		} else {
			commitMutation.mutate(
				{ worktreePath, message },
				{ onSuccess: onCommitSuccess },
			);
		}
	};

	const handleCommitAndPush = () => {
		if (!canCommit) return;
		runCommitWithCallback(handlePush);
	};

	const handleCommitPushAndCreatePR = () => {
		if (!canCommit) return;
		runCommitWithCallback(() => {
			pushMutation.mutate(
				{ worktreePath, setUpstream: true },
				{ onSuccess: handleCreatePR },
			);
		});
	};

	const primaryAction = getPrimaryAction({
		canCommit: Boolean(canCommit),
		hasStagedChanges,
		isPending,
		pushCount,
		pullCount,
		hasUpstream,
		pushActionCopy,
	});

	const primary = {
		...primaryAction,
		label:
			primaryAction.action === "commit" && willSmartCommit
				? commitLabel
				: primaryAction.action === "commit" && !hasStagedChanges
					? primaryAction.label
					: primaryAction.label,
		tooltip:
			primaryAction.action === "commit" && willSmartCommit && commitTooltip
				? commitTooltip
				: primaryAction.tooltip,
		icon:
			primaryAction.action === "commit" ? (
				<VscCheck className="size-4" />
			) : primaryAction.action === "sync" ? (
				<VscSync className="size-4" />
			) : primaryAction.action === "pull" ? (
				<VscArrowDown className="size-4" />
			) : (
				<VscArrowUp className="size-4" />
			),
		handler:
			primaryAction.action === "commit"
				? handleCommit
				: primaryAction.action === "sync"
					? handleSync
					: primaryAction.action === "pull"
						? handlePull
						: handlePush,
	};

	const countBadge =
		pushCount > 0 || pullCount > 0
			? `${pullCount > 0 ? pullCount : ""}${pullCount > 0 && pushCount > 0 ? "/" : ""}${pushCount > 0 ? pushCount : ""}`
			: null;

	return (
		<>
			<div className="flex flex-col gap-1.5 px-2 py-2">
				<div className="relative">
					<Textarea
						placeholder="Commit message"
						value={commitMessage}
						onChange={(e) => setCommitMessage(e.target.value)}
						className="min-h-[52px] resize-none text-[10px] bg-background pr-7"
						onKeyDown={(e) => {
							if (
								e.key === "Enter" &&
								(e.metaKey || e.ctrlKey) &&
								!primary.disabled
							) {
								e.preventDefault();
								primary.handler();
							}
						}}
					/>
				</div>
				<ButtonGroup className="w-full">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="secondary"
								size="sm"
								className="flex-1 gap-1.5 h-7 text-xs"
								onClick={primary.handler}
								disabled={primary.disabled}
							>
								{primary.icon}
								<span>{primary.label}</span>
								{countBadge && (
									<span className="text-[10px] opacity-70">{countBadge}</span>
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">{primary.tooltip}</TooltipContent>
					</Tooltip>
					<DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
						<DropdownMenuTrigger asChild>
							<Button
								variant="secondary"
								size="sm"
								disabled={isPending}
								className="h-7 px-1.5"
							>
								<VscChevronDown className="size-3.5" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-48 text-xs">
							<DropdownMenuItem
								onClick={handleCommit}
								disabled={!canCommit}
								className="text-xs"
							>
								<VscCheck className="size-3.5" />
								Commit
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={handleCommitAndPush}
								disabled={!canCommit}
								className="text-xs"
							>
								<VscArrowUp className="size-3.5" />
								Commit & Push
							</DropdownMenuItem>
							{!hasExistingPR && canCreatePR && (
								<DropdownMenuItem
									onClick={handleCommitPushAndCreatePR}
									disabled={!canCommit}
									className="text-xs"
								>
									<VscLinkExternal className="size-3.5" />
									Commit, Push & Create PR
								</DropdownMenuItem>
							)}

							<DropdownMenuSeparator />

							<DropdownMenuItem
								onClick={handlePush}
								disabled={pushCount === 0 && hasUpstream}
								className="text-xs"
							>
								<VscArrowUp className="size-3.5" />
								<span className="flex-1">{pushActionCopy.menuLabel}</span>
								{pushCount > 0 && (
									<span className="text-[10px] text-muted-foreground">
										{pushCount}
									</span>
								)}
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={handlePull}
								disabled={pullCount === 0}
								className="text-xs"
							>
								<VscArrowDown className="size-3.5" />
								<span className="flex-1">Pull</span>
								{pullCount > 0 && (
									<span className="text-[10px] text-muted-foreground">
										{pullCount}
									</span>
								)}
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={handleSync}
								disabled={pushCount === 0 && pullCount === 0}
								className="text-xs"
							>
								<VscSync className="size-3.5" />
								Sync
							</DropdownMenuItem>
							<DropdownMenuItem onClick={handleFetch} className="text-xs">
								<VscRefresh className="size-3.5" />
								Fetch
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={handleFetchAndPull}
								className="text-xs"
							>
								<VscRefresh className="size-3.5" />
								Fetch & Pull
							</DropdownMenuItem>

							<DropdownMenuSeparator />

							{hasExistingPR ? (
								<DropdownMenuItem onClick={handleOpenPR} className="text-xs">
									<VscLinkExternal className="size-3.5" />
									Open Pull Request
								</DropdownMenuItem>
							) : canCreatePR ? (
								<DropdownMenuItem onClick={handleCreatePR} className="text-xs">
									<VscLinkExternal className="size-3.5" />
									Create Pull Request
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</ButtonGroup>
			</div>
			<CreatePullRequestBaseRepoDialog
				open={baseRepoDialog.open}
				options={baseRepoDialog.options}
				isPending={isCreateOrOpenPRPending}
				onOpenChange={baseRepoDialog.onOpenChange}
				onConfirm={baseRepoDialog.onConfirm}
			/>
		</>
	);
}
