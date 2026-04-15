import { buildAgentPromptCommand } from "@superset/shared/agent-command";
import { Button } from "@superset/ui/button";
import type { TodoSessionListEntry } from "main/todo-agent/types";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useMemo, useState } from "react";
import { HiMiniPlus, HiMiniXMark } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { useTabsStore } from "renderer/stores/tabs/store";
import { TodoModal } from "../TodoModal";

interface TodoManagerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Workspace that is currently active in the shell. Used as the default
	 * target for the "新しい TODO" button so creation stays in the
	 * expected workspace without forcing the user to pick one. The
	 * Manager itself lists sessions from all workspaces.
	 */
	currentWorkspaceId?: string;
}

type TodoSession = TodoSessionListEntry;

/**
 * Agent-Manager style full-view drawer for TODO autonomous sessions.
 *
 * Layout: dialog ~95vw × 86vh with a 2-pane split — a workspace-grouped
 * session list on the left and a detail view on the right. Inspired by
 * Google Antigravity's Agent Manager, Cursor 2.0's agents sidebar, and
 * Factory Desktop's sessions view.
 *
 * The manager does NOT embed a live PTY. The worker runs in a regular
 * terminal tab inside its own workspace and users can jump to it from
 * the tab bar to watch / intervene.
 */
export function TodoManager({
	open,
	onOpenChange,
	currentWorkspaceId,
}: TodoManagerProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [modalOpen, setModalOpen] = useState(false);
	const [filter, setFilter] = useState("");

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
				(s.workspaceName ?? "").toLowerCase().includes(needle),
		);
	}, [sessions, filter]);

	const grouped = useMemo(() => groupByWorkspace(filtered), [filtered]);

	const selected = useMemo(
		() =>
			filtered.find((s) => s.id === selectedId) ??
			filtered[0] ??
			null,
		[filtered, selectedId],
	);

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					className="w-[1360px] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] h-[85vh] max-h-[860px] p-0 gap-0 overflow-hidden flex flex-col"
					showCloseButton={false}
				>
					<DialogTitle className="sr-only">
						TODO Agent Manager
					</DialogTitle>
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
								onClick={() => setModalOpen(true)}
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

					<div className="grid grid-cols-[300px_1fr] flex-1 min-h-0">
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
								{grouped.map((group) => (
									<div key={group.key} className="pb-2">
										<div className="sticky top-0 z-10 bg-background/95 backdrop-blur px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b">
											{group.label}
											<span className="ml-1 text-muted-foreground/60">
												· {group.sessions.length}
											</span>
										</div>
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
									</div>
								))}
							</ScrollArea>
						</div>

						<ScrollArea>
							{selected ? (
								<SessionDetail session={selected} />
							) : (
								<div className="flex h-full items-center justify-center text-sm text-muted-foreground p-8">
									セッションを選択すると詳細が表示されます。
								</div>
							)}
						</ScrollArea>
					</div>
				</DialogContent>
			</Dialog>

			<TodoModal
				open={modalOpen}
				onOpenChange={setModalOpen}
				workspaceId={currentWorkspaceId ?? ""}
			/>
		</>
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
						: "bg-muted-foreground/40"; // queued / paused / unknown
	return <span className={cn("size-2 rounded-full shrink-0", color)} />;
}

interface SessionDetailProps {
	session: TodoSession;
}

function SessionDetail({ session }: SessionDetailProps) {
	const [intervention, setIntervention] = useState("");
	const [starting, setStarting] = useState(false);

	const utils = electronTrpc.useUtils();
	const attachPane = electronTrpc.todoAgent.attachPane.useMutation();
	const abort = electronTrpc.todoAgent.abort.useMutation();
	const sendInput = electronTrpc.todoAgent.sendInput.useMutation();
	const createOrAttach = electronTrpc.terminal.createOrAttach.useMutation();
	const write = electronTrpc.terminal.write.useMutation();

	const isActive =
		session.status === "queued" ||
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying";

	const canStart = session.status === "queued";

	const handleStart = useCallback(async () => {
		if (!canStart) return;
		setStarting(true);
		try {
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
			await utils.todoAgent.listAll.invalidate();
			await utils.todoAgent.list.invalidate({
				workspaceId: session.workspaceId,
			});
			toast.success(`開始しました: ${session.title}`);
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
		session,
		utils,
		write,
	]);

	const handleAbort = useCallback(async () => {
		try {
			await abort.mutateAsync({ sessionId: session.id });
			await utils.todoAgent.listAll.invalidate();
			toast.success("中断しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "中断に失敗しました",
			);
		}
	}, [abort, session.id, utils]);

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

	return (
		<div className="flex flex-col gap-5 p-6 max-w-3xl text-sm">
			<div className="flex items-start gap-3">
				<div className="flex-1">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<StatusDot status={session.status} />
						<span>{statusLabel(session)}</span>
						{session.workspaceName && (
							<>
								<span className="text-muted-foreground/50">·</span>
								<span>{session.workspaceName}</span>
							</>
						)}
						{session.projectName && (
							<>
								<span className="text-muted-foreground/50">·</span>
								<span>{session.projectName}</span>
							</>
						)}
					</div>
					<h2 className="text-lg font-semibold mt-1 leading-tight">
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
				ヒント: ワーカーは対応ワークスペースの通常のターミナルタブで動いています。
				タブバーからそのタブを開けば、ライブで見たり直接入力したりできます。
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
			[session.projectName, session.workspaceName].filter(Boolean).join(" / ") ||
			"(unknown workspace)";
		groups.set(key, { key, label, sessions: [session] });
	}
	return Array.from(groups.values());
}
