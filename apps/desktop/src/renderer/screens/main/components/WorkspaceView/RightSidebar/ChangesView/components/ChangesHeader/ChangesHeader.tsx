import type { GitHubStatus } from "@superset/local-db";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import {
	Command,
	CommandEmpty,
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
import { GoGitBranch } from "react-icons/go";
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
import type { ChangesViewMode } from "../../types";
import { ViewModeToggle } from "../ViewModeToggle";
import { PRButton } from "./components/PRButton";

const BRANCH_QUERY_STALE_TIME_MS = 10_000;

interface ChangesHeaderProps {
	onRefresh: () => void;
	viewMode: ChangesViewMode;
	onViewModeChange: (mode: ChangesViewMode) => void;
	showViewModeToggle?: boolean;
	worktreePath: string;
	pr: GitHubStatus["pr"] | null;
	isPRStatusLoading: boolean;
	canCreatePR: boolean;
	createPRBlockedReason: string | null;
	onStash: () => void;
	onStashIncludeUntracked: () => void;
	onStashPop: () => void;
	isStashPending: boolean;
	onGenerateCommitMessage: () => void;
	isGeneratingCommitMessage: boolean;
	hasUncommittedChanges: boolean;
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
	ref: string;
	kind: "branch" | "tag";
	lastCommitDate: number;
	isLocal: boolean;
	isRemote: boolean;
	checkedOutPath: string | null;
}

function CurrentBranchSelector({
	worktreePath,
	hasUncommittedChanges,
	onRefresh,
}: {
	worktreePath: string;
	hasUncommittedChanges: boolean;
	onRefresh: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [mode, setMode] = useState<CurrentBranchSelectorMode>("default");
	const [selectedStartPoint, setSelectedStartPoint] =
		useState<SearchableRefItem | null>(null);
	const [pendingBranch, setPendingBranch] = useState<string | null>(null);
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

	const switchBranch = electronTrpc.changes.switchBranch.useMutation({
		onSuccess: () => {
			invalidateBranchQueries();
		},
		onError: (error) => {
			const msg = error.message ?? "";
			// Check for uncommitted changes conflict in multiple languages
			// (git error messages vary by LANG environment variable)
			const isUncommittedConflict =
				msg.includes("overwritten") ||
				msg.includes("conflict") ||
				msg.includes("Please commit") ||
				msg.includes("would be overwritten") ||
				// Japanese git messages
				msg.includes("上書き") ||
				msg.includes("コミット") ||
				msg.includes("スタッシュ");
			if (isUncommittedConflict) {
				toast.error(
					"Could not switch branch. Your uncommitted changes conflict with the target branch. Please commit or stash your changes and try again.",
				);
			} else {
				toast.error(`Failed to switch branch: ${msg}`);
			}
		},
	});
	const createBranch = electronTrpc.changes.createBranch.useMutation({
		onSuccess: () => {
			invalidateBranchQueries();
		},
		onError: (error) => {
			toast.error(
				`Failed to create branch: ${error.message ?? "Unknown error"}`,
			);
		},
	});
	const updateBaseBranch = electronTrpc.changes.updateBaseBranch.useMutation({
		onSuccess: () => {
			invalidateBranchQueries();
		},
		onError: (error) => {
			toast.error(
				`Failed to update compare branch: ${error.message ?? "Unknown error"}`,
			);
		},
	});

	const currentBranch = branchData?.currentBranch ?? null;
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

	const createBranchName = search.trim();
	const isCreateBranchNameTaken = existingBranchNames.has(
		createBranchName.toLowerCase(),
	);

	const doSwitch = (branch: string) => {
		switchBranch.mutate({ worktreePath, branch });
		resetState();
	};

	const handleBranchSelect = (branch: string) => {
		if (branch === currentBranch) {
			setOpen(false);
			return;
		}
		if (hasUncommittedChanges) {
			setPendingBranch(branch);
			setOpen(false);
		} else {
			doSwitch(branch);
		}
	};

	const handleCreateBranch = () => {
		if (!createBranchName || isCreateBranchNameTaken) {
			return;
		}
		createBranch.mutate({
			worktreePath,
			branch: createBranchName,
			startPoint: selectedStartPoint?.ref,
		});
		resetState();
	};

	const handleCompareBaseSelect = (branch: string | null) => {
		updateBaseBranch.mutate({
			worktreePath,
			baseBranch:
				branch && branch !== branchData?.defaultBranch ? branch : null,
		});
		resetState();
	};

	const resetState = () => {
		setOpen(false);
		setSearch("");
		setMode("default");
		setSelectedStartPoint(null);
		setPendingBranch(null);
	};

	const canCreateBranch =
		mode === "create" &&
		createBranchName.length > 0 &&
		!isCreateBranchNameTaken;

	const renderDefaultList = () => (
		<>
			<CommandItem
				onSelect={() => {
					setMode("create");
					setSearch("");
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
					setSearch("");
					setSelectedStartPoint(null);
				}}
				className="gap-2 text-xs"
			>
				<LuPlus className="size-3.5 shrink-0" />
				<span>Create new branch from...</span>
			</CommandItem>
			<CommandItem
				onSelect={() => {
					setMode("compare-base");
					setSearch("");
				}}
				className="gap-2 text-xs"
			>
				<VscGitCompare className="size-3.5 shrink-0" />
				<span>Change compare branch...</span>
			</CommandItem>
			<div className="mx-2 my-1 h-px bg-border" />
			{branchResults.map((branch) => {
				const isCurrent = branch.name === currentBranch;
				const checkedOutPath = branch.checkedOutPath;
				const isDisabled = !!checkedOutPath && !isCurrent;

				return (
					<CommandItem
						key={`branch:${branch.name}`}
						value={branch.name}
						onSelect={() => {
							if (!isDisabled) {
								handleBranchSelect(branch.name);
							}
						}}
						disabled={isDisabled}
						className="flex items-center justify-between gap-3 text-xs"
					>
						<span className="flex min-w-0 flex-1 items-center gap-2 truncate">
							<GoGitBranch className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="truncate font-mono">{branch.name}</span>
							{branch.name === branchData?.defaultBranch ? (
								<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
									default
								</span>
							) : null}
							{!branch.isLocal && branch.isRemote ? (
								<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
									remote
								</span>
							) : null}
						</span>
						<span className="flex shrink-0 items-center gap-2">
							{checkedOutPath && !isCurrent ? (
								<span className="text-[10px] text-muted-foreground">
									checked out
								</span>
							) : null}
							{isCurrent ? (
								<VscCheck className="size-3.5 shrink-0 text-primary" />
							) : null}
						</span>
					</CommandItem>
				);
			})}
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
						{selectedStartPoint.kind === "tag" ? (
							<LuTag className="size-3.5 shrink-0" />
						) : (
							<GoGitBranch className="size-3.5 shrink-0" />
						)}
						<span className="truncate">{selectedStartPoint.name}</span>
					</div>
				</div>
			) : null}
			<div className="mx-2 my-1 h-px bg-border" />
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
			<div className="mx-2 my-1 h-px bg-border" />
			{(refSearchData?.refs ?? []).map((ref) => (
				<CommandItem
					key={`${ref.kind}:${ref.ref}`}
					value={ref.name}
					onSelect={() => {
						setSelectedStartPoint(ref);
						setMode("create");
						setSearch("");
					}}
					className="flex items-center justify-between gap-3 text-xs"
				>
					<span className="flex min-w-0 items-center gap-2 truncate">
						{ref.kind === "tag" ? (
							<LuTag className="size-3.5 shrink-0 text-muted-foreground" />
						) : (
							<GoGitBranch className="size-3.5 shrink-0 text-muted-foreground" />
						)}
						<span className="truncate font-mono">{ref.name}</span>
					</span>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{ref.kind}
					</span>
				</CommandItem>
			))}
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
			<div className="mx-2 my-1 h-px bg-border" />
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
								label={currentBranch ?? "detached HEAD"}
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

			<AlertDialog
				open={pendingBranch !== null}
				onOpenChange={(open) => {
					if (!open) setPendingBranch(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>You have uncommitted changes</AlertDialogTitle>
						<AlertDialogDescription>
							Switching to{" "}
							<span className="font-mono font-medium">{pendingBranch}</span> may
							cause your uncommitted changes to be lost.
							<br />
							<br />
							If you want to keep your changes, please commit or stash them
							first.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => pendingBranch && doSwitch(pendingBranch)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Switch anyway
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
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
	pr,
	isPRStatusLoading,
	canCreatePR,
	createPRBlockedReason,
	onStash,
	onStashIncludeUntracked,
	onStashPop,
	isStashPending,
	onGenerateCommitMessage,
	isGeneratingCommitMessage,
	hasUncommittedChanges,
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
						hasUncommittedChanges={hasUncommittedChanges}
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
