import { buildAgentPromptCommand } from "@superset/shared/agent-command";
import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import type { TodoSessionListEntry } from "main/todo-agent/types";
import { useCallback, useMemo, useState } from "react";
import {
	HiMiniArrowPath,
	HiMiniArrowTopRightOnSquare,
	HiMiniChevronDown,
	HiMiniChevronRight,
	HiMiniPlus,
	HiMiniTrash,
	HiMiniXMark,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";

interface TodoManagerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Workspace currently active in the shell. Used (a) as the default
	 * target for the "新しい TODO" button so creation stays in the
	 * expected workspace and (b) to decide whether "ターミナルを開く"
	 * should directly switch the foreground tab or just set the active
	 * tab id in the store for when the user navigates back.
	 */
	currentWorkspaceId?: string;
	/**
	 * Invoked when the user clicks the "新しい TODO" button. The parent
	 * owns the creation modal state so the two shadcn Dialogs are
	 * siblings rather than nested — stacks more reliably on top of the
	 * Manager and avoids click-outside interference.
	 */
	onRequestNewTodo: () => void;
}

type TodoSession = TodoSessionListEntry;

/**
 * Agent-Manager style full-view drawer for TODO autonomous sessions.
 *
 * Layout: dialog ~2040px × 92vh (capped to viewport) with a 2-pane
 * split — a workspace-grouped, collapsible session list on the left
 * and a detail view on the right. Inspired by Google Antigravity's
 * Agent Manager, Cursor 2.0's agents sidebar, and Factory Desktop's
 * sessions view.
 *
 * The manager does NOT embed a live PTY. The worker runs in a regular
 * terminal tab inside its own workspace; the detail pane has an
 * "open terminal" button that switches the workspace's active tab to
 * the worker pane so users can jump to it with one click.
 */
export function TodoManager({
	open,
	onOpenChange,
	currentWorkspaceId,
	onRequestNewTodo,
}: TodoManagerProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
		new Set(),
	);

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
				className="w-[2040px] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] h-[92vh] max-h-[1290px] p-0 gap-0 overflow-hidden flex flex-col"
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">TODO Agent Manager</DialogTitle>
				<div className="flex items-center justify-between border-b px-4 h-12 shrink-0">
					<div className="flex items-center gap-3">
						<span className="text-sm font-semibold">
							TODO Agent Manager
						</span>
						<span className="text-xs text-muted-foreground">
							自律 TODO セッションを横断表示
						</span>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							onClick={onRequestNewTodo}
						>
							<HiMiniPlus className="size-4" />
							新しい TODO
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0"
							onClick={() => onOpenChange(false)}
							title="閉じる"
						>
							<HiMiniXMark className="size-4" />
						</Button>
					</div>
				</div>

				<div className="grid grid-cols-[340px_1fr] flex-1 min-h-0">
					<div className="flex flex-col border-r min-h-0">
						<div className="p-2 border-b">
							<Input
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="絞り込み（タイトル / ワークスペース）"
								className="h-8 text-xs"
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
											<div className="flex flex-col">
												{group.sessions.map((session) => (
													<SessionRow
														key={session.id}
														session={session}
														isSelected={selected?.id === session.id}
														onSelect={() => setSelectedId(session.id)}
													/>
												))}
											</div>
										)}
									</div>
								);
							})}
						</ScrollArea>
					</div>

					<ScrollArea>
						{selected ? (
							<SessionDetail
								session={selected}
								currentWorkspaceId={currentWorkspaceId}
								onDeleted={() => setSelectedId(null)}
							/>
						) : (
							<div className="flex h-full items-center justify-center text-sm text-muted-foreground p-8">
								セッションを選択すると詳細が表示されます。
							</div>
						)}
					</ScrollArea>
				</div>
			</DialogContent>
		</Dialog>
	);
}

interface SessionRowProps {
	session: TodoSession;
	isSelected: boolean;
	onSelect: () => void;
}

function SessionRow({ session, isSelected, onSelect }: SessionRowProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"text-left px-3 py-2 hover:bg-accent/60 border-b border-border/30",
				isSelected && "bg-accent",
			)}
		>
			<div className="flex items-center gap-2">
				<StatusDot status={session.status} />
				<span className="text-xs font-medium line-clamp-1 flex-1">
					{session.title}
				</span>
			</div>
			<div className="text-[10px] text-muted-foreground line-clamp-1 pl-4 mt-0.5">
				{statusLabel(session)}
			</div>
		</button>
	);
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
	currentWorkspaceId?: string;
	onDeleted: () => void;
}

