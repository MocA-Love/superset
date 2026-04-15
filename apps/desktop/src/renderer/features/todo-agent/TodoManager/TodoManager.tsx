import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import type {
	TodoSessionListEntry,
	TodoStreamEvent,
} from "main/todo-agent/types";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	HiMiniArrowPath,
	HiMiniChevronDown,
	HiMiniChevronRight,
	HiMiniCog6Tooth,
	HiMiniDocumentDuplicate,
	HiMiniEllipsisVertical,
	HiMiniPencil,
	HiMiniPlus,
	HiMiniTrash,
	HiMiniXMark,
} from "react-icons/hi2";
import {
	LuPanelLeftClose,
	LuPanelLeftOpen,
	LuPanelRightClose,
	LuPanelRightOpen,
} from "react-icons/lu";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ChangesSidebar } from "./ChangesSidebar";
import { PresetsDialog } from "./PresetsDialog";

async function copyToClipboard(text: string, label = "コピーしました") {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(label);
	} catch (error) {
		toast.error(
			error instanceof Error ? error.message : "コピーに失敗しました",
		);
	}
}

interface TodoManagerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentWorkspaceId?: string;
	onRequestNewTodo: () => void;
}

type TodoSession = TodoSessionListEntry;

/**
 * Agent-Manager style full-view drawer for TODO autonomous sessions.
 *
 * The session runs headlessly in the main process (child_process spawn of
 * `claude -p --output-format stream-json`) — there is no PTY and no
 * workspace terminal tab. Parsed stream events (assistant text, tool
 * calls, tool results, verify outcomes) flow back to this dialog via the
 * `todoAgent.subscribeStream` observable so everything a user needs to
 * watch or review lives inside the Manager.
 */
