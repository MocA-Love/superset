import {
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	MouseSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	horizontalListSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { IconType } from "react-icons";
import {
	LuBox,
	LuCircleAlert,
	LuDatabase,
	LuEllipsisVertical,
	LuExpand,
	LuFile,
	LuGitCompareArrows,
	LuSearch,
	LuShrink,
	LuX,
} from "react-icons/lu";
import { HotkeyTooltipContent } from "renderer/components/HotkeyTooltipContent";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import {
	RightSidebarTab,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { useTabsStore } from "renderer/stores/tabs/store";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";
import type { ChangeCategory, ChangedFile } from "shared/changes-types";
import { useScrollContext } from "../ChangesContent";
import { ChangesView } from "./ChangesView";
import { DatabasesView } from "./DatabasesView";
import { DockerView } from "./DockerView";
import { FilesView } from "./FilesView";
import { getSidebarHeaderTabButtonClassName } from "./headerTabStyles";
import { ProblemsView } from "./ProblemsView";
import { SearchView } from "./SearchView";

interface SidebarTabDefinition {
	id: RightSidebarTab;
	label: string;
	icon: IconType;
	hasAlert?: boolean;
}

const RIGHT_SIDEBAR_TAB_METADATA: Record<
	RightSidebarTab,
	Omit<SidebarTabDefinition, "hasAlert" | "id">
> = {
	[RightSidebarTab.Changes]: {
		label: "Git",
		icon: LuGitCompareArrows,
	},
	[RightSidebarTab.Docker]: {
		label: "Docker",
		icon: LuBox,
	},
	[RightSidebarTab.Files]: {
		label: "Files",
		icon: LuFile,
	},
	[RightSidebarTab.Search]: {
		label: "Search",
		icon: LuSearch,
	},
	[RightSidebarTab.Problems]: {
		label: "Problems",
		icon: LuCircleAlert,
	},
	[RightSidebarTab.Databases]: {
		label: "Databases",
		icon: LuDatabase,
	},
};

function TabButton({
	isActive,
	onClick,
	icon,
	label,
	compact,
	hasAlert,
	buttonRef,
	disableTooltip = false,
	tabIndex,
	ariaHidden,
	buttonProps,
}: {
	isActive: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	compact?: boolean;
	hasAlert?: boolean;
	buttonRef?: React.Ref<HTMLButtonElement>;
	disableTooltip?: boolean;
	tabIndex?: number;
	ariaHidden?: boolean;
	buttonProps?: React.ComponentPropsWithoutRef<"button">;
}) {
	const button = (
		<button
			{...buttonProps}
			ref={buttonRef}
			type="button"
			onClick={(event) => {
				buttonProps?.onClick?.(event);
				if (!event.defaultPrevented) {
					onClick();
				}
			}}
			tabIndex={buttonProps?.tabIndex ?? tabIndex}
			aria-hidden={buttonProps?.["aria-hidden"] ?? ariaHidden}
			className={getSidebarHeaderTabButtonClassName({
				isActive,
				compact,
			})}
		>
			<span className="relative inline-flex">
				{icon}
				{hasAlert ? (
					<span className="absolute -right-1 -top-1 size-2 rounded-full bg-red-500" />
				) : null}
			</span>
			{compact ? null : label}
		</button>
	);

	if (compact) {
		if (disableTooltip) {
			return button;
		}

		return (
			<Tooltip>
				<TooltipTrigger asChild>{button}</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					{label}
				</TooltipContent>
			</Tooltip>
		);
	}

	return button;
}

function SortableTabButton({
	tab,
	isActive,
	onClick,
	compact,
}: {
	tab: SidebarTabDefinition;
	isActive: boolean;
	onClick: () => void;
	compact?: boolean;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: tab.id,
	});

	const style = useMemo(
		() => ({
			transform: CSS.Transform.toString(transform),
			transition,
		}),
		[transform, transition],
	);
	const Icon = tab.icon;

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={isDragging ? "shrink-0 opacity-45" : "shrink-0"}
		>
			<TabButton
				isActive={isActive}
				onClick={onClick}
				icon={<Icon className="size-3.5" />}
				label={tab.label}
				compact={compact}
				hasAlert={tab.hasAlert}
				buttonProps={{
					...attributes,
					...listeners,
				}}
			/>
		</div>
	);
}