function SessionDetail({
	session,
	currentWorkspaceId,
	onDeleted,
}: SessionDetailProps) {
	const [intervention, setIntervention] = useState("");
	const [starting, setStarting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	const utils = electronTrpc.useUtils();
	const attachPane = electronTrpc.todoAgent.attachPane.useMutation();
	const abort = electronTrpc.todoAgent.abort.useMutation();
	const sendInput = electronTrpc.todoAgent.sendInput.useMutation();
	const deleteMut = electronTrpc.todoAgent.delete.useMutation();
	const rerunMut = electronTrpc.todoAgent.rerun.useMutation();
	const createOrAttach = electronTrpc.terminal.createOrAttach.useMutation();
	const write = electronTrpc.terminal.write.useMutation();

	const isActive =
		session.status === "queued" ||
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying";

	const canStart = session.status === "queued";
	const isFinal =
		session.status === "done" ||
		session.status === "failed" ||
		session.status === "escalated" ||
		session.status === "aborted";

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
			// Capture the user's currently-active tab in that workspace so
			// we can restore it after launching the worker tab. This is
			// the "background start" behavior: Start should not steal
			// focus from whatever the user was doing — the new tab only
			// becomes visible when the user explicitly opens it via the
			// ターミナルを開く button.
			const tabsStateBefore = useTabsStore.getState();
			const previousActiveTabId =
				tabsStateBefore.activeTabIds[session.workspaceId];

			const tabs = useTabsStore.getState();
			const { tabId, paneId } = tabs.addTab(session.workspaceId);
			tabs.setTabAutoTitle(tabId, `TODO: ${session.title.slice(0, 24)}`);

			const goalRef = `.superset/todo/${session.id}/goal.md`;
			const goalClause = session.goal?.trim()
				? "ゴール（受け入れ条件）を達成することを目指してください"
				: "『やって欲しいこと』が完了した時点で完了とみなしてください";
			const initialPrompt = session.verifyCommand
				? `${goalRef} を読んで、${goalClause}。ターンが完了したと判断したら停止して待機してください。外部 verifier が \`${session.verifyCommand}\` を実行して次のターンが必要かを判定します。`
				: `${goalRef} を読んで、${goalClause}。単発タスクなので外部 verify は行いません。達成したと判断したら停止してください。`;
			const command = buildAgentPromptCommand({
				prompt: initialPrompt,
				randomId: session.id,
				agent: "claude",
			});

			await launchCommandInPane({
				paneId,
				tabId,
				workspaceId: session.workspaceId,
				command,
				createOrAttach: (input) =>
					createOrAttach.mutateAsync(input as never),
				write: (input) => write.mutateAsync(input as never),
			});

			await attachPane.mutateAsync({
				sessionId: session.id,
				tabId,
				paneId,
			});

			// Restore the previous active tab so the user stays on
			// whatever they were looking at. The worker keeps running in
			// the background; ターミナルを開く will bring it to the front.
			if (previousActiveTabId && previousActiveTabId !== tabId) {
				useTabsStore
					.getState()
					.setActiveTab(session.workspaceId, previousActiveTabId);
			}

			await invalidate();
			toast.success(`バックグラウンドで開始しました: ${session.title}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "開始に失敗しました",
			);
		} finally {
			setStarting(false);
		}
	}, [
		attachPane,
		canStart,
		createOrAttach,
		invalidate,
		session,
		write,
	]);

	const handleOpenTerminal = useCallback(() => {
		if (!session.attachedTabId || !session.attachedPaneId) {
			toast.error("ターミナルがまだアタッチされていません");
			return;
		}
		const tabs = useTabsStore.getState();
		tabs.setActiveTab(session.workspaceId, session.attachedTabId);
		if (session.workspaceId !== currentWorkspaceId) {
			toast.info(
				`ターミナルは別のワークスペース「${session.workspaceName ?? session.workspaceId}」内のタブです。手動でそのワークスペースに移動してください。`,
			);
		}
	}, [currentWorkspaceId, session]);

	const handleAbort = useCallback(async () => {
		try {
			await abort.mutateAsync({ sessionId: session.id });
			await invalidate();
			toast.success("中断しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "中断に失敗しました",
			);
		}
	}, [abort, invalidate, session.id]);

	const handleSendInput = useCallback(async () => {
		if (!intervention.trim()) return;
		try {
			await sendInput.mutateAsync({
				sessionId: session.id,
				data: `${intervention}\n`,
			});
			setIntervention("");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "送信に失敗しました",
			);
		}
	}, [intervention, sendInput, session.id]);

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
		<div className="flex flex-col gap-5 p-6 max-w-4xl text-sm">
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
					{canStart && (
						<Button
							type="button"
							size="sm"
							onClick={handleStart}
							disabled={starting}
						>
							{starting ? "開始中…" : "Start"}
						</Button>
					)}
					{isActive && !canStart && (
						<Button
							type="button"
							size="sm"
							variant="destructive"
							onClick={handleAbort}
						>
							中断
						</Button>
					)}
					{session.attachedTabId && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="gap-1"
							onClick={handleOpenTerminal}
							title="ワーカーのターミナルタブを前面に出す"
						>
							<HiMiniArrowTopRightOnSquare className="size-3.5" />
							ターミナルを開く
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
							disabled={isActive && !canStart}
							title={
								isActive && !canStart
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

			{session.verdictReason && (
				<DetailBlock label="直近の結果">
					<pre className="text-[11px] bg-muted rounded p-3 whitespace-pre-wrap max-h-48 overflow-auto leading-relaxed">
						{session.verdictReason}
					</pre>
				</DetailBlock>
			)}

			{isActive && !canStart && session.attachedPaneId && (
				<DetailBlock label="介入">
					<div className="flex gap-2">
						<Input
							value={intervention}
							onChange={(e) => setIntervention(e.target.value)}
							placeholder="ワーカーに送るテキストを入力（Enter で送信）"
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
							送信
						</Button>
					</div>
				</DetailBlock>
			)}

			<div className="text-[11px] text-muted-foreground pt-3 border-t">
				ヒント: Start するとワーカーはバックグラウンドのタブで動作します。
				『ターミナルを開く』でそのタブを前面に出すとライブで見たり
				直接入力したりできます。
			</div>
		</div>
	);
}

function DetailBlock({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
				{label}
			</div>
			{children}
		</div>
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