export function TodoManager({
	open,
	onOpenChange,
	currentWorkspaceId: _currentWorkspaceId,
	onRequestNewTodo,
}: TodoManagerProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
		new Set(),
	);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [changesSidebarCollapsed, setChangesSidebarCollapsed] = useState(false);
	const [presetsDialogOpen, setPresetsDialogOpen] = useState(false);

	const { data: sessions } = electronTrpc.todoAgent.listAll.useQuery(
		undefined,
		{ enabled: open, refetchInterval: 2000 },
	);

	const filtered = useMemo(() => {
		if (!filter.trim()) return sessions ?? [];
		const needle = filter.trim().toLowerCase();
		return (sessions ?? []).filter(
			(s) =>
				s.title.toLowerCase().includes(needle) ||
				s.description.toLowerCase().includes(needle) ||
				(s.workspaceName ?? "").toLowerCase().includes(needle) ||
				(s.projectName ?? "").toLowerCase().includes(needle),
		);
	}, [sessions, filter]);

	const grouped = useMemo(() => groupByWorkspace(filtered), [filtered]);

	const selected = useMemo(
		() => filtered.find((s) => s.id === selectedId) ?? filtered[0] ?? null,
		[filtered, selectedId],
	);

	const toggleGroup = useCallback((key: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="w-[2040px] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] h-[92vh] max-h-[1290px] p-0 gap-0 overflow-hidden flex flex-col rounded-xl"
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">TODO Agent Manager</DialogTitle>
				<div className="flex items-center justify-between border-b px-4 h-12 shrink-0">
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0 rounded-md"
							onClick={() => setSidebarCollapsed((v) => !v)}
							title={
								sidebarCollapsed ? "サイドバーを開く" : "サイドバーを閉じる"
							}
						>
							{sidebarCollapsed ? (
								<LuPanelLeftOpen className="size-4" />
							) : (
								<LuPanelLeftClose className="size-4" />
							)}
						</Button>
						<span className="text-sm font-semibold">TODO Agent Manager</span>
						<span className="text-xs text-muted-foreground">
							自律 TODO セッションを横断表示
						</span>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							className="h-7 gap-1 px-2.5 text-xs rounded-md"
							onClick={onRequestNewTodo}
						>
							<HiMiniPlus className="size-4" />
							新しい TODO
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0 rounded-md"
							onClick={() => setChangesSidebarCollapsed((v) => !v)}
							title={
								changesSidebarCollapsed
									? "変更パネルを開く"
									: "変更パネルを閉じる"
							}
						>
							{changesSidebarCollapsed ? (
								<LuPanelRightOpen className="size-4" />
							) : (
								<LuPanelRightClose className="size-4" />
							)}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0 rounded-md"
							onClick={() => onOpenChange(false)}
							title="閉じる"
						>
							<HiMiniXMark className="size-4" />
						</Button>
					</div>
				</div>

				{/* Body: flex-based 2-column so height resolution is
				    rock-solid in every nested grid/scroll layer. The
				    previous grid-based version occasionally let the
				    detail pane's footer get clipped. */}
				<div className="flex flex-1 min-h-0">
					<div
						className={cn(
							"shrink-0 flex flex-col border-r min-h-0 overflow-hidden transition-[width] duration-150 ease-out",
							sidebarCollapsed ? "w-0 border-r-0" : "w-[320px]",
						)}
					>
						<div className="p-2 border-b shrink-0">
							<Input
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="絞り込み（タイトル / ワークスペース）"
								className="h-8 text-xs rounded-md"
							/>
						</div>
						<ScrollArea className="flex-1">
							{grouped.length === 0 && (
								<p className="text-xs text-muted-foreground px-3 py-6">
									{(sessions?.length ?? 0) === 0
										? "まだ TODO セッションはありません。右上の『新しい TODO』から作成してください。"
										: "条件に一致するセッションがありません。"}
								</p>
							)}
							{grouped.map((group) => {
								const collapsed = collapsedGroups.has(group.key);
								return (
									<div key={group.key} className="pb-1">
										<button
											type="button"
											onClick={() => toggleGroup(group.key)}
											className="sticky top-0 z-10 bg-background/95 backdrop-blur w-full flex items-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b hover:bg-accent/40 transition"
										>
											{collapsed ? (
												<HiMiniChevronRight className="size-3" />
											) : (
												<HiMiniChevronDown className="size-3" />
											)}
											<span className="flex-1 text-left truncate">
												{group.label}
											</span>
											<span className="text-muted-foreground/60">
												{group.sessions.length}
											</span>
										</button>
										{!collapsed && (
											<div className="flex flex-col px-1.5 py-1 gap-0.5">
												{group.sessions.map((session) => (
													<SessionRow
														key={session.id}
														session={session}
														isSelected={selected?.id === session.id}
														onSelect={() => setSelectedId(session.id)}
														onDeleted={() => {
															if (selectedId === session.id)
																setSelectedId(null);
														}}
													/>
												))}
											</div>
										)}
									</div>
								);
							})}
						</ScrollArea>
						<div className="shrink-0 border-t p-1.5">
							<button
								type="button"
								onClick={() => setPresetsDialogOpen(true)}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition"
								title="システムプロンプトテンプレートを管理"
							>
								<HiMiniCog6Tooth className="size-3.5" />
								<span>設定 / プリセット</span>
							</button>
						</div>
					</div>

					<div className="flex-1 min-w-0 min-h-0 flex flex-col">
						{selected ? (
							<SessionDetail
								session={selected}
								onDeleted={() => setSelectedId(null)}
							/>
						) : (
							<div className="flex h-full items-center justify-center text-sm text-muted-foreground p-8">
								セッションを選択すると詳細が表示されます。
							</div>
						)}
					</div>

					<div
						className={cn(
							"shrink-0 border-l min-h-0 overflow-hidden transition-[width] duration-150 ease-out",
							changesSidebarCollapsed ? "w-0 border-l-0" : "w-[380px]",
						)}
					>
						{selected && !changesSidebarCollapsed && (
							<ChangesSidebar
								sessionId={selected.id}
								active={
									selected.status === "running" ||
									selected.status === "verifying" ||
									selected.status === "preparing" ||
									selected.status === "queued"
								}
							/>
						)}
					</div>
				</div>
			</DialogContent>
			<PresetsDialog
				open={presetsDialogOpen}
				onOpenChange={setPresetsDialogOpen}
			/>
		</Dialog>
	);
}

interface SessionRowProps {
	session: TodoSession;
	isSelected: boolean;
	onSelect: () => void;
	onDeleted: () => void;
}

