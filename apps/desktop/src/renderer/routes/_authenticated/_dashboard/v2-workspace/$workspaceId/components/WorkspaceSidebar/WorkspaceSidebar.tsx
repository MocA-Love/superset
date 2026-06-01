import type { PullRequestComment } from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	LuBox,
	LuCircleAlert,
	LuDatabase,
	LuFile,
	LuGitCompareArrows,
	LuSearch,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceGitStatus } from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/providers/WorkspaceGitStatusProvider";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { ChangesView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView";
import { DatabasesView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/DatabasesView";
import { DockerView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/DockerView";
import { ProblemsView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/ProblemsView";
import { SearchView } from "renderer/screens/main/components/WorkspaceView/RightSidebar/SearchView";
import { WorkspaceIdProvider } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";
import type { ChangeCategory, ChangedFile } from "shared/changes-types";
import type { ActionLogsJob } from "shared/tabs-types";
import type { CommentPaneData, DiffFocusSide } from "../../types";
import { FilesTab } from "./components/FilesTab";
import { SidebarHeader } from "./components/SidebarHeader";
import type { SidebarTabDefinition } from "./types";

type SidebarTabId =
	| "changes"
	| "docker"
	| "files"
	| "search"
	| "problems"
	| "databases";

const VALID_TAB_IDS: readonly SidebarTabId[] = [
	"changes",
	"docker",
	"files",
	"search",
	"problems",
	"databases",
];

function isSidebarTabId(tab: string): tab is SidebarTabId {
	return (VALID_TAB_IDS as readonly string[]).includes(tab);
}

export interface PendingReveal {
	path: string;
	isDirectory: boolean;
}

interface WorkspaceSidebarProps {
	onSelectFile: (absolutePath: string, openInNewTab?: boolean) => void;
	onSelectDiffFile?: (
		path: string,
		openInNewTab?: boolean,
		line?: number,
		side?: DiffFocusSide,
	) => void;
	onOpenComment?: (comment: CommentPaneData) => void;
	onSearch?: () => void;
	onOpenDatabaseExplorer?: (connectionId: string) => void;
	onOpenFileAtLine?: (path: string, line?: number, column?: number) => void;
	onOpenUrl?: (url: string) => void;
	onOpenActionLogs?: (jobs: ActionLogsJob[], initialJobIndex?: number) => void;
	isGitGraphOpen?: boolean;
	onOpenGitGraph?: () => void;
	onOpenCommandInTerminal?: (args: {
		command: string;
		cwd?: string;
		title: string;
	}) => void | Promise<void>;
	selectedFilePath?: string;
	pendingReveal?: PendingReveal | null;
	workspaceId: string;
	worktreePath: string;
	projectId: string;
	workspaceBranch?: string | null;
}

function IconButton({
	icon: Icon,
	tooltip,
	onClick,
}: {
	icon: React.ComponentType<{ className?: string }>;
	tooltip: string;
	onClick?: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					onClick={onClick}
				>
					<Icon className="size-3.5" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export function WorkspaceSidebar({
	onSelectFile,
	onSelectDiffFile,
	onOpenComment,
	onSearch,
	onOpenDatabaseExplorer,
	onOpenFileAtLine,
	onOpenUrl,
	onOpenActionLogs,
	isGitGraphOpen,
	onOpenGitGraph,
	onOpenCommandInTerminal,
	selectedFilePath,
	pendingReveal,
	workspaceId,
	worktreePath,
	projectId,
	workspaceBranch,
}: WorkspaceSidebarProps) {
	const gitStatus = useWorkspaceGitStatus();
	const collections = useCollections();
	// FORK NOTE: keep reactive `useLiveQuery` against
	// `v2WorkspaceLocalState` so persisted sidebar tab + changes subtab
	// updates render immediately (`.get()` is a snapshot and would not
	// invalidate). upstream #3777 narrows the type to SidebarTabId.
	const { data: localStateRows = [] } = useLiveQuery(
		(query) =>
			query
				.from({ state: collections.v2WorkspaceLocalState })
				.where(({ state }) => eq(state.workspaceId, workspaceId)),
		[collections, workspaceId],
	);
	const localState = localStateRows[0];
	const activeTab: SidebarTabId =
		localState && isSidebarTabId(localState.sidebarState.activeTab)
			? localState.sidebarState.activeTab
			: "changes";

	const setActiveTab = useCallback(
		(tab: string) => {
			if (!isSidebarTabId(tab)) return;
			if (!collections.v2WorkspaceLocalState.get(workspaceId)) return;
			collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
				draft.sidebarState.activeTab = tab;
			});
		},
		[collections, workspaceId],
	);

	const containerRef = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const width = entry.contentRect.width;
			// Hysteresis: expand back to labels only once we're clearly past
			// the breakpoint, so the labels don't jitter on the edge.
			setCompact((prev) => (prev ? width < 520 : width < 500));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const trpcUtils = electronTrpc.useUtils();
	const { data: workspaceDiagnostics } =
		electronTrpc.languageServices.getWorkspaceDiagnostics.useQuery(
			{ workspaceId },
			{
				enabled: Boolean(workspaceId),
				staleTime: Infinity,
			},
		);
	const dockerComposeFilesQuery = electronTrpc.docker.getComposeFiles.useQuery(
		{ workspaceId },
		{
			enabled: Boolean(workspaceId),
			staleTime: 10000,
		},
	);
	electronTrpc.languageServices.subscribeDiagnostics.useSubscription(
		{ workspaceId },
		{
			enabled: Boolean(workspaceId),
			onData: () => {
				void trpcUtils.languageServices.getWorkspaceDiagnostics.invalidate({
					workspaceId,
				});
			},
		},
	);

	const handleOpenFileAtLine = useCallback(
		(path: string, line?: number, column?: number) => {
			if (onOpenFileAtLine) {
				onOpenFileAtLine(path, line, column);
				return;
			}
			onSelectFile(path);
		},
		[onOpenFileAtLine, onSelectFile],
	);

	const handleChangeFileOpen = useCallback(
		(file: ChangedFile, category: ChangeCategory, commitHash?: string) => {
			if (collections.v2WorkspaceLocalState.get(workspaceId)) {
				collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
					draft.sidebarState.changesFilter =
						category === "committed" && commitHash
							? { kind: "commit", hash: commitHash }
							: { kind: "all" };
				});
			}
			if (onSelectDiffFile) {
				onSelectDiffFile(file.path);
				return;
			}
			if (!worktreePath) return;
			onSelectFile(toAbsoluteWorkspacePath(worktreePath, file.path));
		},
		[collections, onSelectDiffFile, onSelectFile, workspaceId, worktreePath],
	);
	const handleOpenReviewComment = useCallback(
		(comment: PullRequestComment) => {
			onOpenComment?.({
				commentId: comment.id,
				authorLogin: comment.authorLogin,
				avatarUrl: comment.avatarUrl,
				body: comment.body,
				url: comment.url,
				path: comment.path,
				line: comment.line,
			});
		},
		[onOpenComment],
	);
	const totalChanges =
		(gitStatus.data?.againstBase.length ?? 0) +
		(gitStatus.data?.staged.length ?? 0) +
		(gitStatus.data?.unstaged.length ?? 0);
	const changesTab: SidebarTabDefinition = {
		id: "changes",
		label: "Git",
		icon: LuGitCompareArrows,
		badge: totalChanges > 0 ? totalChanges : undefined,
		content: (
			<ChangesView
				onFileOpen={handleChangeFileOpen}
				onOpenFileAtLine={handleOpenFileAtLine}
				onOpenComment={handleOpenReviewComment}
				onOpenUrl={onOpenUrl}
				onOpenActionLogs={onOpenActionLogs}
				isGitGraphOpen={isGitGraphOpen}
				onToggleGitGraph={onOpenGitGraph}
				workspaceOverride={{
					worktreePath,
					projectId,
					branch: workspaceBranch,
				}}
				isActive={activeTab === "changes"}
			/>
		),
	};

	const filesTab: SidebarTabDefinition = {
		id: "files",
		label: "Files",
		icon: LuFile,
		actions: <IconButton icon={Search} tooltip="Search" onClick={onSearch} />,
		content: (
			<FilesTab
				onSelectFile={onSelectFile}
				selectedFilePath={selectedFilePath}
				pendingReveal={pendingReveal}
				workspaceId={workspaceId}
				gitStatus={gitStatus.data}
			/>
		),
	};

	const searchTab: SidebarTabDefinition = {
		id: "search",
		label: "Search",
		icon: LuSearch,
		content: (
			<SearchView
				isActive={activeTab === "search"}
				onOpenFileAtLine={handleOpenFileAtLine}
			/>
		),
	};

	const problemErrorCount = workspaceDiagnostics?.summary.errorCount ?? 0;
	const problemCount =
		problemErrorCount +
		(workspaceDiagnostics?.summary.warningCount ?? 0) +
		(workspaceDiagnostics?.summary.infoCount ?? 0) +
		(workspaceDiagnostics?.summary.hintCount ?? 0);
	const problemsTab: SidebarTabDefinition = {
		id: "problems",
		label: "Problems",
		icon: LuCircleAlert,
		badge: problemCount > 0 ? problemCount : undefined,
		content: (
			<ProblemsView
				isActive={activeTab === "problems"}
				onOpenFileAtLine={(path, line) => handleOpenFileAtLine(path, line)}
			/>
		),
	};

	const dockerComposeFiles = dockerComposeFilesQuery.data;
	const isResolvingDockerVisibility =
		activeTab === "docker" && dockerComposeFilesQuery.status === "pending";
	const showDockerTab = isResolvingDockerVisibility
		? true
		: (dockerComposeFiles?.composeFiles.length ?? 0) > 0 ||
			(dockerComposeFiles?.dockerfiles?.length ?? 0) > 0;
	const dockerTab: SidebarTabDefinition = {
		id: "docker",
		label: "Docker",
		icon: LuBox,
		content: (
			<DockerView
				isActive={activeTab === "docker"}
				onOpenCommandInTerminal={onOpenCommandInTerminal}
			/>
		),
	};

	const databasesTab: SidebarTabDefinition = {
		id: "databases",
		label: "Databases",
		icon: LuDatabase,
		content: (
			<DatabasesView
				workspaceId={workspaceId}
				onOpenExplorer={onOpenDatabaseExplorer}
			/>
		),
	};

	const tabs: SidebarTabDefinition[] = [
		changesTab,
		...(showDockerTab ? [dockerTab] : []),
		filesTab,
		searchTab,
		problemsTab,
		databasesTab,
	];
	const activeTabDef = tabs.find((t) => t.id === activeTab);
	const activeTabDefId = activeTabDef?.id;
	const fallbackTabId = tabs[0]?.id;

	useEffect(() => {
		if (activeTabDefId || isResolvingDockerVisibility) return;
		if (fallbackTabId) setActiveTab(fallbackTabId);
	}, [
		activeTabDefId,
		fallbackTabId,
		isResolvingDockerVisibility,
		setActiveTab,
	]);

	return (
		<WorkspaceIdProvider value={workspaceId}>
			<div
				ref={containerRef}
				className="isolate flex h-full w-full min-h-0 flex-col overflow-hidden bg-background"
			>
				<SidebarHeader
					tabs={tabs}
					activeTab={activeTab}
					onTabChange={setActiveTab}
					compact={compact}
				/>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					{activeTabDef?.content}
				</div>
			</div>
		</WorkspaceIdProvider>
	);
}
