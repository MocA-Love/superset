import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import type {
	TodoSessionListEntry,
	TodoStreamEvent,
} from "main/todo-agent/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	HiMiniArrowPath,
	HiMiniChevronDown,
	HiMiniChevronRight,
	HiMiniPlus,
	HiMiniTrash,
	HiMiniXMark,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

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

	// Reset the event buffer + subscribe when selection changes. The
	// snapshot query paints the initial state; the subscription keeps us
	// live-updated without polling.
	useEffect(() => {
		setStreamEvents([]);
	}, [session.id]);

	const { data: initialStream } = electronTrpc.todoAgent.getStream.useQuery(
		{ sessionId: session.id },
		{ refetchInterval: false },
	);
	useEffect(() => {
		if (initialStream) {
			setStreamEvents(initialStream);
		}
	}, [initialStream]);

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
		<div className="flex flex-col gap-5 p-6 max-w-5xl text-sm">
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

			<TimingBlock session={session} />

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

			{(session.totalCostUsd != null || session.totalNumTurns != null) && (
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

			<DetailBlock label="Claude の応答 / ライブストリーム">
				<StreamView events={streamEvents} />
			</DetailBlock>

			{session.finalAssistantText && (
				<DetailBlock label="最終回答">
					<div className="text-xs leading-relaxed whitespace-pre-wrap bg-muted/60 rounded p-3 max-h-60 overflow-auto">
						{session.finalAssistantText}
					</div>
				</DetailBlock>
			)}

			{session.verdictReason && session.verdictPassed === false && (
				<DetailBlock label="直近の verify 失敗ログ">
					<pre className="text-[11px] bg-muted rounded p-3 whitespace-pre-wrap max-h-48 overflow-auto leading-relaxed">
						{session.verdictReason}
					</pre>
				</DetailBlock>
			)}

			<DetailBlock label="介入">
				<div className="flex gap-2">
					<Input
						value={intervention}
						onChange={(e) => setIntervention(e.target.value)}
						placeholder="次のターンに注入する指示を入力（Enter で送信）"
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
				{session.pendingIntervention && (
					<p className="text-[11px] text-muted-foreground mt-1">
						予約済み: {session.pendingIntervention}
					</p>
				)}
			</DetailBlock>

			<div className="text-[11px] text-muted-foreground pt-3 border-t">
				ヒント: ワーカーはバックグラウンドで headless 実行されます。
				ここに表示されるのが唯一のライブ出力です。介入指示はキューされ、
				次のイテレーション開始時に Claude に渡されます。
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

function formatDuration(
	startMs: number | null,
	endMs: number | null,
): string {
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
	if (events.length === 0) {
		return (
			<div className="text-xs text-muted-foreground bg-muted/40 rounded p-4">
				まだストリームイベントがありません。Start するとここにリアルタイムで
				Claude の応答・ツール使用・verify 結果が流れます。
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2 bg-muted/30 rounded p-3 max-h-[50vh] overflow-auto">
			{events.map((event) => (
				<StreamEventRow key={event.id} event={event} />
			))}
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
	return (
		<div className={cn("border rounded px-3 py-2 text-xs", color)}>
			<div className="flex items-center justify-between gap-2 mb-1">
				<span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
					[iter {event.iteration}] {event.label}
				</span>
				<span className="text-[10px] text-muted-foreground tabular-nums">
					{formatClock(event.ts)}
				</span>
			</div>
			<div className="whitespace-pre-wrap leading-relaxed">{event.text}</div>
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