function SessionRow({
	session,
	isSelected,
	onSelect,
	onDeleted,
}: SessionRowProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(session.title);

	const utils = electronTrpc.useUtils();
	const updateTitleMut = electronTrpc.todoAgent.updateTitle.useMutation();
	const rerunMut = electronTrpc.todoAgent.rerun.useMutation();
	const deleteMut = electronTrpc.todoAgent.delete.useMutation();
	const abortMut = electronTrpc.todoAgent.abort.useMutation();

	const isActive =
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying";

	const invalidate = useCallback(async () => {
		await utils.todoAgent.listAll.invalidate();
		await utils.todoAgent.list.invalidate({
			workspaceId: session.workspaceId,
		});
	}, [utils, session.workspaceId]);

	const startRename = useCallback(() => {
		setRenameValue(session.title);
		setRenaming(true);
		setMenuOpen(false);
	}, [session.title]);

	const commitRename = useCallback(async () => {
		const next = renameValue.trim();
		if (!next || next === session.title) {
			setRenaming(false);
			return;
		}
		try {
			await updateTitleMut.mutateAsync({
				sessionId: session.id,
				title: next,
			});
			await invalidate();
			setRenaming(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "改名に失敗しました",
			);
		}
	}, [invalidate, renameValue, session.id, session.title, updateTitleMut]);

	const handleRenameKey = useCallback(
		(e: ReactKeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				void commitRename();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setRenaming(false);
			}
		},
		[commitRename],
	);

	const handleRerun = useCallback(async () => {
		setMenuOpen(false);
		try {
			await rerunMut.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success("同じ内容で新しいセッションを作成しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "再実行の作成に失敗しました",
			);
		}
	}, [invalidate, rerunMut, session.id]);

	const handleDelete = useCallback(async () => {
		setMenuOpen(false);
		if (isActive) {
			try {
				await abortMut.mutateAsync({ sessionId: session.id });
			} catch {
				// ignore; supervisor.abort is idempotent
			}
		}
		try {
			await deleteMut.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success("削除しました");
			onDeleted();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "削除に失敗しました",
			);
		}
	}, [abortMut, deleteMut, invalidate, isActive, onDeleted, session.id]);

	const handleCopyTitle = useCallback(() => {
		setMenuOpen(false);
		void copyToClipboard(session.title, "タイトルをコピーしました");
	}, [session.title]);

	return (
		<div
			className={cn(
				"group relative rounded-lg transition flex items-stretch",
				isSelected ? "bg-accent" : "hover:bg-accent/50",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				className="text-left flex-1 min-w-0 pl-2.5 pr-1 py-2"
			>
				<div className="flex items-center gap-2">
					<StatusDot status={session.status} />
					{renaming ? (
						<Input
							autoFocus
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={handleRenameKey}
							onBlur={() => void commitRename()}
							onClick={(e) => e.stopPropagation()}
							className="h-6 text-xs rounded-md"
						/>
					) : (
						<span className="text-xs font-medium line-clamp-1 flex-1">
							{session.title}
						</span>
					)}
				</div>
				<div className="flex items-center justify-between gap-2 pl-4 mt-0.5">
					<span className="text-[10px] text-muted-foreground line-clamp-1 flex-1">
						{statusLabel(session)}
					</span>
					<span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
						{formatRelativeTime(session.createdAt)}
					</span>
				</div>
			</button>
			<div className="flex items-center pr-1">
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className={cn(
								"size-6 rounded-md flex items-center justify-center text-muted-foreground transition shrink-0",
								menuOpen
									? "bg-background/80 opacity-100"
									: "opacity-0 group-hover:opacity-100 hover:bg-background/80",
							)}
							title="アクション"
							onClick={(e) => e.stopPropagation()}
						>
							<HiMiniEllipsisVertical className="size-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuItem onClick={startRename}>
							<HiMiniPencil className="size-3.5 mr-2" />
							リネーム
						</DropdownMenuItem>
						<DropdownMenuItem onClick={handleCopyTitle}>
							<HiMiniDocumentDuplicate className="size-3.5 mr-2" />
							タイトルをコピー
						</DropdownMenuItem>
						<DropdownMenuItem onClick={handleRerun}>
							<HiMiniArrowPath className="size-3.5 mr-2" />
							同じ内容で再実行
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={handleDelete}
							className="text-destructive focus:text-destructive"
						>
							<HiMiniTrash className="size-3.5 mr-2" />
							削除
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}

function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "今";
	if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}分前`;
	if (diff < 24 * 60 * 60_000)
		return `${Math.floor(diff / (60 * 60_000))}時間前`;
	if (diff < 30 * 24 * 60 * 60_000)
		return `${Math.floor(diff / (24 * 60 * 60_000))}日前`;
	if (diff < 365 * 24 * 60 * 60_000)
		return `${Math.floor(diff / (30 * 24 * 60 * 60_000))}ヶ月前`;
	return `${Math.floor(diff / (365 * 24 * 60 * 60_000))}年前`;
}

function StatusDot({ status }: { status: string }) {
	const color =
		status === "running" || status === "verifying" || status === "preparing"
			? "bg-amber-500 animate-pulse"
			: status === "done"
				? "bg-emerald-500"
				: status === "failed" || status === "escalated"
					? "bg-rose-500"
					: status === "aborted"
						? "bg-muted-foreground/50"
						: "bg-muted-foreground/40";
	return <span className={cn("size-2 rounded-full shrink-0", color)} />;
}

interface SessionDetailProps {
	session: TodoSession;
	onDeleted: () => void;
}

function SessionDetail({ session, onDeleted }: SessionDetailProps) {
	const [intervention, setIntervention] = useState("");
	const [starting, setStarting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [streamEvents, setStreamEvents] = useState<TodoStreamEvent[]>([]);

	const utils = electronTrpc.useUtils();
	const startMut = electronTrpc.todoAgent.start.useMutation();
	const abortMut = electronTrpc.todoAgent.abort.useMutation();
	const sendInputMut = electronTrpc.todoAgent.sendInput.useMutation();
	const deleteMut = electronTrpc.todoAgent.delete.useMutation();
	const rerunMut = electronTrpc.todoAgent.rerun.useMutation();

	const isActive =
		session.status === "queued" ||
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying";

	const canStart =
		session.status === "queued" ||
		session.status === "failed" ||
		session.status === "aborted" ||
		session.status === "escalated";
	const isRunning =
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying";
	const isFinal =
		session.status === "done" ||
		session.status === "failed" ||
		session.status === "escalated" ||
		session.status === "aborted";

	// Reset the event buffer when the selected session changes. The
	// subscription emits the current in-memory buffer immediately on
	// connect, so there is no separate getStream query — one source of
	// truth keeps the dedupe path simple and avoids double-delivery on
	// mount. `session.id` is intentionally in the deps array (not
	// read inside the body) so React fires the reset on every selection
	// change, since SessionDetail is reused across selections.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset-on-change dep
	useEffect(() => {
		setStreamEvents([]);
	}, [session.id]);

	// Force a re-render once per second while the session is still
	// running so TimingBlock's 実行時間 ticks smoothly instead of being
	// tied to the 2-second listAll polling cadence. Stops as soon as
	// `completedAt` is set to avoid needless renders on finished rows.
	const [, setTick] = useState(0);
	useEffect(() => {
		if (session.completedAt != null) return;
		const id = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(id);
	}, [session.completedAt]);

	electronTrpc.todoAgent.subscribeStream.useSubscription(
		{ sessionId: session.id },
		{
			onData: (update) => {
				setStreamEvents((prev) => {
					const seen = new Set(prev.map((e) => e.id));
					const merged = [...prev];
					for (const ev of update.events) {
						if (!seen.has(ev.id)) merged.push(ev);
					}
					// Cap at 500 client-side too.
					if (merged.length > 500) {
						return merged.slice(-500);
					}
					return merged;
				});
			},
		},
	);

	const invalidate = useCallback(async () => {
		await utils.todoAgent.listAll.invalidate();
		await utils.todoAgent.list.invalidate({
			workspaceId: session.workspaceId,
		});
	}, [utils, session.workspaceId]);

	const handleStart = useCallback(async () => {
		if (!canStart) return;
		setStarting(true);
		try {
			await startMut.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success(`実行を開始しました: ${session.title}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "開始に失敗しました",
			);
		} finally {
			setStarting(false);
		}
	}, [canStart, invalidate, session.id, session.title, startMut]);

	const handleAbort = useCallback(async () => {
		try {
			await abortMut.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success("中断しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "中断に失敗しました",
			);
		}
	}, [abortMut, invalidate, session.id]);

	const handleSendInput = useCallback(async () => {
		if (!intervention.trim()) return;
		try {
			await sendInputMut.mutateAsync({
				sessionId: session.id,
				data: intervention.trim(),
			});
			setIntervention("");
			toast.success("次のターンに介入指示を注入します");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "送信に失敗しました",
			);
		}
	}, [intervention, sendInputMut, session.id]);

	const handleDelete = useCallback(async () => {
		try {
			await deleteMut.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success("削除しました");
			setConfirmingDelete(false);
			onDeleted();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "削除に失敗しました",
			);
		}
	}, [deleteMut, invalidate, onDeleted, session.id]);

	const handleRerun = useCallback(async () => {
		try {
			await rerunMut.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success("同じ内容で新しいセッションを作成しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "再実行の作成に失敗しました",
			);
		}
	}, [invalidate, rerunMut, session.id]);

	return (
		<div className="flex flex-col h-full min-h-0 overflow-hidden text-sm">
			{/* Header: title + actions. Fixed, not scrollable. */}
			<div className="shrink-0 border-b px-6 pt-5 pb-4">
				<div className="flex items-start gap-3">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
							<StatusDot status={session.status} />
							<span>{statusLabel(session)}</span>
							{session.workspaceName && (
								<>
									<span className="text-muted-foreground/50">·</span>
									<span className="truncate">{session.workspaceName}</span>
								</>
							)}
							{session.projectName && (
								<>
									<span className="text-muted-foreground/50">·</span>
									<span className="truncate">{session.projectName}</span>
								</>
							)}
						</div>
						<h2 className="text-lg font-semibold mt-1 leading-tight break-words">
							{session.title}
						</h2>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{canStart && !isRunning && (
							<Button
								type="button"
								size="sm"
								onClick={handleStart}
								disabled={starting}
							>
								{starting ? "開始中…" : "Start"}
							</Button>
						)}
						{isRunning && (
							<Button
								type="button"
								size="sm"
								variant="destructive"
								onClick={handleAbort}
							>
								中断
							</Button>
						)}
						{isFinal && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="gap-1"
								onClick={handleRerun}
								disabled={rerunMut.isPending}
								title="同じ内容で新しいセッションを作成"
							>
								<HiMiniArrowPath className="size-3.5" />
								再実行
							</Button>
						)}
						{!confirmingDelete ? (
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="gap-1 text-muted-foreground hover:text-destructive"
								onClick={() => setConfirmingDelete(true)}
								disabled={isActive && isRunning}
								title={
									isRunning
										? "実行中のセッションは先に中断してください"
										: "削除"
								}
							>
								<HiMiniTrash className="size-3.5" />
								削除
							</Button>
						) : (
							<div className="flex items-center gap-1">
								<Button
									type="button"
									size="sm"
									variant="destructive"
									onClick={handleDelete}
									disabled={deleteMut.isPending}
								>
									本当に削除
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => setConfirmingDelete(false)}
								>
									キャンセル
								</Button>
							</div>
						)}
					</div>
				</div>
				<div className="mt-4">
					<TimingBlock session={session} />
				</div>
			</div>

			{/* Body: flex-based 2-column so height resolution chains
			    correctly from DialogContent → TodoManager body → SessionDetail
			    → this flex. `overflow-hidden` on every wrapper prevents
			    any child from pushing the pinned footer off-screen
			    when content is taller than the available space. Left
			    column uses native overflow-y-auto instead of
			    <ScrollArea> so height resolution is deterministic. */}
			<div className="flex flex-1 min-h-0 overflow-hidden">
				<div className="w-[34%] min-w-[360px] max-w-[520px] border-r min-h-0 overflow-y-auto">
					<div className="flex flex-col gap-5 p-5">
						<DetailBlock label="やって欲しいこと">
							<div className="whitespace-pre-wrap text-xs leading-relaxed">
								{session.description}
							</div>
						</DetailBlock>

						<DetailBlock label="ゴール">
							{session.goal?.trim() ? (
								<div className="whitespace-pre-wrap text-xs leading-relaxed">
									{session.goal}
								</div>
							) : (
								<div className="text-xs text-muted-foreground">
									未指定 ·『やって欲しいこと』の完了をゴールとみなします
								</div>
							)}
						</DetailBlock>

						{session.customSystemPrompt?.trim() && (
							<DetailBlock label="システムプロンプト（プリセット）">
								<div className="rounded-md border border-border/40 bg-muted/30 p-2 text-[11px] leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
									{session.customSystemPrompt}
								</div>
							</DetailBlock>
						)}

						<div className="grid grid-cols-2 gap-4">
							<DetailBlock label="Verify">
								{session.verifyCommand ? (
									<code className="text-[11px] break-all">
										{session.verifyCommand}
									</code>
								) : (
									<div className="text-xs text-muted-foreground">
										単発モード（verify なし）
									</div>
								)}
							</DetailBlock>
							<DetailBlock label="予算">
								<div className="text-xs">
									{session.verifyCommand
										? `${session.iteration}/${session.maxIterations} iter · ${Math.round(session.maxWallClockSec / 60)}分`
										: `${Math.round(session.maxWallClockSec / 60)}分`}
								</div>
							</DetailBlock>
						</div>

						{(session.totalCostUsd != null ||
							session.totalNumTurns != null) && (
							<DetailBlock label="消費">
								<div className="text-xs text-muted-foreground">
									{session.totalCostUsd != null &&
										`$${session.totalCostUsd.toFixed(4)}`}
									{session.totalCostUsd != null && session.totalNumTurns != null
										? " · "
										: ""}
									{session.totalNumTurns != null &&
										`${session.totalNumTurns} turns`}
								</div>
							</DetailBlock>
						)}

						{session.finalAssistantText && (
							<DetailBlock
								label="最終回答"
								action={
									<CopyIconButton
										value={session.finalAssistantText}
										title="最終回答をコピー"
									/>
								}
							>
								<div className="text-xs bg-muted/40 rounded-lg p-3 border border-border/40">
									<MarkdownRenderer
										content={session.finalAssistantText}
										scrollable={false}
									/>
								</div>
							</DetailBlock>
						)}

						{session.verdictReason && session.verdictPassed === false && (
							<DetailBlock
								label="直近の verify 失敗ログ"
								action={
									<CopyIconButton
										value={session.verdictReason}
										title="失敗ログをコピー"
									/>
								}
							>
								<pre className="text-[11px] bg-muted/40 rounded-lg p-3 border border-border/40 whitespace-pre-wrap leading-relaxed">
									{session.verdictReason}
								</pre>
							</DetailBlock>
						)}
					</div>
				</div>

				<div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
					<div className="px-5 pt-5 pb-2 shrink-0">
						<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
							Claude の応答 / ライブストリーム
						</div>
					</div>
					<div className="flex-1 min-h-0 px-5 pb-5 overflow-hidden">
						<StreamView events={streamEvents} />
					</div>
				</div>
			</div>

			{/* Footer: intervention input, pinned. Always reachable. */}
			<div className="shrink-0 border-t px-6 py-3 bg-background">
				<div className="flex items-center gap-2">
					<Input
						value={intervention}
						onChange={(e) => setIntervention(e.target.value)}
						placeholder="次のターンに注入する介入指示（Enter で送信）"
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSendInput();
							}
						}}
					/>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={handleSendInput}
						disabled={!intervention.trim()}
					>
						キュー
					</Button>
				</div>
				<div className="flex items-center justify-between gap-3 mt-1.5">
					<p className="text-[10px] text-muted-foreground line-clamp-1">
						{session.pendingIntervention ? (
							<>予約済み: {session.pendingIntervention}</>
						) : (
							<>
								ヒント: 介入指示は次のイテレーション開始時に Claude
								に渡されます。
							</>
						)}
					</p>
				</div>
			</div>
		</div>
	);
}

