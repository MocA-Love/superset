import type { GitHubStatus } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@superset/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	type ButtonHTMLAttributes,
	forwardRef,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GoGitBranch, GoGlobe } from "react-icons/go";
import { IoCloudDownloadOutline } from "react-icons/io5";
import { LuArrowLeft, LuChevronDown, LuPlus, LuTag } from "react-icons/lu";
import {
	VscCheck,
	VscGitCompare,
	VscGitStash,
	VscGitStashApply,
	VscRefresh,
	VscSparkle,
} from "react-icons/vsc";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { formatRelativeTime } from "renderer/lib/formatRelativeTime";
import type { ChangesViewMode } from "../../types";
import { ViewModeToggle } from "../ViewModeToggle";
import {
	BranchActionDialog,
	type BranchActionDialogState,
	type BranchProgressOperation,
} from "./components/BranchActionDialog";
import { PRButton } from "./components/PRButton";

const BRANCH_QUERY_STALE_TIME_MS = 10_000;

interface ChangesHeaderProps {
	onRefresh: () => void;
	viewMode: ChangesViewMode;
	onViewModeChange: (mode: ChangesViewMode) => void;
	showViewModeToggle?: boolean;
	worktreePath: string;
	currentBranch?: string | null;
	pr: GitHubStatus["pr"] | null;
	isPRStatusLoading: boolean;
	canCreatePR: boolean;
	createPRBlockedReason: string | null;
	onStash: () => void;
	onStashAsync: () => Promise<void>;
	onStashIncludeUntracked: () => void;
	onStashIncludeUntrackedAsync: () => Promise<void>;
	onStashPop: () => void;
	isStashPending: boolean;
	onGenerateCommitMessage: () => void;
	isGeneratingCommitMessage: boolean;
	hasUncommittedChanges: boolean;
	hasUntrackedFiles: boolean;
	hasConflictedFiles: boolean;
	isGitGraphOpen: boolean;
	onToggleGitGraph: () => void;
}

const BranchSelectorButton = forwardRef<
	HTMLButtonElement,
	{
		label: string;
		disabled?: boolean;
	} & ButtonHTMLAttributes<HTMLButtonElement>
>(({ label, disabled, ...props }, ref) => (
	<button
		ref={ref}
		type="button"
		disabled={disabled}
		{...props}
		className="flex min-w-0 items-center gap-0.5 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
	>
		<span className="min-w-0 truncate font-mono">{label}</span>
		<LuChevronDown className="size-3 shrink-0" />
	</button>
));
BranchSelectorButton.displayName = "BranchSelectorButton";

type CurrentBranchSelectorMode =
	| "default"
	| "create"
	| "create-from-ref"
	| "compare-base";

interface SearchableRefItem {
	name: string;
	displayName: string;
	ref: string;
	kind: "branch" | "tag";
	scope: "local" | "remote" | "tag";
	lastCommitDate: number;
	shortHash: string | null;
	authorName: string | null;
	subject: string | null;
	checkedOutPath: string | null;
}

function normalizeBranchName(branch: string | null | undefined): string | null {
	const trimmed = branch?.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("refs/heads/")) {
		return trimmed.slice("refs/heads/".length);
	}
	if (trimmed.startsWith("refs/remotes/origin/")) {
		return trimmed.slice("refs/remotes/origin/".length);
	}
	if (trimmed.startsWith("remotes/origin/")) {
		return trimmed.slice("remotes/origin/".length);
	}
	if (trimmed.startsWith("origin/")) {
		return trimmed.slice("origin/".length);
	}
	return trimmed;
}

function isCheckedOutElsewhereMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("already checked out") ||
		normalized.includes("already used by worktree")
	);
}

function isGitBusyMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("could not lock") ||
		normalized.includes("unable to lock") ||
		(normalized.includes(".lock") && normalized.includes("file exists"))
	);
}

function isReferenceMissingMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		(normalized.includes("pathspec") && normalized.includes("did not match")) ||
		normalized.includes("invalid reference") ||
		normalized.includes("unknown revision") ||
		normalized.includes("not a valid object name") ||
		normalized.includes("cannot be resolved to branch")
	);
}