export function RightSidebar({ isActive = true }: { isActive?: boolean }) {
	const workspaceId = useWorkspaceId();
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: Boolean(workspaceId) && isActive },
	);
	const worktreePath = workspace?.worktreePath;
	const currentMode = useSidebarStore((s) => s.currentMode);
	const rightSidebarTab = useSidebarStore((s) => s.rightSidebarTab);
	const rightSidebarTabOrder = useSidebarStore((s) => s.rightSidebarTabOrder);
	const setRightSidebarTab = useSidebarStore((s) => s.setRightSidebarTab);
	const moveRightSidebarTab = useSidebarStore((s) => s.moveRightSidebarTab);
	const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);
	const setMode = useSidebarStore((s) => s.setMode);
	const sidebarWidth = useSidebarStore((s) => s.sidebarWidth);
	const isExpanded = currentMode === SidebarMode.Changes;
	const compactTabs = sidebarWidth < 250;
	const showChangesTab = !!worktreePath;
	const [hiddenTabIds, setHiddenTabIds] = useState<RightSidebarTab[]>([]);
	const tabsViewportRef = useRef<HTMLDivElement | null>(null);
	const measurementRef = useRef<HTMLDivElement | null>(null);
	const overflowMeasureRef = useRef<HTMLButtonElement | null>(null);
	const tabMeasureRefs = useRef<
		Partial<Record<RightSidebarTab, HTMLButtonElement | null>>
	>({});
	const trpcUtils = electronTrpc.useUtils();
	const { data: workspaceDiagnostics } =
		electronTrpc.languageServices.getWorkspaceDiagnostics.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{
				enabled: Boolean(workspaceId) && isActive,
				staleTime: Infinity,
			},
		);
	const dockerComposeFilesQuery = electronTrpc.docker.getComposeFiles.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: Boolean(workspaceId) && isActive,
			staleTime: 10000,
		},
	);
	const hasProblemErrors = (workspaceDiagnostics?.summary.errorCount ?? 0) > 0;
	const dockerComposeFiles = dockerComposeFilesQuery.data;
	const isResolvingDockerVisibility =
		Boolean(workspaceId) &&
		isActive &&
		rightSidebarTab === RightSidebarTab.Docker &&
		dockerComposeFilesQuery.status === "pending";
	const showDockerTab = isResolvingDockerVisibility
		? true
		: (dockerComposeFiles?.composeFiles.length ?? 0) > 0;
	const tabSensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	const sidebarTabs = useMemo<SidebarTabDefinition[]>(() => {
		return rightSidebarTabOrder
			.filter((tabId) => {
				if (tabId === RightSidebarTab.Changes) {
					return showChangesTab;
				}
				if (tabId === RightSidebarTab.Docker) {
					return showDockerTab;
				}
				return true;
			})
			.map((tabId) => ({
				id: tabId,
				...RIGHT_SIDEBAR_TAB_METADATA[tabId],
				hasAlert:
					tabId === RightSidebarTab.Problems ? hasProblemErrors : undefined,
			}));
	}, [hasProblemErrors, rightSidebarTabOrder, showChangesTab, showDockerTab]);

	useEffect(() => {
		if (!isActive) {
			return;
		}

		if (isResolvingDockerVisibility) {
			return;
		}

		if (sidebarTabs.some((tab) => tab.id === rightSidebarTab)) {
			return;
		}

		const fallbackTabId = sidebarTabs[0]?.id;
		if (fallbackTabId) {
			setRightSidebarTab(fallbackTabId);
		}
	}, [
		isActive,
		isResolvingDockerVisibility,
		rightSidebarTab,
		setRightSidebarTab,
		sidebarTabs,
	]);
	const handleSelectSidebarTab = useCallback(
		(tabId: RightSidebarTab) => {
			setRightSidebarTab(tabId);
		},
		[setRightSidebarTab],
	);
	const handleTabDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			if (!over || active.id === over.id) {
				return;
			}

			moveRightSidebarTab(
				active.id as RightSidebarTab,
				over.id as RightSidebarTab,
			);
		},
		[moveRightSidebarTab],
	);

	electronTrpc.languageServices.subscribeDiagnostics.useSubscription(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: Boolean(workspaceId) && isActive,
			onData: () => {
				if (!workspaceId) {
					return;
				}
				void trpcUtils.languageServices.getWorkspaceDiagnostics.invalidate({
					workspaceId,
				});
			},
		},
	);

	const handleExpandToggle = () => {
		setMode(isExpanded ? SidebarMode.Tabs : SidebarMode.Changes);
	};
	const updateHiddenTabs = useCallback(() => {
		const container = tabsViewportRef.current;
		if (!container) {
			return;
		}

		const tabWidths = sidebarTabs.map((tab) => ({
			id: tab.id,
			width: tabMeasureRefs.current[tab.id]?.offsetWidth ?? 0,
		}));
		if (tabWidths.some((tab) => tab.width === 0)) {
			return;
		}

		const availableWidth = container.clientWidth;
		const totalWidth = tabWidths.reduce((sum, tab) => sum + tab.width, 0);
		if (totalWidth <= availableWidth + 1) {
			setHiddenTabIds((previous) => (previous.length === 0 ? previous : []));
			return;
		}

		const overflowWidth = overflowMeasureRef.current?.offsetWidth ?? 0;
		const reservedOverflowWidth = hiddenTabIds.length > 0 ? 0 : overflowWidth;
		const activeTabId = sidebarTabs.some((tab) => tab.id === rightSidebarTab)
			? rightSidebarTab
			: null;
		const visibleTabIds = new Set<RightSidebarTab>();
		let remainingWidth = Math.max(availableWidth - reservedOverflowWidth, 0);

		if (activeTabId) {
			const activeWidth =
				tabWidths.find((tab) => tab.id === activeTabId)?.width ?? 0;
			visibleTabIds.add(activeTabId);
			remainingWidth -= activeWidth;
		}

		for (const tab of tabWidths) {
			if (tab.id === activeTabId) {
				continue;
			}

			if (remainingWidth - tab.width >= -1) {
				visibleTabIds.add(tab.id);
				remainingWidth -= tab.width;
			}
		}

		const nextHiddenTabIds = tabWidths
			.filter((tab) => !visibleTabIds.has(tab.id))
			.map((tab) => tab.id);

		setHiddenTabIds((previous) =>
			previous.length === nextHiddenTabIds.length &&
			previous.every((tabId, index) => tabId === nextHiddenTabIds[index])
				? previous
				: nextHiddenTabIds,
		);
	}, [hiddenTabIds.length, rightSidebarTab, sidebarTabs]);

	useLayoutEffect(() => {
		updateHiddenTabs();

		if (typeof ResizeObserver === "undefined") {
			return;
		}

		const resizeObserver = new ResizeObserver(() => {
			updateHiddenTabs();
		});

		if (tabsViewportRef.current) {
			resizeObserver.observe(tabsViewportRef.current);
		}
		if (measurementRef.current) {
			resizeObserver.observe(measurementRef.current);
		}

		window.addEventListener("resize", updateHiddenTabs);

		return () => {
			resizeObserver.disconnect();
			window.removeEventListener("resize", updateHiddenTabs);
		};
	}, [updateHiddenTabs]);

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const addDatabaseExplorerTab = useTabsStore((s) => s.addDatabaseExplorerTab);
	const { scrollToFile } = useScrollContext();

	const invalidateFileContent = useCallback(
		(absolutePath: string) => {
			const invalidations: Promise<unknown>[] = [];
			if (workspaceId) {
				invalidations.push(
					trpcUtils.filesystem.readFile.invalidate({
						workspaceId,
						absolutePath,
					}),
				);
			}
			if (worktreePath) {
				invalidations.push(
					trpcUtils.changes.getGitFileContents.invalidate({
						worktreePath,
						absolutePath,
					}),
				);
			}
			Promise.all(invalidations).catch((error) => {
				console.error(
					"[RightSidebar/invalidateFileContent] Failed to invalidate file content queries:",
					{ absolutePath, error },
				);
			});
		},
		[workspaceId, worktreePath, trpcUtils],
	);

	const handleFileOpenPane = useCallback(
		(file: ChangedFile, category: ChangeCategory, commitHash?: string) => {
			if (!workspaceId || !worktreePath) return;
			const absolutePath = toAbsoluteWorkspacePath(worktreePath, file.path);
			addFileViewerPane(workspaceId, {
				filePath: absolutePath,
				diffCategory: category,
				viewMode: category === "conflicted" ? "conflict" : undefined,
				fileStatus: file.status,
				commitHash,
				oldPath: file.oldPath
					? toAbsoluteWorkspacePath(worktreePath, file.oldPath)
					: undefined,
			});
			invalidateFileContent(absolutePath);
		},
		[workspaceId, worktreePath, addFileViewerPane, invalidateFileContent],
	);

	const handleFileScrollTo = useCallback(
		(file: ChangedFile, category: ChangeCategory, commitHash?: string) => {
			scrollToFile(file, category, commitHash, worktreePath);
		},
		[scrollToFile, worktreePath],
	);

	const handleOpenFileAtLine = useCallback(
		(path: string, line?: number, column?: number) => {
			if (!workspaceId || !worktreePath) return;
			const absolutePath = toAbsoluteWorkspacePath(worktreePath, path);
			addFileViewerPane(workspaceId, {
				filePath: absolutePath,
				viewMode: "raw",
				line,
				column,
			});
		},
		[workspaceId, worktreePath, addFileViewerPane],
	);

	const handleFileOpen =
		workspaceId && worktreePath
			? isExpanded
				? handleFileScrollTo
				: handleFileOpenPane
			: undefined;
	const handleOpenDatabaseExplorer = useCallback(
		(connectionId: string) => {
			if (!workspaceId) {
				return;
			}

			addDatabaseExplorerTab(workspaceId, connectionId);
		},
		[workspaceId, addDatabaseExplorerTab],
	);
	const hiddenTabIdSet = useMemo(() => new Set(hiddenTabIds), [hiddenTabIds]);
	const visibleTabs = sidebarTabs.filter((tab) => !hiddenTabIdSet.has(tab.id));
	const hiddenTabs = sidebarTabs.filter((tab) => hiddenTabIdSet.has(tab.id));
	const hasHiddenAlerts = hiddenTabs.some((tab) => tab.hasAlert);

	return (
		<aside className="h-full flex flex-col overflow-hidden">
			<div className="relative flex items-center bg-background shrink-0 h-10 border-b">
				<DndContext sensors={tabSensors} onDragEnd={handleTabDragEnd}>
					<SortableContext
						items={visibleTabs.map((tab) => tab.id)}
						strategy={horizontalListSortingStrategy}
					>
						<div
							ref={tabsViewportRef}
							className="flex min-w-0 flex-1 items-center overflow-hidden"
						>
							{visibleTabs.map((tab) => (
								<SortableTabButton
									key={tab.id}
									tab={tab}
									isActive={rightSidebarTab === tab.id}
									onClick={() => handleSelectSidebarTab(tab.id)}
									compact={compactTabs}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
				<div className="flex shrink-0 items-center h-10 pr-2 gap-0.5">
					{hiddenTabs.length > 0 ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									aria-label="More sidebar tabs"
									className="size-6 p-0"
								>
									<span className="relative inline-flex">
										<LuEllipsisVertical className="size-3.5" />
										{hasHiddenAlerts ? (
											<span className="absolute -right-1 -top-1 size-2 rounded-full bg-red-500" />
										) : null}
									</span>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-44">
								{hiddenTabs.map((tab) => {
									const Icon = tab.icon;

									return (
										<DropdownMenuItem
											key={tab.id}
											onClick={() => handleSelectSidebarTab(tab.id)}
											className="gap-2"
										>
											<span className="relative inline-flex">
												<Icon className="size-4" />
												{tab.hasAlert ? (
													<span className="absolute -right-1 -top-1 size-2 rounded-full bg-red-500" />
												) : null}
											</span>
											{tab.label}
										</DropdownMenuItem>
									);
								})}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleExpandToggle}
								className="size-6 p-0"
							>
								{isExpanded ? (
									<LuShrink className="size-3.5" />
								) : (
									<LuExpand className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyTooltipContent
								label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
								hotkeyId="TOGGLE_EXPAND_SIDEBAR"
							/>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={toggleSidebar}
								className="size-6 p-0"
							>
								<LuX className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" showArrow={false}>
							<HotkeyTooltipContent
								label="Close sidebar"
								hotkeyId="TOGGLE_SIDEBAR"
							/>
						</TooltipContent>
					</Tooltip>
				</div>
				<div
					ref={measurementRef}
					aria-hidden
					className="pointer-events-none invisible absolute left-0 top-0 flex h-10 items-center"
				>
					{sidebarTabs.map((tab) => {
						const Icon = tab.icon;

						return (
							<TabButton
								key={tab.id}
								isActive={rightSidebarTab === tab.id}
								onClick={() => {}}
								icon={<Icon className="size-3.5" />}
								label={tab.label}
								compact={compactTabs}
								hasAlert={tab.hasAlert}
								buttonRef={(element) => {
									tabMeasureRefs.current[tab.id] = element;
								}}
								disableTooltip
								tabIndex={-1}
								ariaHidden
							/>
						);
					})}
					<button
						ref={overflowMeasureRef}
						type="button"
						tabIndex={-1}
						aria-hidden
						className="size-6 shrink-0 p-0"
					>
						<LuEllipsisVertical className="size-3.5" />
					</button>
				</div>
			</div>
			{showChangesTab && (
				<div
					className={
						rightSidebarTab === RightSidebarTab.Changes
							? "flex-1 min-h-0 flex flex-col overflow-hidden"
							: "hidden"
					}
				>
					<ChangesView
						onFileOpen={handleFileOpen}
						onOpenFileAtLine={handleOpenFileAtLine}
						isExpandedView={isExpanded}
						isActive={rightSidebarTab === RightSidebarTab.Changes}
					/>
				</div>
			)}
			<div
				className={
					rightSidebarTab === RightSidebarTab.Docker
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				<DockerView isActive={rightSidebarTab === RightSidebarTab.Docker} />
			</div>
			<div
				className={
					rightSidebarTab === RightSidebarTab.Files
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				<FilesView />
			</div>
			<div
				className={
					rightSidebarTab === RightSidebarTab.Search
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				<SearchView
					isActive={rightSidebarTab === RightSidebarTab.Search}
					onOpenFileAtLine={handleOpenFileAtLine}
				/>
			</div>
			<div
				className={
					rightSidebarTab === RightSidebarTab.Problems
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				<ProblemsView
					isActive={rightSidebarTab === RightSidebarTab.Problems}
					onOpenFileAtLine={handleOpenFileAtLine}
				/>
			</div>
			<div
				className={
					rightSidebarTab === RightSidebarTab.Databases
						? "flex-1 min-h-0 flex flex-col overflow-hidden"
						: "hidden"
				}
			>
				<DatabasesView onOpenExplorer={handleOpenDatabaseExplorer} />
			</div>
		</aside>
	);
}
