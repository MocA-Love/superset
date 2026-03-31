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
import { type ButtonHTMLAttributes, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { LuChevronDown } from "react-icons/lu";
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
	{ label: string; disabled?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>
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

function BaseBranchSelector({ worktreePath }: { worktreePath: string }) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
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

	const updateBaseBranch = electronTrpc.changes.updateBaseBranch.useMutation({
		onSuccess: () => {
			utils.changes.getBranches.invalidate({ worktreePath });
		},
	});

	const effectiveBaseBranch =
		branchData?.worktreeBaseBranch ?? branchData?.defaultBranch ?? "main";
	const sortedBranches = useMemo(() => {
		return [...(branchData?.remote ?? [])].sort((a, b) => {
			if (a === effectiveBaseBranch) return -1;
			if (b === effectiveBaseBranch) return 1;
			if (a === branchData?.defaultBranch) return -1;
			if (b === branchData?.defaultBranch) return 1;
			return a.localeCompare(b);
		});
	}, [branchData?.remote, branchData?.defaultBranch, effectiveBaseBranch]);

	const filteredBranches = useMemo(() => {
		if (!search) return sortedBranches.filter(Boolean);
		const lower = search.toLowerCase();
		return sortedBranches.filter((branch) =>
			branch?.toLowerCase().includes(lower),
		);
	}, [sortedBranches, search]);

	const handleBranchSelect = (branch: string) => {
		updateBaseBranch.mutate({
			worktreePath,
			baseBranch: branch === branchData?.defaultBranch ? null : branch,
		});
		setOpen(false);
		setSearch("");
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<BranchSelectorButton
							label={effectiveBaseBranch}
							disabled={isLoading}
						/>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					Change base branch
				</TooltipContent>
			</Tooltip>
			<PopoverContent align="start" className="w-56 p-0">
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search branches..."
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList className="max-h-[200px]">
						<CommandEmpty>No branches found</CommandEmpty>
						{filteredBranches.map((branch) => (
							<CommandItem
								key={branch}
								value={branch}
								onSelect={() => handleBranchSelect(branch)}
								className="flex items-center justify-between text-xs"
							>
								<span className="truncate">
									{branch}
									{branch === branchData?.defaultBranch && (
										<span className="ml-1 text-muted-foreground">
											(default)
										</span>
									)}
								</span>
								{branch === effectiveBaseBranch && (
									<VscCheck className="size-3.5 shrink-0 text-primary" />
								)}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function CurrentBranchSelector({
	worktreePath,
	hasUncommittedChanges,
}: {
	worktreePath: string;
	hasUncommittedChanges: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
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

	const switchBranch = electronTrpc.changes.switchBranch.useMutation({
		onSuccess: () => {
			utils.changes.getBranches.invalidate({ worktreePath });
		},
		onError: (error) => {
			const msg = error.message ?? "";
			if (
				msg.includes("overwritten") ||
				msg.includes("conflict") ||
				msg.includes("Please commit") ||
				msg.includes("would be overwritten")
			) {
				toast.error(
					"Could not switch branch. Your uncommitted changes conflict with the target branch. Please commit or stash your changes and try again.",
				);
			} else {
				toast.error(`Failed to switch branch: ${msg}`);
			}
		},
	});

	const currentBranch = branchData?.currentBranch ?? null;

	const sortedLocal = useMemo(() => {
		return [...(branchData?.local ?? [])].sort((a, b) => {
			if (a.branch === currentBranch) return -1;
			if (b.branch === currentBranch) return 1;
			return b.lastCommitDate - a.lastCommitDate;
		});
	}, [branchData?.local, currentBranch]);

	const filteredLocal = useMemo(() => {
		if (!search) return sortedLocal;
		const lower = search.toLowerCase();
		return sortedLocal.filter((b) => b.branch.toLowerCase().includes(lower));
	}, [sortedLocal, search]);

	const doSwitch = (branch: string) => {
		switchBranch.mutate({ worktreePath, branch });
		setOpen(false);
		setSearch("");
		setPendingBranch(null);
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

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<Tooltip>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>
							<BranchSelectorButton
								label={currentBranch ?? "…"}
								disabled={isLoading}
							/>
						</PopoverTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						Switch current branch
					</TooltipContent>
				</Tooltip>
				<PopoverContent align="start" className="w-56 p-0">
					<Command shouldFilter={false}>
						<CommandInput
							placeholder="Search branches..."
							value={search}
							onValueChange={setSearch}
						/>
						<CommandList className="max-h-[200px]">
							<CommandEmpty>No branches found</CommandEmpty>
							{filteredLocal.map(({ branch }) => (
								<CommandItem
									key={branch}
									value={branch}
									onSelect={() => handleBranchSelect(branch)}
									className="flex items-center justify-between text-xs"
								>
									<span className="truncate">{branch}</span>
									{branch === currentBranch && (
										<VscCheck className="size-3.5 shrink-0 text-primary" />
									)}
								</CommandItem>
							))}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>

			<AlertDialog
				open={pendingBranch !== null}
				onOpenChange={(open) => { if (!open) setPendingBranch(null); }}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>You have uncommitted changes</AlertDialogTitle>
						<AlertDialogDescription>
							Switching to <span className="font-mono font-medium">{pendingBranch}</span> may cause your uncommitted changes to be lost.
							<br /><br />
							If you want to keep your changes, please commit or stash them first.
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

function GitGraphButton({ isOpen, onToggle }: { isOpen: boolean; onToggle: () => void }) {
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
				<div className="shrink-0">
					<BaseBranchSelector worktreePath={worktreePath} />
				</div>
				<span className="shrink-0 text-xs text-muted-foreground/50">→</span>
				<div className="min-w-0 flex-1">
					<CurrentBranchSelector
						worktreePath={worktreePath}
						hasUncommittedChanges={hasUncommittedChanges}
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