function isOverwriteConflictMessage(message: string): boolean {
	return (
		message.includes("overwritten") ||
		message.includes("conflict") ||
		message.includes("Please commit") ||
		message.includes("would be overwritten") ||
		message.includes("上書き") ||
		message.includes("コミット") ||
		message.includes("スタッシュ")
	);
}

function getSearchableRefIcon(ref: Pick<SearchableRefItem, "kind" | "scope">) {
	if (ref.kind === "tag") {
		return <LuTag className="size-3.5 shrink-0 text-muted-foreground" />;
	}

	if (ref.scope === "remote") {
		return <GoGlobe className="size-3.5 shrink-0 text-muted-foreground" />;
	}

	return <GoGitBranch className="size-3.5 shrink-0 text-muted-foreground" />;
}

function getSearchableRefMeta(ref: SearchableRefItem): string | null {
	return (
		[ref.authorName, ref.shortHash, ref.subject]
			.filter((value): value is string => Boolean(value))
			.join(" • ") || null
	);
}

function BranchNameWithOverflowTooltip({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const textRef = useRef<HTMLSpanElement | null>(null);
	const [isTruncated, setIsTruncated] = useState(false);

	useEffect(() => {
		const updateIsTruncated = () => {
			const element = textRef.current;
			if (!element) {
				return;
			}

			setIsTruncated(element.scrollWidth > element.clientWidth + 1);
		};

		updateIsTruncated();

		const element = textRef.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver(() => {
			updateIsTruncated();
		});
		observer.observe(element);

		return () => {
			observer.disconnect();
		};
	}, []);

	const content = (
		<span ref={textRef} className={cn("block truncate", className)}>
			{name}
		</span>
	);

	if (!isTruncated) {
		return content;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>{content}</TooltipTrigger>
			<TooltipContent side="top" showArrow={false}>
				{name}
			</TooltipContent>
		</Tooltip>
	);
}

function BranchRefCommandItem({
	refItem,
	onSelect,
	isCurrent = false,
	isDefault = false,
	isDisabled = false,
	statusLabel,
}: {
	refItem: SearchableRefItem;
	onSelect: () => void;
	isCurrent?: boolean;
	isDefault?: boolean;
	isDisabled?: boolean;
	statusLabel?: string | null;
}) {
	const meta = getSearchableRefMeta(refItem);

	return (
		<CommandItem
			value={refItem.displayName}
			onSelect={() => {
				if (!isDisabled) {
					onSelect();
				}
			}}
			disabled={isDisabled}
			className="group flex h-auto items-start justify-between gap-3 px-3 py-2.5 text-xs"
		>
			<span className="flex min-w-0 flex-1 items-start gap-2.5">
				{getSearchableRefIcon(refItem)}
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-1.5">
						<BranchNameWithOverflowTooltip
							key={refItem.displayName}
							name={refItem.displayName}
							className="font-mono text-xs"
						/>
						{isDefault ? (
							<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
								default
							</span>
						) : null}
					</span>
					{meta ? (
						<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
							{meta}
						</span>
					) : null}
				</span>
			</span>
			<span className="flex shrink-0 items-center gap-2 pt-0.5">
				{refItem.lastCommitDate > 0 ? (
					<span className="text-[10px] text-muted-foreground">
						{formatRelativeTime(refItem.lastCommitDate)}
					</span>
				) : null}
				{statusLabel ? (
					<span className="text-[10px] text-muted-foreground">
						{statusLabel}
					</span>
				) : null}
				{isCurrent ? (
					<VscCheck className="size-3.5 shrink-0 text-primary" />
				) : null}
			</span>
		</CommandItem>
	);
}

function CurrentBranchSelector({
	worktreePath,
	currentBranch,
	hasUncommittedChanges,
	hasUntrackedFiles,
	hasConflictedFiles,
	isStashPending,
	onStashAsync,
	onStashIncludeUntrackedAsync,
	onRefresh,
}: {
	worktreePath: string;
	currentBranch?: string | null;
	hasUncommittedChanges: boolean;
	hasUntrackedFiles: boolean;
	hasConflictedFiles: boolean;
	isStashPending: boolean;
	onStashAsync: () => Promise<void>;
	onStashIncludeUntrackedAsync: () => Promise<void>;
	onRefresh: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [mode, setMode] = useState<CurrentBranchSelectorMode>("default");
	const [selectedStartPoint, setSelectedStartPoint] =
		useState<SearchableRefItem | null>(null);
	const [dialogState, setDialogState] =
		useState<BranchActionDialogState | null>(null);
	const utils = electronTrpc.useUtils();
	const { data: branchData, isLoading } =
		electronTrpc.changes.getBranches.useQuery(
			{ worktreePath },
			{
				enabled: !!worktreePath,
				staleTime: BRANCH_QUERY_STALE_TIME_MS,
				refetchOnWindowFocus: false,
			},
		);
	const { data: branchGuardState } =
		electronTrpc.changes.getBranchGuardState.useQuery(
			{ worktreePath },
			{
				enabled: !!worktreePath,
				staleTime: 2_000,
				refetchOnWindowFocus: false,
			},
		);
	const { data: refSearchData, isLoading: isRefSearchLoading } =
		electronTrpc.changes.searchRefs.useQuery(
			{
				worktreePath,
				search,
				includeTags: mode === "create-from-ref",
				limit: 50,
			},
			{
				enabled:
					open &&
					!!worktreePath &&
					(mode === "default" || mode === "create-from-ref"),
				staleTime: BRANCH_QUERY_STALE_TIME_MS,
				refetchOnWindowFocus: false,
			},
		);

	const invalidateBranchQueries = () => {
		void utils.changes.getBranches.invalidate({ worktreePath });
		void utils.changes.getStatus.invalidate();
		void utils.changes.searchRefs.invalidate();
		onRefresh();
	};

	type BranchActionTarget =
		| {
				action: "switch";
				branch: string;
		  }
		| {
				action: "create-from-ref";
				branch: string;
				startPointRef: string;
				startPointDisplayName: string | null;
		  };

	const openDirtyActionDialog = (
		kind: "dirty-uncommitted" | "dirty-untracked" | "conflicted",
		target: BranchActionTarget,
	) => {
		setDialogState({ kind, target });
		setOpen(false);
	};

	const openOperationDialog = (
		target: BranchActionTarget,
		operation?: BranchProgressOperation | null,
	) => {
		setDialogState({
			kind: "operation-in-progress",
			target,
			operation: operation ?? null,
		});
		setOpen(false);
	};

	const resetSelectorState = () => {
		setOpen(false);
		setSearch("");
		setMode("default");
		setSelectedStartPoint(null);
	};

	const runTargetAction = (target: BranchActionTarget) => {
		setDialogState(null);
		if (target.action === "switch") {
			switchBranch.mutate({ worktreePath, branch: target.branch });
			resetSelectorState();
			return;
		}

		createBranch.mutate({
			worktreePath,
			branch: target.branch,
			startPoint: target.startPointRef,
		});
		resetSelectorState();
	};

	const handleStashFailure = (target: BranchActionTarget, error: unknown) => {
		const message =
			error instanceof Error
				? error.message
				: "stash に失敗したため、branch 操作を続けられませんでした。";
		setDialogState({
			kind: "stash-failed",
			target,
			message,
		});
	};

	const switchBranch = electronTrpc.changes.switchBranch.useMutation({
		onSuccess: () => {
			invalidateBranchQueries();
		},
		onError: (error, variables) => {
			const msg = error.message ?? "";
			const target = {
				action: "switch" as const,
				branch: variables.branch,
			};
			if (isCheckedOutElsewhereMessage(msg)) {
				setDialogState({
					kind: "checked-out-elsewhere",
					target,
				});
				return;
			}
			if (isGitBusyMessage(msg)) {
				setDialogState({
					kind: "git-busy",
					target,
					message: msg,
				});
				return;
			}
			if (isReferenceMissingMessage(msg)) {
				setDialogState({
					kind: "reference-missing",
					target,
				});
				return;
			}
			if (isOverwriteConflictMessage(msg)) {
				setDialogState({
					kind: hasUntrackedFiles ? "dirty-untracked" : "dirty-uncommitted",
					target,
				});
				return;
			}
			toast.error(`Failed to switch branch: ${msg}`);
		},
	});
	const createBranch = electronTrpc.changes.createBranch.useMutation({
		onSuccess: () => {
			invalidateBranchQueries();
		},
		onError: (error, variables) => {
			const message = error.message ?? "Unknown error";
			const target =
				variables.startPoint == null
					? null
					: {
							action: "create-from-ref" as const,
							branch: variables.branch,
							startPointRef: variables.startPoint,
							startPointDisplayName: selectedStartPoint?.displayName ?? null,
						};
			if (target && isGitBusyMessage(message)) {
				setDialogState({
					kind: "git-busy",
					target,
					message,
				});
				return;
			}
			if (target && isReferenceMissingMessage(message)) {
				setDialogState({
					kind: "reference-missing",
					target,
				});
				return;
			}
			toast.error(`Failed to create branch: ${message}`);
		},
	});
	const updateBaseBranch = electronTrpc.changes.updateBaseBranch.useMutation({
		onSuccess: () => {
			invalidateBranchQueries();
		},
		onError: (error) => {
			if (error.message?.includes("Could not determine current branch")) {
				setDialogState({ kind: "compare-detached-head" });
				return;
			}
			toast.error(
				`Failed to update compare branch: ${error.message ?? "Unknown error"}`,
			);
		},
	});

	const effectiveCurrentBranch =
		normalizeBranchName(currentBranch) ??
		normalizeBranchName(branchData?.currentBranch) ??
		null;
	const effectiveBaseBranch =
		branchData?.worktreeBaseBranch ?? branchData?.defaultBranch ?? "main";
	const existingBranchNames = useMemo(
		() =>
			new Set([
				...(branchData?.local ?? []).map((entry) => entry.branch.toLowerCase()),
				...(branchData?.remote ?? []).map((branch) => branch.toLowerCase()),
			]),
		[branchData?.local, branchData?.remote],
	);

	const compareBaseBranches = useMemo(() => {
		const branches = [...(branchData?.remote ?? [])].filter(
			(branch) => branch !== branchData?.defaultBranch,
		);
		branches.sort((a, b) => {
			if (a === effectiveBaseBranch) return -1;
			if (b === effectiveBaseBranch) return 1;
			if (a === branchData?.defaultBranch) return -1;
			if (b === branchData?.defaultBranch) return 1;
			return a.localeCompare(b);
		});
		if (!search) return branches;
		const lower = search.toLowerCase();
		return branches.filter((branch) => branch.toLowerCase().includes(lower));
	}, [
		branchData?.defaultBranch,
		branchData?.remote,
		effectiveBaseBranch,
		search,
	]);

	const branchResults = useMemo(
		() =>
			(refSearchData?.refs ?? []).filter(
				(ref): ref is SearchableRefItem => ref.kind === "branch",
			),
		[refSearchData?.refs],
	);
	const localBranchResults = useMemo(
		() => branchResults.filter((ref) => ref.scope === "local"),
		[branchResults],
	);
	const remoteBranchResults = useMemo(
		() => branchResults.filter((ref) => ref.scope === "remote"),
		[branchResults],
	);
	const tagResults = useMemo(
		() =>
			(refSearchData?.refs ?? []).filter(
				(ref): ref is SearchableRefItem => ref.kind === "tag",
			),
		[refSearchData?.refs],
	);

	const createBranchName = search.trim();
	const isCreateBranchNameTaken = existingBranchNames.has(
		createBranchName.toLowerCase(),
	);

	const handleBranchSelect = (branch: string) => {
		const normalizedBranch = normalizeBranchName(branch) ?? branch;
		const target = {
			action: "switch" as const,
			branch: normalizedBranch,
		};
		if (normalizedBranch === effectiveCurrentBranch) {
			setOpen(false);
			return;
		}
		if (branchGuardState?.operationInProgress) {
			openOperationDialog(target, branchGuardState.operationInProgress);
			return;
		}
		if (hasConflictedFiles) {
			openDirtyActionDialog("conflicted", target);
			return;
		}
		if (hasUntrackedFiles) {
			openDirtyActionDialog("dirty-untracked", target);
			return;
		}
		if (hasUncommittedChanges) {
			openDirtyActionDialog("dirty-uncommitted", target);
			return;
		}
		runTargetAction(target);
	};

	const handleCreateBranch = () => {
		if (!createBranchName || isCreateBranchNameTaken) {
			return;
		}
		const currentBranchCreateTarget = {
			action: "create-from-ref" as const,
			branch: createBranchName,
			startPointRef: effectiveCurrentBranch ?? "HEAD",
			startPointDisplayName: effectiveCurrentBranch,
		};
		if (branchGuardState?.operationInProgress) {
			openOperationDialog(
				currentBranchCreateTarget,
				branchGuardState.operationInProgress,
			);
			return;
		}
		if (hasConflictedFiles) {
			openDirtyActionDialog("conflicted", currentBranchCreateTarget);
			return;
		}
		if (!selectedStartPoint) {
			createBranch.mutate({
				worktreePath,
				branch: createBranchName,
				startPoint: null,
			});
			resetSelectorState();
			return;
		}

		const target = {
			action: "create-from-ref" as const,
			branch: createBranchName,
			startPointRef: selectedStartPoint.ref,
			startPointDisplayName: selectedStartPoint.displayName,
		};
		if (branchGuardState?.operationInProgress) {
			openOperationDialog(target, branchGuardState.operationInProgress);
			return;
		}
		if (hasConflictedFiles) {
			openDirtyActionDialog("conflicted", target);
			return;
		}
		if (hasUntrackedFiles) {
			openDirtyActionDialog("dirty-untracked", target);
			return;
		}
		if (hasUncommittedChanges) {
			openDirtyActionDialog("dirty-uncommitted", target);
			return;
		}
		runTargetAction(target);
	};

	const handleCompareBaseSelect = (branch: string | null) => {
		updateBaseBranch.mutate({
			worktreePath,
			baseBranch:
				branch && branch !== branchData?.defaultBranch ? branch : null,
		});
		resetSelectorState();
	};

	const canCreateBranch =
		mode === "create" &&
		createBranchName.length > 0 &&
		!isCreateBranchNameTaken;

	const renderDefaultList = () => (
		<>
			<CommandGroup heading="Actions">
				<CommandItem
					onSelect={() => {
						setMode("create");
						setSelectedStartPoint(null);
					}}
					className="gap-2 text-xs"
				>
					<LuPlus className="size-3.5 shrink-0" />
					<span>Create new branch...</span>
				</CommandItem>
				<CommandItem
					onSelect={() => {
						setMode("create-from-ref");
						setSelectedStartPoint(null);
					}}
					className="gap-2 text-xs"
				>
					<LuPlus className="size-3.5 shrink-0" />
					<span>Create new branch from...</span>
				</CommandItem>
				<CommandItem
					onSelect={() => {
						if (!effectiveCurrentBranch) {
							setDialogState({ kind: "compare-detached-head" });
							setOpen(false);
							return;
						}
						setMode("compare-base");
						setSearch("");
					}}
					className="gap-2 text-xs"
				>
					<VscGitCompare className="size-3.5 shrink-0" />
					<span>Change compare branch...</span>
				</CommandItem>
			</CommandGroup>
			{localBranchResults.length > 0 ? (
				<CommandGroup heading="Branches">
					{localBranchResults.map((branch) => {
						const isCurrent = branch.name === effectiveCurrentBranch;
						const checkedOutPath = branch.checkedOutPath;
						const isDisabled = !!checkedOutPath && !isCurrent;

						return (
							<BranchRefCommandItem
								key={`local:${branch.displayName}`}
								refItem={branch}
								onSelect={() => handleBranchSelect(branch.name)}
								isCurrent={isCurrent}
								isDefault={branch.name === branchData?.defaultBranch}
								isDisabled={isDisabled}
								statusLabel={
									checkedOutPath && !isCurrent ? "checked out" : null
								}
							/>
						);
					})}
				</CommandGroup>
			) : null}
			{remoteBranchResults.length > 0 ? (
				<CommandGroup heading="Remote Branches">
					{remoteBranchResults.map((branch) => {
						const isCurrent = branch.name === effectiveCurrentBranch;
						const checkedOutPath = branch.checkedOutPath;
						const isDisabled = !!checkedOutPath && !isCurrent;

						return (
							<BranchRefCommandItem
								key={`remote:${branch.displayName}`}
								refItem={branch}
								onSelect={() => handleBranchSelect(branch.name)}
								isCurrent={isCurrent}
								isDefault={branch.name === branchData?.defaultBranch}
								isDisabled={isDisabled}
								statusLabel={
									checkedOutPath && !isCurrent ? "checked out" : null
								}
							/>
						);
					})}
				</CommandGroup>
			) : null}
		</>
	);

	const renderCreateList = () => (
		<>
			<CommandItem
				onSelect={() => {
					setMode(selectedStartPoint ? "create-from-ref" : "default");
					setSearch("");
					setSelectedStartPoint(null);
				}}
				className="gap-2 text-xs"
			>
				<LuArrowLeft className="size-3.5 shrink-0" />
				<span>Back</span>
			</CommandItem>
			{selectedStartPoint ? (
				<div className="px-3 py-2 text-[11px] text-muted-foreground">
					<div className="mb-1">Start point</div>
					<div className="flex items-center gap-2 font-mono text-foreground">
						{getSearchableRefIcon(selectedStartPoint)}
						<BranchNameWithOverflowTooltip
							key={selectedStartPoint.displayName}
							name={selectedStartPoint.displayName}
						/>
					</div>
				</div>
			) : null}
			{createBranchName ? (
				<CommandItem
					onSelect={handleCreateBranch}
					disabled={!canCreateBranch || createBranch.isPending}
					className="flex items-center justify-between gap-3 text-xs"
				>
					<span className="flex min-w-0 items-center gap-2 truncate">
						<LuPlus className="size-3.5 shrink-0" />
						<span className="truncate font-mono">{createBranchName}</span>
					</span>
					<span className="shrink-0 text-muted-foreground">
						{isCreateBranchNameTaken ? "exists" : "create"}
					</span>
				</CommandItem>
			) : null}
		</>
	);

	const renderCreateFromRefList = () => (
		<>
			<CommandItem
				onSelect={() => {
					setMode("default");
					setSearch("");
					setSelectedStartPoint(null);
				}}
				className="gap-2 text-xs"
			>
				<LuArrowLeft className="size-3.5 shrink-0" />
				<span>Back</span>
			</CommandItem>
			{localBranchResults.length > 0 ? (
				<CommandGroup heading="Branches">
					{localBranchResults.map((ref) => (
						<BranchRefCommandItem
							key={`create-local:${ref.displayName}`}
							refItem={ref}
							onSelect={() => {
								setSelectedStartPoint(ref);
								setMode("create");
								setSearch("");
							}}
							isDefault={ref.name === branchData?.defaultBranch}
						/>
					))}
				</CommandGroup>
			) : null}
			{remoteBranchResults.length > 0 ? (
				<CommandGroup heading="Remote Branches">
					{remoteBranchResults.map((ref) => (
						<BranchRefCommandItem
							key={`create-remote:${ref.displayName}`}
							refItem={ref}
							onSelect={() => {
								setSelectedStartPoint(ref);
								setMode("create");
								setSearch("");
							}}
							isDefault={ref.name === branchData?.defaultBranch}
						/>
					))}
				</CommandGroup>
			) : null}
			{tagResults.length > 0 ? (
				<CommandGroup heading="Tags">
					{tagResults.map((ref) => (
						<BranchRefCommandItem
							key={`create-tag:${ref.displayName}`}
							refItem={ref}
							onSelect={() => {
								setSelectedStartPoint(ref);
								setMode("create");
								setSearch("");
							}}
						/>
					))}
				</CommandGroup>
			) : null}
		</>
	);

	const renderCompareBaseList = () => (
		<>
			<CommandItem
				onSelect={() => {
					setMode("default");
					setSearch("");
				}}
				className="gap-2 text-xs"
			>
				<LuArrowLeft className="size-3.5 shrink-0" />
				<span>Back</span>
			</CommandItem>
			<CommandGroup heading="Compare Branches">
				<CommandItem
					onSelect={() =>
						handleCompareBaseSelect(branchData?.defaultBranch ?? null)
					}
					className="flex items-center justify-between gap-3 text-xs"
				>
					<span className="truncate">
						{branchData?.defaultBranch ?? "main"}
						<span className="ml-1 text-muted-foreground">(default)</span>
					</span>
					{effectiveBaseBranch === branchData?.defaultBranch ? (
						<VscCheck className="size-3.5 shrink-0 text-primary" />
					) : null}
				</CommandItem>
				{compareBaseBranches.map((branch) => (
					<CommandItem
						key={`compare:${branch}`}
						value={branch}
						onSelect={() => handleCompareBaseSelect(branch)}
						className="flex items-center justify-between gap-3 text-xs"
					>
						<span className="truncate">{branch}</span>
						{branch === effectiveBaseBranch ? (
							<VscCheck className="size-3.5 shrink-0 text-primary" />
						) : null}
					</CommandItem>
				))}
			</CommandGroup>
		</>
	);

	const isPopoverLoading =
		isLoading ||
		((mode === "default" || mode === "create-from-ref") && isRefSearchLoading);
	const commandEmptyCopy =
		mode === "create"
			? "Enter a branch name"
			: mode === "create-from-ref"
				? "No refs found"
				: mode === "compare-base"
					? "No branches found"
					: "No branches found";
	const inputPlaceholder =
		mode === "create"
			? "New branch name"
			: mode === "create-from-ref"
				? "Search branches or tags..."
				: mode === "compare-base"
					? "Search compare branches..."
					: "Search branches...";

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(nextOpen) => {
					setOpen(nextOpen);
					if (!nextOpen) {
						setSearch("");
						setMode("default");
						setSelectedStartPoint(null);
					}
				}}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>
							<BranchSelectorButton
								label={effectiveCurrentBranch ?? "detached HEAD"}
								disabled={isLoading}
							/>
						</PopoverTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Switch current branch
					</TooltipContent>
				</Tooltip>
				<PopoverContent
					align="start"
					className="w-96 p-0"
					onWheel={(event) => event.stopPropagation()}
				>
					<Command shouldFilter={false}>
						<CommandInput
							placeholder={inputPlaceholder}
							value={search}
							onValueChange={setSearch}
						/>
						<CommandList className="max-h-[320px]">
							<CommandEmpty>
								{isPopoverLoading ? "Loading..." : commandEmptyCopy}
							</CommandEmpty>
							{mode === "default"
								? renderDefaultList()
								: mode === "create"
									? renderCreateList()
									: mode === "create-from-ref"
										? renderCreateFromRefList()
										: renderCompareBaseList()}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>

			<BranchActionDialog
				open={dialogState !== null}
				state={dialogState}
				isPending={
					switchBranch.isPending ||
					createBranch.isPending ||
					updateBaseBranch.isPending ||
					isStashPending
				}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						setDialogState(null);
					}
				}}
				onContinueWithoutStash={() => {
					if (dialogState?.target) {
						runTargetAction(dialogState.target);
					}
				}}
				onStashTrackedAndContinue={() => {
					if (!dialogState?.target) {
						return;
					}
					void onStashAsync()
						.then(() => {
							runTargetAction(dialogState.target as BranchActionTarget);
						})
						.catch((error) => {
							handleStashFailure(
								dialogState.target as BranchActionTarget,
								error,
							);
						});
				}}
				onStashAllAndContinue={() => {
					if (!dialogState?.target) {
						return;
					}
					void onStashIncludeUntrackedAsync()
						.then(() => {
							runTargetAction(dialogState.target as BranchActionTarget);
						})
						.catch((error) => {
							handleStashFailure(
								dialogState.target as BranchActionTarget,
								error,
							);
						});
				}}
			/>
		</>
	);
}