function TimingBlock({ session }: { session: TodoSession }) {
	return (
		<div className="grid grid-cols-4 gap-3 text-xs">
			<TimingCell label="作成" value={formatTimestamp(session.createdAt)} />
			<TimingCell label="開始" value={formatTimestamp(session.startedAt)} />
			<TimingCell label="終了" value={formatTimestamp(session.completedAt)} />
			<TimingCell
				label="実行時間"
				value={formatDuration(session.startedAt, session.completedAt)}
			/>
		</div>
	);
}

function TimingCell({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
				{label}
			</div>
			<div className="text-xs tabular-nums">{value}</div>
		</div>
	);
}

function formatTimestamp(ms: number | null): string {
	if (ms == null) return "—";
	const d = new Date(ms);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
		d.getDate(),
	)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(startMs: number | null, endMs: number | null): string {
	if (startMs == null) return "—";
	const end = endMs ?? Date.now();
	const diffSec = Math.max(0, Math.round((end - startMs) / 1000));
	if (diffSec < 60) return `${diffSec}秒`;
	if (diffSec < 60 * 60) {
		const m = Math.floor(diffSec / 60);
		const s = diffSec % 60;
		return `${m}分${s}秒`;
	}
	const h = Math.floor(diffSec / 3600);
	const m = Math.floor((diffSec % 3600) / 60);
	return `${h}時間${m}分`;
}

