import type {
	BranchPrefixMode,
	BranchSortOrder,
	PostCommitCommand,
	SmartCommitChangesMode,
} from "@superset/local-db";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Switch } from "@superset/ui/switch";
import { useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { resolveBranchPrefix, sanitizeSegment } from "shared/utils/branch";
import {
	useDefaultWorktreePath,
	WorktreeLocationPicker,
} from "../../../components/WorktreeLocationPicker";
import { BRANCH_PREFIX_MODE_LABELS } from "../../../utils/branch-prefix";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";

interface GitSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function GitSettings({ visibleItems }: GitSettingsProps) {
	const showDeleteLocalBranch = isItemVisible(
		SETTING_ITEM_ID.GIT_DELETE_LOCAL_BRANCH,
		visibleItems,
	);
	const showBranchPrefix = isItemVisible(
		SETTING_ITEM_ID.GIT_BRANCH_PREFIX,
		visibleItems,
	);
	const showWorktreeLocation = isItemVisible(
		SETTING_ITEM_ID.GIT_WORKTREE_LOCATION,
		visibleItems,
	);
	const showSmartCommit = isItemVisible(
		SETTING_ITEM_ID.GIT_SMART_COMMIT,
		visibleItems,
	);
	const showAutoStash = isItemVisible(
		SETTING_ITEM_ID.GIT_AUTO_STASH,
		visibleItems,
	);
	const showBranchSortOrder = isItemVisible(
		SETTING_ITEM_ID.GIT_BRANCH_SORT_ORDER,
		visibleItems,
	);
	const showPostCommitCommand = isItemVisible(
		SETTING_ITEM_ID.GIT_POST_COMMIT_COMMAND,
		visibleItems,
	);

	const utils = electronTrpc.useUtils();

	const { data: deleteLocalBranch, isLoading: isDeleteBranchLoading } =
		electronTrpc.settings.getDeleteLocalBranch.useQuery();
	const setDeleteLocalBranch =
		electronTrpc.settings.setDeleteLocalBranch.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getDeleteLocalBranch.cancel();
				const previous = utils.settings.getDeleteLocalBranch.getData();
				utils.settings.getDeleteLocalBranch.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getDeleteLocalBranch.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getDeleteLocalBranch.invalidate();
			},
		});

	const handleDeleteBranchToggle = (enabled: boolean) => {
		setDeleteLocalBranch.mutate({ enabled });
	};

	const { data: branchPrefix, isLoading: isBranchPrefixLoading } =
		electronTrpc.settings.getBranchPrefix.useQuery();
	const { data: gitInfo } = electronTrpc.settings.getGitInfo.useQuery();

	const [customPrefixInput, setCustomPrefixInput] = useState(
		branchPrefix?.customPrefix ?? "",
	);

	useEffect(() => {
		setCustomPrefixInput(branchPrefix?.customPrefix ?? "");
	}, [branchPrefix?.customPrefix]);

	const setBranchPrefix = electronTrpc.settings.setBranchPrefix.useMutation({
		onError: (err) => {
			console.error("[settings/branch-prefix] Failed to update:", err);
		},
		onSettled: () => {
			utils.settings.getBranchPrefix.invalidate();
		},
	});

	const handleBranchPrefixModeChange = (mode: BranchPrefixMode) => {
		setBranchPrefix.mutate({
			mode,
			customPrefix: customPrefixInput || null,
		});
	};

	const handleCustomPrefixBlur = () => {
		const sanitized = sanitizeSegment(customPrefixInput);
		setCustomPrefixInput(sanitized);
		setBranchPrefix.mutate({
			mode: "custom",
			customPrefix: sanitized || null,
		});
	};

	const { data: smartCommit, isLoading: isSmartCommitLoading } =
		electronTrpc.settings.getSmartCommit.useQuery();
	const setSmartCommit = electronTrpc.settings.setSmartCommit.useMutation({
		onMutate: async (next) => {
			await utils.settings.getSmartCommit.cancel();
			const previous = utils.settings.getSmartCommit.getData();
			utils.settings.getSmartCommit.setData(undefined, next);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getSmartCommit.setData(undefined, context.previous);
			}
		},
		onSettled: () => {
			utils.settings.getSmartCommit.invalidate();
		},
	});

	const smartCommitEnabled = smartCommit?.enabled ?? false;
	const smartCommitChanges: SmartCommitChangesMode =
		smartCommit?.changes ?? "all";

	const handleSmartCommitToggle = (enabled: boolean) => {
		setSmartCommit.mutate({ enabled, changes: smartCommitChanges });
	};
	const handleSmartCommitChangesChange = (value: SmartCommitChangesMode) => {
		setSmartCommit.mutate({ enabled: smartCommitEnabled, changes: value });
	};

	const { data: autoStash, isLoading: isAutoStashLoading } =
		electronTrpc.settings.getAutoStash.useQuery();
	const setAutoStash = electronTrpc.settings.setAutoStash.useMutation({
		onMutate: async ({ enabled }) => {
			await utils.settings.getAutoStash.cancel();
			const previous = utils.settings.getAutoStash.getData();
			utils.settings.getAutoStash.setData(undefined, enabled);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getAutoStash.setData(undefined, context.previous);
			}
		},
		onSettled: () => {
			utils.settings.getAutoStash.invalidate();
		},
	});
	const handleAutoStashToggle = (enabled: boolean) => {
		setAutoStash.mutate({ enabled });
	};

	const { data: branchSort, isLoading: isBranchSortLoading } =
		electronTrpc.settings.getBranchSortOrder.useQuery();
	const setBranchSortOrderMutation =
		electronTrpc.settings.setBranchSortOrder.useMutation({
			onMutate: async (next) => {
				await utils.settings.getBranchSortOrder.cancel();
				const previous = utils.settings.getBranchSortOrder.getData();
				utils.settings.getBranchSortOrder.setData(undefined, next);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getBranchSortOrder.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getBranchSortOrder.invalidate();
			},
		});
	const branchSortOrder: BranchSortOrder =
		branchSort?.sortOrder ?? "committerdate";
	const branchSortPinDefault = branchSort?.pinDefault ?? true;
	const handleBranchSortOrderChange = (value: BranchSortOrder) => {
		setBranchSortOrderMutation.mutate({
			sortOrder: value,
			pinDefault: branchSortPinDefault,
		});
	};
	const handleBranchSortPinDefaultChange = (enabled: boolean) => {
		setBranchSortOrderMutation.mutate({
			sortOrder: branchSortOrder,
			pinDefault: enabled,
		});
	};

	const { data: postCommitCommand, isLoading: isPostCommitCommandLoading } =
		electronTrpc.settings.getPostCommitCommand.useQuery();
	const setPostCommitCommandMutation =
		electronTrpc.settings.setPostCommitCommand.useMutation({
			onMutate: async ({ command }) => {
				await utils.settings.getPostCommitCommand.cancel();
				const previous = utils.settings.getPostCommitCommand.getData();
				utils.settings.getPostCommitCommand.setData(undefined, command);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getPostCommitCommand.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getPostCommitCommand.invalidate();
			},
		});
	const handlePostCommitCommandChange = (value: PostCommitCommand) => {
		setPostCommitCommandMutation.mutate({ command: value });
	};

	const { data: worktreeBaseDir, isLoading: isWorktreeBaseDirLoading } =
		electronTrpc.settings.getWorktreeBaseDir.useQuery();
	const setWorktreeBaseDir =
		electronTrpc.settings.setWorktreeBaseDir.useMutation({
			onMutate: async ({ path }) => {
				await utils.settings.getWorktreeBaseDir.cancel();
				const previous = utils.settings.getWorktreeBaseDir.getData();
				utils.settings.getWorktreeBaseDir.setData(undefined, path);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getWorktreeBaseDir.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getWorktreeBaseDir.invalidate();
			},
		});
	const defaultWorktreePath = useDefaultWorktreePath();

	const previewPrefix =
		resolveBranchPrefix({
			mode: branchPrefix?.mode ?? "none",
			customPrefix: customPrefixInput,
			authorPrefix: gitInfo?.authorPrefix,
			githubUsername: gitInfo?.githubUsername,
		}) ||
		(branchPrefix?.mode === "author"
			? "author-name"
			: branchPrefix?.mode === "github"
				? "username"
				: null);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Git & Worktrees</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Configure git branch and worktree behavior
				</p>
			</div>

			<div className="space-y-6">
				{showDeleteLocalBranch && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label
								htmlFor="delete-local-branch"
								className="text-sm font-medium"
							>
								Delete local branch on workspace removal
							</Label>
							<p className="text-xs text-muted-foreground">
								Also delete the local git branch when deleting a worktree
								workspace
							</p>
						</div>
						<Switch
							id="delete-local-branch"
							checked={deleteLocalBranch ?? false}
							onCheckedChange={handleDeleteBranchToggle}
							disabled={isDeleteBranchLoading || setDeleteLocalBranch.isPending}
						/>
					</div>
				)}

				{showBranchPrefix && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="text-sm font-medium">Branch Prefix</Label>
							<p className="text-xs text-muted-foreground">
								Preview:{" "}
								<code className="bg-muted px-1.5 py-0.5 rounded text-foreground">
									{previewPrefix
										? `${previewPrefix}/branch-name`
										: "branch-name"}
								</code>
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Select
								value={branchPrefix?.mode ?? "none"}
								onValueChange={(value) =>
									handleBranchPrefixModeChange(value as BranchPrefixMode)
								}
								disabled={isBranchPrefixLoading || setBranchPrefix.isPending}
							>
								<SelectTrigger className="w-[180px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(
										Object.entries(BRANCH_PREFIX_MODE_LABELS) as [
											BranchPrefixMode,
											string,
										][]
									).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{branchPrefix?.mode === "custom" && (
								<Input
									placeholder="Prefix"
									value={customPrefixInput}
									onChange={(e) => setCustomPrefixInput(e.target.value)}
									onBlur={handleCustomPrefixBlur}
									className="w-[120px]"
									disabled={isBranchPrefixLoading || setBranchPrefix.isPending}
								/>
							)}
						</div>
					</div>
				)}

				{showSmartCommit && (
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label
									htmlFor="git-smart-commit"
									className="text-sm font-medium"
								>
									Smart Commit
								</Label>
								<p className="text-xs text-muted-foreground">
									When no files are staged, commit all changes in a single step
									(matches VS Code's <code>git.enableSmartCommit</code>)
								</p>
							</div>
							<Switch
								id="git-smart-commit"
								checked={smartCommitEnabled}
								onCheckedChange={handleSmartCommitToggle}
								disabled={isSmartCommitLoading || setSmartCommit.isPending}
							/>
						</div>
						{smartCommitEnabled && (
							<div className="flex items-center justify-between pl-4">
								<div className="space-y-0.5">
									<Label className="text-xs font-medium">
										Changes to auto-stage
									</Label>
									<p className="text-[11px] text-muted-foreground">
										<code>all</code>: include untracked (<code>git add -A</code>
										). <code>tracked</code>: tracked files only (
										<code>git add -u</code>).
									</p>
								</div>
								<Select
									value={smartCommitChanges}
									onValueChange={(value) =>
										handleSmartCommitChangesChange(
											value as SmartCommitChangesMode,
										)
									}
									disabled={isSmartCommitLoading || setSmartCommit.isPending}
								>
									<SelectTrigger className="w-[140px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">All changes</SelectItem>
										<SelectItem value="tracked">Tracked only</SelectItem>
									</SelectContent>
								</Select>
							</div>
						)}
					</div>
				)}

				{showAutoStash && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="git-auto-stash" className="text-sm font-medium">
								Auto Stash
							</Label>
							<p className="text-xs text-muted-foreground">
								Stash local changes before pull / sync and restore them after it
								finishes (matches VS Code's <code>git.autoStash</code>).
								Untracked files are included. If the operation fails the stash
								is kept on the stack.
							</p>
						</div>
						<Switch
							id="git-auto-stash"
							checked={autoStash ?? false}
							onCheckedChange={handleAutoStashToggle}
							disabled={isAutoStashLoading || setAutoStash.isPending}
						/>
					</div>
				)}

				{showBranchSortOrder && (
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label className="text-sm font-medium">Branch Sort Order</Label>
								<p className="text-xs text-muted-foreground">
									Order used in the base branch picker. Remote-only branches are
									shown as <code>origin/&lt;name&gt;</code>.
								</p>
							</div>
							<Select
								value={branchSortOrder}
								onValueChange={(value) =>
									handleBranchSortOrderChange(value as BranchSortOrder)
								}
								disabled={
									isBranchSortLoading || setBranchSortOrderMutation.isPending
								}
							>
								<SelectTrigger className="w-[180px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="committerdate">
										Committer date (newest first)
									</SelectItem>
									<SelectItem value="alphabetical">Alphabetical</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center justify-between pl-4">
							<div className="space-y-0.5">
								<Label
									htmlFor="git-branch-pin-default"
									className="text-xs font-medium"
								>
									Pin default branch at top
								</Label>
								<p className="text-[11px] text-muted-foreground">
									Keep <code>main</code> / <code>master</code> / the repo's
									default branch as the first entry regardless of sort order.
								</p>
							</div>
							<Switch
								id="git-branch-pin-default"
								checked={branchSortPinDefault}
								onCheckedChange={handleBranchSortPinDefaultChange}
								disabled={
									isBranchSortLoading || setBranchSortOrderMutation.isPending
								}
							/>
						</div>
					</div>
				)}

				{showPostCommitCommand && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="text-sm font-medium">Post Commit Command</Label>
							<p className="text-xs text-muted-foreground">
								Run <code>push</code> or <code>sync</code> automatically after a
								successful commit (matches VS Code's{" "}
								<code>git.postCommitCommand</code>).
							</p>
						</div>
						<Select
							value={postCommitCommand ?? "none"}
							onValueChange={(value) =>
								handlePostCommitCommandChange(value as PostCommitCommand)
							}
							disabled={
								isPostCommitCommandLoading ||
								setPostCommitCommandMutation.isPending
							}
						>
							<SelectTrigger className="w-[140px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">None</SelectItem>
								<SelectItem value="push">Push</SelectItem>
								<SelectItem value="sync">Sync</SelectItem>
							</SelectContent>
						</Select>
					</div>
				)}

				{showWorktreeLocation && (
					<div className="space-y-0.5">
						<Label className="text-sm font-medium">Worktree location</Label>
						<p className="text-xs text-muted-foreground">
							Base directory for new worktrees
						</p>
						<WorktreeLocationPicker
							currentPath={worktreeBaseDir}
							defaultPathLabel={`Default (${defaultWorktreePath})`}
							defaultBrowsePath={worktreeBaseDir}
							disabled={
								isWorktreeBaseDirLoading || setWorktreeBaseDir.isPending
							}
							onSelect={(path) => setWorktreeBaseDir.mutate({ path })}
							onReset={() => setWorktreeBaseDir.mutate({ path: null })}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