function GitGraphButton({
	isOpen,
	onToggle,
}: {
	isOpen: boolean;
	onToggle: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={onToggle}
					className={cn("size-6 p-0", isOpen && "bg-accent text-foreground")}
				>
					<VscGitCompare className="size-4" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top" showArrow={false}>
				Toggle Git Graph
			</TooltipContent>
		</Tooltip>
	);
}

function StashDropdown({
	onStash,
	onStashIncludeUntracked,
	onStashPop,
	isPending,
}: {
	onStash: () => void;
	onStashIncludeUntracked: () => void;
	onStashPop: () => void;
	isPending: boolean;
}) {
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-6 p-0"
							disabled={isPending}
						>
							<VscGitStash className="size-4" />
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent side="top" showArrow={false}>
					Stash operations
				</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="start" className="w-52">
				<DropdownMenuItem onClick={onStash} className="text-xs">
					<VscGitStash className="size-4" />
					Stash Changes
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onStashIncludeUntracked} className="text-xs">
					<VscGitStash className="size-4" />
					Stash (Include Untracked)
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={onStashPop} className="text-xs">
					<VscGitStashApply className="size-4" />
					Pop Stash
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function FetchRemoteButton({
	worktreePath,
	onRefresh,
}: {
	worktreePath: string;
	onRefresh: () => void;
}) {
	const utils = electronTrpc.useUtils();
	const [isDisabled, setIsDisabled] = useState(false);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	const fetchMutation = electronTrpc.changes.fetch.useMutation({
		onSuccess: () => {
			void utils.changes.getBranches.invalidate({ worktreePath });
			void utils.changes.getStatus.invalidate();
			void utils.changes.searchRefs.invalidate();
			onRefresh();
		},
		onError: (error) => {
			toast.error("Fetch failed", {
				description: error.message,
			});
		},
		onSettled: () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => setIsDisabled(false), 600);
		},
	});

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	const handleClick = () => {
		setIsDisabled(true);
		fetchMutation.mutate({ worktreePath });
	};

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={handleClick}
					disabled={isDisabled}
					className="size-6 p-0"
				>
					<IoCloudDownloadOutline className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top" showArrow={false}>
				Fetch remote
			</TooltipContent>
		</Tooltip>
	);
}

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
	const [isSpinning, setIsSpinning] = useState(false);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	const handleClick = () => {
		setIsSpinning(true);
		onRefresh();
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = setTimeout(() => setIsSpinning(false), 600);
	};

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={handleClick}
					disabled={isSpinning}
					className="size-6 p-0"
				>
					<VscRefresh
						className={`size-3.5 ${isSpinning ? "animate-spin" : ""}`}
					/>
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top" showArrow={false}>
				Refresh changes
			</TooltipContent>
		</Tooltip>
	);
}