function StreamView({ events }: { events: TodoStreamEvent[] }) {
	// Auto-scroll to the bottom whenever a new event arrives, but only
	// if the user hadn't scrolled up to read older output. Tracked via
	// a `pinnedToBottom` ref that flips to false the moment the user
	// manually scrolls up, and back to true when they scroll near the
	// bottom again.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const pinnedToBottomRef = useRef(true);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom =
			el.scrollHeight - (el.scrollTop + el.clientHeight);
		pinnedToBottomRef.current = distanceFromBottom < 40;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: events.length intentional — we want to scroll on new events, not on identity changes
	useEffect(() => {
		if (!pinnedToBottomRef.current) return;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [events.length]);

	return (
		<div
			ref={scrollRef}
			onScroll={handleScroll}
			className="h-full overflow-auto bg-muted/30 rounded p-3 flex flex-col gap-2"
		>
			{events.length === 0 ? (
				<div className="text-xs text-muted-foreground p-2">
					まだストリームイベントがありません。Start するとここにリアルタイムで
					Claude の応答・ツール使用・verify 結果が流れます。
				</div>
			) : (
				events.map((event) => <StreamEventRow key={event.id} event={event} />)
			)}
		</div>
	);
}

function StreamEventRow({ event }: { event: TodoStreamEvent }) {
	const color =
		event.kind === "assistant_text"
			? "border-primary/40 bg-primary/5"
			: event.kind === "tool_use"
				? "border-amber-500/40 bg-amber-500/5"
				: event.kind === "tool_result"
					? "border-emerald-500/30 bg-emerald-500/5"
					: event.kind === "result"
						? "border-emerald-600/50 bg-emerald-600/10"
						: event.kind === "error"
							? "border-rose-500/50 bg-rose-500/5"
							: "border-border/40 bg-background";
	// Markdown rendering for the two kinds where authoring is natural
	// (Claude's prose assistant messages + the final `result` text).
	// Tool calls, tool results, and raw log lines stay plain text so
	// their monospace / short-label nature is preserved.
	const useMarkdown =
		event.kind === "assistant_text" || event.kind === "result";
	return (
		<div className={cn("group border rounded-lg px-3 py-2 text-xs", color)}>
			<div className="flex items-center justify-between gap-2 mb-1">
				<span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
					[iter {event.iteration}] {event.label}
				</span>
				<div className="flex items-center gap-1">
					<span className="text-[10px] text-muted-foreground tabular-nums">
						{formatClock(event.ts)}
					</span>
					<div className="opacity-0 group-hover:opacity-100 transition">
						<CopyIconButton value={event.text} title="このイベントをコピー" />
					</div>
				</div>
			</div>
			{useMarkdown ? (
				<MarkdownRenderer content={event.text} scrollable={false} />
			) : (
				<div className="whitespace-pre-wrap leading-relaxed font-mono text-[11px]">
					{event.text}
				</div>
			)}
		</div>
	);
}

function formatClock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function DetailBlock({
	label,
	action,
	children,
}: {
	label: string;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
					{label}
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}

function CopyIconButton({
	value,
	title,
	label,
}: {
	value: string;
	title?: string;
	label?: string;
}) {
	return (
		<button
			type="button"
			className="size-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition"
			onClick={(e) => {
				e.stopPropagation();
				void copyToClipboard(value, label);
			}}
			title={title ?? "コピー"}
		>
			<HiMiniDocumentDuplicate className="size-3.5" />
		</button>
	);
}

function statusLabel(session: TodoSession): string {
	const iter = session.iteration ? ` · iter ${session.iteration}` : "";
	return `${session.status}${iter}`;
}

interface SessionGroup {
	key: string;
	label: string;
	sessions: TodoSession[];
}

function groupByWorkspace(sessions: TodoSession[]): SessionGroup[] {
	const groups = new Map<string, SessionGroup>();
	for (const session of sessions) {
		const key = session.workspaceId;
		const existing = groups.get(key);
		if (existing) {
			existing.sessions.push(session);
			continue;
		}
		const label =
			[session.projectName, session.workspaceName]
				.filter(Boolean)
				.join(" / ") || "(unknown workspace)";
		groups.set(key, { key, label, sessions: [session] });
	}
	return Array.from(groups.values());
}