export function ChangesHeader({
	onRefresh,
	viewMode,
	onViewModeChange,
	showViewModeToggle = true,
	worktreePath,
	currentBranch,
	pr,
	isPRStatusLoading,
	canCreatePR,
	createPRBlockedReason,
	onStash,
	onStashAsync,
	onStashIncludeUntracked,
	onStashIncludeUntrackedAsync,
	onStashPop,
	isStashPending,
	onGenerateCommitMessage,
	isGeneratingCommitMessage,
	hasUncommittedChanges,
	hasUntrackedFiles,
	hasConflictedFiles,
	isGitGraphOpen,
	onToggleGitGraph,
}: ChangesHeaderProps) {
	return (
		<div className="flex flex-col border-b border-border">
			<div className="flex items-center gap-0.5 px-2 py-1.5">
				<GitGraphButton isOpen={isGitGraphOpen} onToggle={onToggleGitGraph} />
				<StashDropdown
					onStash={onStash}
					onStashIncludeUntracked={onStashIncludeUntracked}
					onStashPop={onStashPop}
					isPending={isStashPending}
				/>
				{showViewModeToggle && (
					<ViewModeToggle
						viewMode={viewMode}
						onViewModeChange={onViewModeChange}
					/>
				)}
				<FetchRemoteButton worktreePath={worktreePath} onRefresh={onRefresh} />
				<RefreshButton onRefresh={onRefresh} />
				<PRButton
					pr={pr}
					isLoading={isPRStatusLoading}
					canCreatePR={canCreatePR}
					createPRBlockedReason={createPRBlockedReason}
					worktreePath={worktreePath}
					onRefresh={onRefresh}
				/>
			</div>
			<div className="flex items-center gap-0.5 px-2 pb-1.5 min-w-0">
				<div className="min-w-0">
					<CurrentBranchSelector
						worktreePath={worktreePath}
						currentBranch={currentBranch}
						hasUncommittedChanges={hasUncommittedChanges}
						hasUntrackedFiles={hasUntrackedFiles}
						hasConflictedFiles={hasConflictedFiles}
						isStashPending={isStashPending}
						onStashAsync={onStashAsync}
						onStashIncludeUntrackedAsync={onStashIncludeUntrackedAsync}
						onRefresh={onRefresh}
					/>
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							className="ml-auto rounded p-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed"
							disabled={isGeneratingCommitMessage}
							onClick={onGenerateCommitMessage}
						>
							<VscSparkle
								className={`size-3.5 ${isGeneratingCommitMessage ? "animate-pulse" : ""}`}
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Generate commit message with AI
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
