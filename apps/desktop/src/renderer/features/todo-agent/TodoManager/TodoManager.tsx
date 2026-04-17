import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import {
	Bot,
	CheckSquare,
	Cog,
	FileEdit,
	FilePen,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	ListTree,
	type LucideIcon,
	Plug,
	Search,
	Sparkles,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import type {
	TodoSessionListEntry,
	TodoStreamEvent,
} from "main/todo-agent/types";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
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
	HiMiniPaperClip,
	HiMiniPencil,
	HiMiniPlus,
	HiMiniSparkles,
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
import {
	type ClaudeEffortPick,
	type ClaudeModelPick,
	ClaudeRuntimePicker,
	DEFAULT_SENTINEL,
	fromPersistedEffort,
	fromPersistedModel,
	getClaudeEffortLabel,
	getClaudeModelLabel,
	toPersistedEffort,
	toPersistedModel,
} from "../ClaudeRuntimePicker";
import { ChangesSidebar } from "./ChangesSidebar";
import { AttachmentChips } from "./components/AttachmentChips";
import { AttachmentPreviewDialog } from "./components/AttachmentPreviewDialog";
import { PresetsDialog } from "./PresetsDialog";
import { SchedulesSection } from "./SchedulesSection";
import {
	type AttachmentRef,
	extractAttachmentRefs,
	stripAttachmentRefs,
} from "./utils/attachmentRefs";

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

/**
 * Read a File into a base64 string (without the `data:*;base64,` prefix)
 * using the browser's FileReader — Node's Buffer is not available in the
 * sandboxed Electron renderer.
 */
function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("FileReader returned non-string"));
				return;
			}
			const idx = result.indexOf("base64,");
			resolve(idx >= 0 ? result.slice(idx + "base64,".length) : result);
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("FileReader failed"));
		reader.readAsDataURL(file);
	});
}

export interface ImageAttachment {
	token: string;
	path: string;
	name: string;
}

/**
 * Expand `[imageN]` tokens embedded in a textarea value into the
 * full markdown image references (`![](abs-path)`) that Claude's
 * Read tool can open. Called at submit time so the user sees the
 * short tokens in the UI while Claude still receives the real
 * paths.
 */
export function resolveAttachmentTokens(
	text: string,
	attachments: ImageAttachment[],
): string {
	let out = text;
	for (const a of attachments) {
		out = out.split(a.token).join(`![](${a.path})`);
	}
	return out;
}

type ImagePasteTextareaProps = Omit<
	React.ComponentProps<typeof Textarea>,
	"onPaste" | "onDrop" | "onDragOver"
> & {
	value: string;
	onValueChange: (next: string) => void;
	attachments: ImageAttachment[];
	/**
	 * Accepts either a next array or a functional updater so rapid
	 * consecutive pastes apply sequentially instead of colliding on a
	 * stale snapshot (React state updates are batched).
	 */
	onAttachmentsChange: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
};

/**
 * Drop-in replacement for `<Textarea>` that accepts pasted or
 * dropped images. The image is uploaded via `todoAgent.saveAttachment`
 * and a short `[imageN]` token is inserted at the caret instead of
 * the long absolute path. At submit time the caller resolves the
 * tokens back to `![](abs-path)` markdown via
 * `resolveAttachmentTokens()`. Claude's Read tool opens the real
 * path and picks up the image content.
 *
 * Also tracks attachments as chips above the textarea so the user
 * can see what they have attached, and orphan-prunes the list if
 * the user manually deletes a token from the text.
 */
function ImagePasteTextarea({
	value,
	onValueChange,
	attachments,
	onAttachmentsChange,
	...rest
}: ImagePasteTextareaProps) {
	const saveMut = electronTrpc.todoAgent.saveAttachment.useMutation();
	const [dropHighlight, setDropHighlight] = useState(false);

	// Counter stored in a ref so rapid consecutive pastes don't collide
	// on a stale `attachments` snapshot — useState updates are batched,
	// so reading `attachments.length` inside two paste handlers fired
	// within the same render would hand out the same token.
	const tokenSeqRef = useRef(0);
	useEffect(() => {
		// Re-sync the seq with the highest existing [imageN] in the
		// attachments list so renumbering stays sensible after removes.
		let max = 0;
		for (const a of attachments) {
			const m = /^\[image(\d+)\]$/.exec(a.token);
			if (m?.[1]) max = Math.max(max, Number(m[1]));
		}
		if (max > tokenSeqRef.current) tokenSeqRef.current = max;
	}, [attachments]);
	const nextTokenName = useCallback((): string => {
		tokenSeqRef.current += 1;
		return `[image${tokenSeqRef.current}]`;
	}, []);

	// Orphan-prune: when the user edits the textarea text directly
	// and removes a token by hand, drop that attachment from the
	// sidebar chip list so state stays consistent.
	const handleTextChange = useCallback(
		(next: string) => {
			onValueChange(next);
			onAttachmentsChange((prev) => {
				const stillReferenced = prev.filter((a) => next.includes(a.token));
				return stillReferenced.length === prev.length ? prev : stillReferenced;
			});
		},
		[onAttachmentsChange, onValueChange],
	);

	const processFile = useCallback(
		async (file: File, target: HTMLTextAreaElement | null) => {
			if (!file.type.startsWith("image/")) {
				toast.error("画像ファイルのみ添付できます");
				return;
			}
			const MAX = 10 * 1024 * 1024;
			if (file.size > MAX) {
				toast.error("画像サイズが大きすぎます（10MB まで）");
				return;
			}
			try {
				const dataBase64 = await fileToBase64(file);
				const { path: absPath } = await saveMut.mutateAsync({
					fileName: file.name || "image.png",
					mimeType: file.type || "image/png",
					dataBase64,
				});
				const token = nextTokenName();
				const insert = token;
				if (target) {
					const start = target.selectionStart ?? value.length;
					const end = target.selectionEnd ?? value.length;
					const next = value.slice(0, start) + insert + value.slice(end);
					onValueChange(next);
					requestAnimationFrame(() => {
						const pos = start + insert.length;
						target.setSelectionRange(pos, pos);
						target.focus();
					});
				} else {
					onValueChange(`${value}${insert}`);
				}
				onAttachmentsChange((prev) => [
					...prev,
					{ token, path: absPath, name: file.name || "image.png" },
				]);
				toast.success(`画像を添付しました: ${token}`);
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "画像の保存に失敗しました",
				);
			}
		},
		[nextTokenName, onAttachmentsChange, onValueChange, saveMut, value],
	);

	const removeAttachment = useCallback(
		(token: string) => {
			// Drop every occurrence of the token from the text, then the
			// attachment itself.
			const nextText = value.split(token).join("");
			onValueChange(nextText);
			onAttachmentsChange((prev) => prev.filter((a) => a.token !== token));
		},
		[onAttachmentsChange, onValueChange, value],
	);

	return (
		<div className="flex flex-col gap-1.5">
			{attachments.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{attachments.map((a) => (
						<span
							key={a.token}
							className="inline-flex items-center gap-1 text-[10px] rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5"
							title={`${a.token} · ${a.path}`}
						>
							<HiMiniPaperClip className="size-3 text-muted-foreground/80" />
							<span className="truncate max-w-[160px]">{a.name}</span>
							<button
								type="button"
								onClick={() => removeAttachment(a.token)}
								className="ml-0.5 text-muted-foreground hover:text-destructive"
								title="添付を解除"
							>
								<HiMiniXMark className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}
			<Textarea
				{...rest}
				value={value}
				onChange={(e) => handleTextChange(e.target.value)}
				className={cn(
					rest.className,
					"transition",
					dropHighlight && "ring-2 ring-primary/50 ring-offset-1",
				)}
				onPaste={(e) => {
					const items = Array.from(e.clipboardData?.items ?? []);
					const imgItem = items.find((i) => i.type.startsWith("image/"));
					if (!imgItem) return;
					const file = imgItem.getAsFile();
					if (!file) return;
					e.preventDefault();
					void processFile(file, e.currentTarget);
				}}
				onDrop={(e) => {
					setDropHighlight(false);
					const file = e.dataTransfer.files?.[0];
					if (!file) return;
					if (!file.type.startsWith("image/")) return;
					e.preventDefault();
					void processFile(file, e.currentTarget);
				}}
				onDragOver={(e) => {
					if (
						Array.from(e.dataTransfer.items ?? []).some(
							(i) => i.kind === "file",
						)
					) {
						e.preventDefault();
						setDropHighlight(true);
					}
				}}
				onDragLeave={() => setDropHighlight(false)}
			/>
		</div>
	);
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
	currentWorkspaceId,
	onRequestNewTodo: _onRequestNewTodo,
}: TodoManagerProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
		new Set(),
	);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [changesSidebarCollapsed, setChangesSidebarCollapsed] = useState(false);
	const [presetsDialogOpen, setPresetsDialogOpen] = useState(false);
	const [sidebarTab, setSidebarTab] = useState<"tasks" | "schedules">("tasks");
	// Inline TODO composer (replaces the old separate modal). Matches
	// Antigravity IDE's "new conversation inside manager" UX.
	const [composerOpen, setComposerOpen] = useState(false);

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
						<span className="text-xs text-muted-foreground"></span>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							className="h-7 gap-1 px-2.5 text-xs rounded-md"
							onClick={() => {
								setComposerOpen(true);
								setSelectedId(null);
							}}
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
						<div className="p-1.5 border-b shrink-0 flex gap-1">
							<button
								type="button"
								onClick={() => setSidebarTab("tasks")}
								className={cn(
									"flex-1 text-xs py-1 rounded-md transition-colors",
									sidebarTab === "tasks"
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent/40",
								)}
							>
								タスク
							</button>
							<button
								type="button"
								onClick={() => setSidebarTab("schedules")}
								className={cn(
									"flex-1 text-xs py-1 rounded-md transition-colors",
									sidebarTab === "schedules"
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent/40",
								)}
							>
								スケジュール
							</button>
						</div>
						{sidebarTab === "schedules" ? (
							<SchedulesSection />
						) : (
							<>
								<div className="p-2 border-b shrink-0 flex items-center justify-between gap-2">
									<span className="text-xs text-muted-foreground">
										{(sessions?.length ?? 0) > 0
											? `${sessions?.length} 件のタスク`
											: "タスクなし"}
									</span>
									<Button
										type="button"
										size="sm"
										className="h-7 gap-1 px-2.5 text-xs rounded-md"
										onClick={() => setComposerOpen(true)}
									>
										<HiMiniPlus className="size-4" />
										新規
									</Button>
								</div>
								<div className="p-2 border-b shrink-0">
									<Input
										value={filter}
										onChange={(e) => setFilter(e.target.value)}
										placeholder="絞り込み（タイトル / ワークスペース）"
										className="h-8 text-xs rounded-md"
									/>
								</div>
								<ScrollArea className="flex-1 min-h-0">
									{grouped.length === 0 && (
										<p className="text-xs text-muted-foreground px-3 py-6">
											{(sessions?.length ?? 0) === 0
												? "まだ TODO セッションはありません。『新規』から作成してください。"
												: "条件に一致するセッションがありません。"}
										</p>
									)}
									{grouped.map((group) => {
										const collapsed = collapsedGroups.has(group.key);
										return (
											<div key={group.key} className="pb-1 min-w-0 w-full">
												<Tooltip delayDuration={300}>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() => toggleGroup(group.key)}
															className="sticky top-0 z-10 bg-background/95 backdrop-blur w-full flex items-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b hover:bg-accent/40 transition min-w-0"
														>
															{collapsed ? (
																<HiMiniChevronRight className="size-3 shrink-0" />
															) : (
																<HiMiniChevronDown className="size-3 shrink-0" />
															)}
															<span className="flex-1 text-left truncate min-w-0">
																{group.label}
															</span>
															<span className="text-muted-foreground/60 shrink-0">
																{group.sessions.length}
															</span>
														</button>
													</TooltipTrigger>
													<TooltipContent
														side="right"
														align="start"
														className="max-w-[360px]"
													>
														<span className="text-[11px] break-all">
															{group.label}
														</span>
													</TooltipContent>
												</Tooltip>
												{!collapsed && (
													<div className="flex flex-col px-1.5 py-1 gap-0.5">
														{group.sessions.map((session) => (
															<SessionRow
																key={session.id}
																session={session}
																isSelected={selected?.id === session.id}
																onSelect={() => {
																	setSelectedId(session.id);
																	setComposerOpen(false);
																}}
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
							</>
						)}
						<div className="shrink-0 border-t p-1.5">
							<button
								type="button"
								onClick={() => setPresetsDialogOpen(true)}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition"
								title="テンプレート / 設定を管理"
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
							<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
								<p>セッションを選択すると詳細が表示されます。</p>
								<Button
									type="button"
									size="sm"
									className="gap-1 h-8"
									onClick={() => setComposerOpen(true)}
								>
									<HiMiniPlus className="size-4" />
									新しい TODO を作成
								</Button>
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
				{/*
				  Rendered inside DialogContent (same pattern as
				  ScheduleEditorDialog in SchedulesSection) so the
				  settings dialog stacks on top of the Manager without
				  causing the outer Dialog to close. See Issue #217.
				*/}
				<PresetsDialog
					open={presetsDialogOpen}
					onOpenChange={setPresetsDialogOpen}
				/>
				<Dialog open={composerOpen} onOpenChange={setComposerOpen}>
					<DialogContent
						className="!w-[min(1080px,calc(100vw-3rem))] !max-w-[min(1080px,calc(100vw-3rem))] sm:!max-w-[min(1080px,calc(100vw-3rem))] h-[84vh] max-h-[900px] p-0 gap-0 overflow-hidden flex flex-col rounded-xl"
						showCloseButton={false}
					>
						<DialogTitle className="sr-only">新しい TODO</DialogTitle>
						{composerOpen && (
							<TodoComposer
								currentWorkspaceId={currentWorkspaceId}
								onCreated={(id) => {
									setComposerOpen(false);
									setSelectedId(id);
								}}
								onCancel={() => setComposerOpen(false)}
							/>
						)}
					</DialogContent>
				</Dialog>
			</DialogContent>
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
		session.status === "verifying" ||
		session.status === "waiting";

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

	const status = statusLabel(session);

	return (
		<div
			className={cn(
				"group relative rounded-lg transition flex items-stretch",
				isSelected ? "bg-accent" : "hover:bg-accent/50",
			)}
		>
			<Tooltip delayDuration={500}>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={onSelect}
						className="text-left flex-1 min-w-0 pl-2.5 pr-1 py-2"
					>
						<div className="flex items-center gap-2 min-w-0">
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
								<span className="text-xs font-medium line-clamp-1 flex-1 min-w-0">
									{session.title}
								</span>
							)}
						</div>
						<div className="flex items-center justify-between gap-2 pl-4 mt-0.5 min-w-0">
							<span className="text-[10px] text-muted-foreground line-clamp-1 flex-1 min-w-0">
								{status}
							</span>
							<span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
								{formatRelativeTime(session.createdAt)}
							</span>
						</div>
					</button>
				</TooltipTrigger>
				{!renaming && (
					<TooltipContent side="right" align="start" className="max-w-[360px]">
						<div className="flex flex-col gap-0.5">
							<span className="text-[11px] font-medium break-words">
								{session.title}
							</span>
							<span className="text-[10px] opacity-70 break-words">
								{status}
							</span>
						</div>
					</TooltipContent>
				)}
			</Tooltip>
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
						: status === "waiting"
							? "bg-sky-500 animate-pulse"
							: "bg-muted-foreground/40";
	return <span className={cn("size-2 rounded-full shrink-0", color)} />;
}

interface SessionDetailProps {
	session: TodoSession;
	onDeleted: () => void;
}

function SessionDetail({ session, onDeleted }: SessionDetailProps) {
	const [intervention, setIntervention] = useState("");
	const [interventionAttachments, setInterventionAttachments] = useState<
		ImageAttachment[]
	>([]);
	const [starting, setStarting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [streamEvents, setStreamEvents] = useState<TodoStreamEvent[]>([]);
	const [editingField, setEditingField] = useState<
		"description" | "goal" | null
	>(null);
	const [editDraft, setEditDraft] = useState("");
	const [previewAttachment, setPreviewAttachment] =
		useState<AttachmentRef | null>(null);

	const descriptionAttachments = useMemo(
		() => extractAttachmentRefs(session.description),
		[session.description],
	);
	const descriptionBody = useMemo(
		() =>
			descriptionAttachments.length > 0
				? stripAttachmentRefs(session.description)
				: session.description,
		[session.description, descriptionAttachments.length],
	);
	const goalAttachments = useMemo(
		() => extractAttachmentRefs(session.goal ?? ""),
		[session.goal],
	);
	const goalBody = useMemo(
		() =>
			goalAttachments.length > 0
				? stripAttachmentRefs(session.goal ?? "")
				: (session.goal ?? ""),
		[session.goal, goalAttachments.length],
	);

	const utils = electronTrpc.useUtils();
	const startMut = electronTrpc.todoAgent.start.useMutation();
	const abortMut = electronTrpc.todoAgent.abort.useMutation();
	const sendInputMut = electronTrpc.todoAgent.sendInput.useMutation();
	const deleteMut = electronTrpc.todoAgent.delete.useMutation();
	const rerunMut = electronTrpc.todoAgent.rerun.useMutation();
	const updateFieldsMut = electronTrpc.todoAgent.updateFields.useMutation();

	const isActive =
		session.status === "queued" ||
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying" ||
		// `waiting` is a ScheduleWakeup-paused session the scheduler will
		// resume automatically — treat it as active UX-wise so intervene
		// / abort remain reachable during the pause.
		session.status === "waiting";

	const canStart =
		session.status === "queued" ||
		session.status === "failed" ||
		session.status === "aborted" ||
		session.status === "escalated" ||
		// Manual "wake now" overrides the remaining ScheduleWakeup delay.
		session.status === "waiting" ||
		// Resume a completed session — supervisor issues `--resume` so the
		// next turn continues the same Claude conversation.
		(session.status === "done" && session.claudeSessionId != null);
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
		// Also drop any in-progress description/goal edit state from
		// the previously selected session — SessionDetail is reused
		// across selections, so leaving stale edit state would let
		// the user "save" into whichever session happens to be picked
		// next.
		setEditingField(null);
		setEditDraft("");
		setPreviewAttachment(null);
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
			const resolved = resolveAttachmentTokens(
				intervention.trim(),
				interventionAttachments,
			);
			await sendInputMut.mutateAsync({
				sessionId: session.id,
				data: resolved,
			});
			setIntervention("");
			setInterventionAttachments([]);
			toast.success("メッセージを送信しました");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "送信に失敗しました",
			);
		}
	}, [intervention, interventionAttachments, sendInputMut, session.id]);

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

	// `preparing` is still editable: the supervisor has not spawned
	// Claude yet, and prepareArtifacts rewrites goal.md before Claude
	// reads it, so an edit during preparing still takes effect.
	// `waiting` (ScheduleWakeup-paused) is intentionally excluded —
	// the backend `updateFields` mutation does not allow that status,
	// so saving would deterministically fail with PRECONDITION_FAILED.
	// Users who want to edit a waiting session abort it first.
	const canEditFields =
		(canStart && session.status !== "waiting") ||
		session.status === "preparing";

	// Bail out of any in-flight edit the moment the session starts
	// actually running — e.g. a queued session whose turn arrived
	// mid-edit — so the user doesn't hit Save only to get rejected by
	// the backend guard. Only cancel on running/verifying; terminal
	// states stay editable (rerun path).
	useEffect(() => {
		if (!editingField) return;
		if (session.status !== "running" && session.status !== "verifying") return;
		setEditingField(null);
		setEditDraft("");
		toast.warning(
			"タスクの実行が開始されたため編集を中止しました。中断してから再度編集してください。",
		);
	}, [editingField, session.status]);

	const startEditField = useCallback(
		(field: "description" | "goal") => {
			setEditingField(field);
			setEditDraft(
				field === "description" ? session.description : (session.goal ?? ""),
			);
		},
		[session.description, session.goal],
	);

	const cancelEditField = useCallback(() => {
		setEditingField(null);
		setEditDraft("");
	}, []);

	const commitEditField = useCallback(async () => {
		if (!editingField) return;
		const trimmed = editDraft.trim();
		if (editingField === "description") {
			if (trimmed.length === 0) {
				toast.error("『やって欲しいこと』は空にできません");
				return;
			}
			try {
				await updateFieldsMut.mutateAsync({
					sessionId: session.id,
					description: trimmed,
				});
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "更新に失敗しました",
				);
				return;
			}
		} else {
			try {
				await updateFieldsMut.mutateAsync({
					sessionId: session.id,
					goal: trimmed.length > 0 ? trimmed : undefined,
					clearGoal: trimmed.length === 0,
				});
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "更新に失敗しました",
				);
				return;
			}
		}
		await invalidate();
		setEditingField(null);
		setEditDraft("");
		toast.success("保存しました");
	}, [editingField, editDraft, updateFieldsMut, session.id, invalidate]);

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
						<DetailBlock
							label="やって欲しいこと"
							action={
								canEditFields && editingField !== "description" ? (
									<button
										type="button"
										className="text-[10px] text-muted-foreground hover:text-foreground transition"
										onClick={() => startEditField("description")}
									>
										編集
									</button>
								) : null
							}
						>
							{editingField === "description" ? (
								<div className="flex flex-col gap-1.5">
									<Textarea
										value={editDraft}
										onChange={(e) => setEditDraft(e.target.value)}
										rows={5}
										className="text-xs"
										autoFocus
									/>
									<div className="flex items-center gap-1.5">
										<Button
											type="button"
											size="sm"
											className="h-6 px-2 text-[11px]"
											onClick={commitEditField}
											disabled={updateFieldsMut.isPending}
										>
											保存
										</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											className="h-6 px-2 text-[11px]"
											onClick={cancelEditField}
										>
											キャンセル
										</Button>
									</div>
								</div>
							) : (
								<div>
									{descriptionBody.length > 0 ? (
										<div className="whitespace-pre-wrap text-xs leading-relaxed">
											{descriptionBody}
										</div>
									) : descriptionAttachments.length > 0 ? (
										<div className="text-xs text-muted-foreground">
											（添付のみ）
										</div>
									) : null}
									<AttachmentChips
										attachments={descriptionAttachments}
										onSelect={setPreviewAttachment}
									/>
								</div>
							)}
						</DetailBlock>

						<DetailBlock
							label="ゴール"
							action={
								canEditFields && editingField !== "goal" ? (
									<button
										type="button"
										className="text-[10px] text-muted-foreground hover:text-foreground transition"
										onClick={() => startEditField("goal")}
									>
										編集
									</button>
								) : null
							}
						>
							{editingField === "goal" ? (
								<div className="flex flex-col gap-1.5">
									<Textarea
										value={editDraft}
										onChange={(e) => setEditDraft(e.target.value)}
										rows={3}
										className="text-xs"
										placeholder="完了条件（空欄可）"
										autoFocus
									/>
									<div className="flex items-center gap-1.5">
										<Button
											type="button"
											size="sm"
											className="h-6 px-2 text-[11px]"
											onClick={commitEditField}
											disabled={updateFieldsMut.isPending}
										>
											保存
										</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											className="h-6 px-2 text-[11px]"
											onClick={cancelEditField}
										>
											キャンセル
										</Button>
									</div>
								</div>
							) : session.goal?.trim() ? (
								<div>
									{goalBody.length > 0 ? (
										<div className="whitespace-pre-wrap text-xs leading-relaxed">
											{goalBody}
										</div>
									) : goalAttachments.length > 0 ? (
										<div className="text-xs text-muted-foreground">
											（添付のみ）
										</div>
									) : null}
									<AttachmentChips
										attachments={goalAttachments}
										onSelect={setPreviewAttachment}
									/>
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

						<div className="grid grid-cols-2 gap-4">
							<DetailBlock label="Claude モデル">
								<div className="text-xs">
									{getClaudeModelLabel(session.claudeModel)}
								</div>
							</DetailBlock>
							<DetailBlock label="思考 effort">
								<div className="text-xs">
									{getClaudeEffortLabel(session.claudeEffort)}
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

						{session.status === "waiting" && session.waitingUntil != null && (
							<DetailBlock label="待機終了まで">
								<div className="text-xs bg-muted/40 rounded-lg p-3 border border-border/40 flex flex-col gap-1">
									<div className="font-mono text-sm">
										{formatWaitingCountdown(session.waitingUntil)}
									</div>
									{session.waitingReason && (
										<div className="text-[11px] text-muted-foreground break-words">
											{session.waitingReason}
										</div>
									)}
								</div>
							</DetailBlock>
						)}

						{session.finalAssistantText && (
							<DetailBlock
								label={session.status === "waiting" ? "待機中" : "最終回答"}
								action={
									<CopyIconButton
										value={session.finalAssistantText}
										title={
											session.status === "waiting"
												? "待機前の応答をコピー"
												: "最終回答をコピー"
										}
									/>
								}
							>
								<div className="text-xs bg-muted/40 rounded-lg p-3 border border-border/40 overflow-hidden [&_*]:break-words [&_*]:min-w-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_code]:break-all [&_a]:break-all">
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
					<div className="flex-1 min-h-0 px-5 pb-5 relative">
						<StreamView events={streamEvents} />
					</div>
				</div>
			</div>

			{/* Footer: intervention input, pinned. Always reachable. */}
			<div className="shrink-0 border-t px-6 py-3 bg-background">
				<div className="flex items-end gap-2">
					<div className="flex-1">
						<ImagePasteTextarea
							value={intervention}
							onValueChange={setIntervention}
							attachments={interventionAttachments}
							onAttachmentsChange={setInterventionAttachments}
							placeholder="メッセージを送信（Enter で送信、Shift+Enter で改行、画像は貼り付け/ドロップ可）"
							rows={2}
							className="resize-none min-h-[44px] max-h-40 text-xs leading-relaxed"
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void handleSendInput();
								}
							}}
						/>
					</div>
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
				<div className="flex items-center justify-between gap-3 mt-1.5">
					<p className="text-[10px] text-muted-foreground line-clamp-1">
						{session.pendingIntervention ? (
							<>
								送信予定（数秒以内に自動割り込み）:{" "}
								{session.pendingIntervention}
							</>
						) : (
							<>
								ヒント:
								実行中でもメッセージを送ると、現在のターンを中断して即座に割り込みます。完了済み/失敗のタスクに送ると、過去のセッションを再開して続きから対話します。
							</>
						)}
					</p>
				</div>
			</div>
			<AttachmentPreviewDialog
				attachment={previewAttachment}
				open={previewAttachment != null}
				onOpenChange={(o) => {
					if (!o) setPreviewAttachment(null);
				}}
			/>
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

/**
 * Tree node for the live stream UI.
 *
 * `tool` nodes pair a `tool_use` with its `tool_result` (matched by
 * `toolUseId`, NOT by positional proximity) and may contain `children`
 * — sub-agent activity that Claude Code emits with `parent_tool_use_id`
 * pointing at the parent Agent/Task tool call. This matches the VSCode
 * Claude Code extension's presentation: a Task tool folds all of its
 * subagent's tool calls underneath itself.
 *
 * `message` nodes are anything non-tool (assistant text, result, error,
 * system_init, raw). They can also appear as `children` of a tool when
 * they were emitted inside a subagent context.
 */
type StreamItem =
	| { type: "message"; id: string; event: TodoStreamEvent }
	| {
			type: "tool";
			id: string;
			toolUse: TodoStreamEvent;
			toolResult: TodoStreamEvent | null;
			children: StreamItem[];
	  };

/**
 * Build the render tree from the flat event buffer.
 *
 * Step 1: Pair tool_use ↔ tool_result by `toolUseId` (not position).
 *         Unpaired `tool_result` events fall back to a standalone
 *         message row so we never silently drop data. Legacy events
 *         in `stream.jsonl` from before this field existed are paired
 *         positionally (the original heuristic) to keep replay of
 *         historical sessions intact.
 * Step 2: Nest items under their `parentToolUseId` when it points at a
 *         known tool node. Items whose parent is unknown stay at the
 *         top level — that preserves visibility during a mid-session
 *         restart where we replayed the jsonl without the Agent frame
 *         that spawned them.
 */
function buildStreamTree(events: TodoStreamEvent[]): StreamItem[] {
	const toolNodeById = new Map<string, Extract<StreamItem, { type: "tool" }>>();
	const resultByUseId = new Map<string, TodoStreamEvent>();
	const knownToolUseIds = new Set<string>();
	const allItems: StreamItem[] = [];

	// Index tool_results with ids up front so we can attach them to
	// their tool_use even if the events were appended out of order.
	// We also collect the set of tool_use ids that exist anywhere in
	// the stream so a tool_result encountered BEFORE its matching
	// tool_use can be skipped — otherwise it gets rendered as a
	// standalone message AND later attached to the tool card via
	// resultByUseId, producing duplicate output for the same result.
	for (const ev of events) {
		if (ev.kind === "tool_use" && ev.toolUseId) {
			knownToolUseIds.add(ev.toolUseId);
		}
		if (ev.kind === "tool_result" && ev.toolUseId) {
			resultByUseId.set(ev.toolUseId, ev);
		}
	}

	// Most-recent tool_use node that lacks a toolUseId and is still
	// awaiting its result. Used only for legacy positional pairing.
	let pendingLegacyTool: Extract<StreamItem, { type: "tool" }> | null = null;

	for (const ev of events) {
		if (!ev) continue;
		if (ev.kind === "tool_use") {
			const matchedResult = ev.toolUseId
				? (resultByUseId.get(ev.toolUseId) ?? null)
				: null;
			const node: Extract<StreamItem, { type: "tool" }> = {
				type: "tool",
				id: ev.id,
				toolUse: ev,
				toolResult: matchedResult,
				children: [],
			};
			if (ev.toolUseId) toolNodeById.set(ev.toolUseId, node);
			allItems.push(node);
			pendingLegacyTool = !ev.toolUseId && !matchedResult ? node : null;
			continue;
		}
		if (ev.kind === "tool_result") {
			// Modern path: a matching tool_use exists in the stream
			// somewhere and will (or already did) attach this result
			// via resultByUseId. Skip the standalone render either
			// way to avoid duplication when events arrive out of
			// order (tool_result before tool_use).
			if (ev.toolUseId && knownToolUseIds.has(ev.toolUseId)) continue;
			// Legacy fallback: attach to the most recent dangling
			// tool_use without a toolUseId (same positional heuristic
			// the old impl used). Keeps replay of pre-upgrade sessions
			// from losing pairs.
			if (!ev.toolUseId && pendingLegacyTool) {
				pendingLegacyTool.toolResult = ev;
				pendingLegacyTool = null;
				continue;
			}
			allItems.push({ type: "message", id: ev.id, event: ev });
			continue;
		}
		allItems.push({ type: "message", id: ev.id, event: ev });
	}

	// Nest items under their parent Agent/Task tool node.
	const roots: StreamItem[] = [];
	for (const item of allItems) {
		const parentId =
			item.type === "tool"
				? item.toolUse.parentToolUseId
				: item.event.parentToolUseId;
		if (parentId) {
			const parent = toolNodeById.get(parentId);
			if (parent) {
				parent.children.push(item);
				continue;
			}
		}
		roots.push(item);
	}
	return roots;
}

function StreamView({ events }: { events: TodoStreamEvent[] }) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const pinnedToBottomRef = useRef(true);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom =
			el.scrollHeight - (el.scrollTop + el.clientHeight);
		pinnedToBottomRef.current = distanceFromBottom < 40;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: events.length intentional
	useEffect(() => {
		if (!pinnedToBottomRef.current) return;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [events.length]);

	const items = useMemo(() => buildStreamTree(events), [events]);

	return (
		<div
			ref={scrollRef}
			onScroll={handleScroll}
			className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-gradient-to-b from-muted/10 to-muted/30 rounded px-3 py-2"
		>
			{events.length === 0 ? (
				<div className="text-xs text-muted-foreground p-2">
					まだストリームイベントがありません。Start するとここにリアルタイムで
					Claude の応答・ツール使用・verify 結果が流れます。
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{items.map((item) => (
						<StreamNode key={item.id} item={item} />
					))}
				</div>
			)}
		</div>
	);
}

function StreamNode({ item }: { item: StreamItem }) {
	if (item.type === "tool") {
		return <ToolCallCard item={item} />;
	}
	return <MessageRow event={item.event} />;
}

/**
 * Styling intent:
 * - Tool name gets a distinct subtle color tied to the tool kind (Bash,
 *   Read, Edit, Task/Agent, …) so scanning the stream is fast.
 * - When the tool is still running (no tool_result yet) the name shimmers
 *   with a pure-CSS `ShinyText` so the user sees it as "live".
 * - Expanding the card reveals IN / OUT panes plus — for Agent/Task calls
 *   — the nested subagent activity tree. Matches the VSCode extension.
 */
function ToolCallCard({
	item,
}: {
	item: Extract<StreamItem, { type: "tool" }>;
}) {
	const { toolUse, toolResult, children } = item;
	const toolName = toolUse.label;
	// Claude Code emits MCP tool names as `mcp__<server>__<tool>`. That
	// raw form is fine for routing but ugly in the stream UI. Render as
	// `server tool` instead; the palette also uses a dedicated MCP icon
	// so it still visually separates from built-in tools.
	const displayName = formatToolDisplayName(toolName);
	const secondary = extractSecondaryInfo(toolName, toolUse.text);
	const hasResult = toolResult != null;
	const isRunning = !hasResult;
	const palette = getToolPalette(toolName);
	const Icon = palette.icon;
	const hasChildren = children.length > 0;
	// Controlled `open` so React does not clobber the user's toggles on
	// re-render (streaming events cause frequent re-renders). Initial
	// value auto-expands Agent/Task cards that already have children so
	// the user can see the subagent's nested activity without clicking.
	const [open, setOpen] = useState(hasChildren);
	// Auto-open the card the first time a child arrives in this tool
	// (i.e. the subagent just started doing something). The user can
	// still close it back down; we only nudge on the 0 → 1 transition.
	const prevHadChildren = useRef(hasChildren);
	useEffect(() => {
		if (!prevHadChildren.current && hasChildren) setOpen(true);
		prevHadChildren.current = hasChildren;
	}, [hasChildren]);

	return (
		<details
			className="group text-xs rounded-md border border-border/40 bg-muted/20 hover:bg-muted/30 transition-colors overflow-hidden"
			open={open}
			onToggle={(e) => setOpen(e.currentTarget.open)}
		>
			<summary
				className={cn(
					"list-none cursor-pointer select-none flex items-center gap-2 py-1 px-2 overflow-hidden",
					palette.accent,
				)}
			>
				<span className="shrink-0 text-muted-foreground/60 group-open:rotate-90 transition-transform text-[10px]">
					▶
				</span>
				<span
					className={cn(
						"shrink-0 grid place-items-center w-4 h-4 rounded-sm",
						palette.iconBg,
					)}
				>
					<Icon className={cn("w-3 h-3", palette.iconColor)} />
				</span>
				{isRunning ? (
					<ShinyText className={cn("font-semibold shrink-0", palette.name)}>
						{displayName}
					</ShinyText>
				) : (
					<span className={cn("font-semibold shrink-0", palette.name)}>
						{displayName}
					</span>
				)}
				{secondary && (
					<span className="font-mono text-[0.85em] text-foreground/70 break-all line-clamp-1 min-w-0 flex-1">
						{secondary}
					</span>
				)}
				{hasChildren && (
					<span className="shrink-0 text-[10px] font-mono text-muted-foreground/80 px-1 rounded bg-muted/50 border border-border/40">
						{children.length}
					</span>
				)}
				{isRunning && (
					<span className="shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
				)}
			</summary>
			<div className="border-t border-border/30 bg-background/40">
				<div className="grid grid-cols-[max-content_1fr] text-[11px]">
					<div className="col-span-2 grid grid-cols-subgrid border-b border-border/30">
						<div className="text-muted-foreground/60 font-mono text-[0.85em] py-1 px-2 bg-muted/30">
							IN
						</div>
						<div className="py-1 px-2 overflow-hidden">
							<pre className="whitespace-pre-wrap break-all font-mono leading-relaxed text-foreground/80 max-h-32 overflow-y-auto">
								{toolUse.text}
							</pre>
						</div>
					</div>
					<div className="col-span-2 grid grid-cols-subgrid">
						<div className="text-muted-foreground/60 font-mono text-[0.85em] py-1 px-2 bg-muted/30">
							OUT
						</div>
						<div className="py-1 px-2 overflow-hidden">
							{toolResult ? (
								<pre className="whitespace-pre-wrap break-all font-mono leading-relaxed text-foreground/80 max-h-64 overflow-y-auto">
									{toolResult.text}
								</pre>
							) : (
								<ShinyText className="text-muted-foreground">実行中…</ShinyText>
							)}
						</div>
					</div>
				</div>
				{hasChildren && (
					<div className="relative pl-4 pr-2 py-1.5 border-t border-border/30 bg-muted/10">
						<div
							className="absolute left-2 top-0 bottom-0 w-px bg-border/40"
							aria-hidden
						/>
						<div className="flex flex-col gap-1">
							{children.map((child) => (
								<StreamNode key={child.id} item={child} />
							))}
						</div>
					</div>
				)}
			</div>
		</details>
	);
}

function extractSecondaryInfo(_toolName: string, text: string): string | null {
	const colonIdx = text.indexOf(": ");
	if (colonIdx > 0 && colonIdx < 60) {
		return text.slice(colonIdx + 2, colonIdx + 120).trim();
	}
	if (text.length <= 120) return text;
	return text.slice(0, 80);
}

/**
 * Lightweight, dependency-free shimmering text. A pure-CSS animated
 * linear-gradient clipped to the text serves as the "currently running"
 * affordance for tool names and the OUT-pending label. The actual
 * animation lives in `globals.css` under `.animate-shine` — this
 * component is just a small wrapper so callers don't have to remember
 * the class name.
 */
function ShinyText({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span className={cn("inline-block animate-shine", className)}>
			{children}
		</span>
	);
}

/**
 * Render tool names for the stream UI. Claude Code emits MCP tools as
 * `mcp__<server>__<tool>`; the `mcp__` prefix is an internal routing
 * marker that adds no signal for the human reading the stream, so we
 * strip it and render `<server> <tool>` space-separated. Built-in tools
 * (Read, Bash, …) fall through untouched.
 */
function formatToolDisplayName(rawName: string): string {
	if (!rawName.startsWith("mcp__")) return rawName;
	const parts = rawName.slice("mcp__".length).split("__");
	if (parts.length < 2) return rawName;
	return parts.join(" ");
}

interface ToolPalette {
	icon: LucideIcon;
	iconBg: string;
	iconColor: string;
	name: string;
	accent: string;
}

/**
 * Map Claude Code tool names to a small accent palette. The defaults are
 * intentionally low-saturation so a flood of tool calls in the stream
 * doesn't turn into a rainbow. Unknown tools fall through to the
 * generic wrench icon. Keep keys here aligned with the actual tool
 * names Claude Code emits in the NDJSON stream.
 */
function getToolPalette(toolName: string): ToolPalette {
	const fallback: ToolPalette = {
		icon: Wrench,
		iconBg: "bg-muted",
		iconColor: "text-muted-foreground",
		name: "text-foreground",
		accent: "hover:bg-accent/20",
	};
	// All MCP tools share one palette so a run that uses a chain of
	// `mcp__<server>__<tool>` calls doesn't explode into unique colors.
	// The server name is already surfaced via `formatToolDisplayName`.
	if (toolName.startsWith("mcp__")) {
		return {
			icon: Plug,
			iconBg: "bg-indigo-500/15",
			iconColor: "text-indigo-400",
			name: "text-indigo-300",
			accent: "hover:bg-indigo-500/10",
		};
	}
	const palettes: Record<string, ToolPalette> = {
		Agent: {
			icon: Bot,
			iconBg: "bg-violet-500/15",
			iconColor: "text-violet-400",
			name: "text-violet-300",
			accent: "hover:bg-violet-500/10",
		},
		Task: {
			icon: Bot,
			iconBg: "bg-violet-500/15",
			iconColor: "text-violet-400",
			name: "text-violet-300",
			accent: "hover:bg-violet-500/10",
		},
		Bash: {
			icon: SquareTerminal,
			iconBg: "bg-emerald-500/15",
			iconColor: "text-emerald-400",
			name: "text-emerald-300",
			accent: "hover:bg-emerald-500/10",
		},
		Read: {
			icon: FileText,
			iconBg: "bg-sky-500/15",
			iconColor: "text-sky-400",
			name: "text-sky-300",
			accent: "hover:bg-sky-500/10",
		},
		Edit: {
			icon: FileEdit,
			iconBg: "bg-amber-500/15",
			iconColor: "text-amber-400",
			name: "text-amber-300",
			accent: "hover:bg-amber-500/10",
		},
		MultiEdit: {
			icon: FilePen,
			iconBg: "bg-amber-500/15",
			iconColor: "text-amber-400",
			name: "text-amber-300",
			accent: "hover:bg-amber-500/10",
		},
		Write: {
			icon: FilePlus,
			iconBg: "bg-orange-500/15",
			iconColor: "text-orange-400",
			name: "text-orange-300",
			accent: "hover:bg-orange-500/10",
		},
		Grep: {
			icon: Search,
			iconBg: "bg-indigo-500/15",
			iconColor: "text-indigo-400",
			name: "text-indigo-300",
			accent: "hover:bg-indigo-500/10",
		},
		Glob: {
			icon: FolderSearch,
			iconBg: "bg-indigo-500/15",
			iconColor: "text-indigo-400",
			name: "text-indigo-300",
			accent: "hover:bg-indigo-500/10",
		},
		WebFetch: {
			icon: Globe,
			iconBg: "bg-cyan-500/15",
			iconColor: "text-cyan-400",
			name: "text-cyan-300",
			accent: "hover:bg-cyan-500/10",
		},
		WebSearch: {
			icon: Globe,
			iconBg: "bg-cyan-500/15",
			iconColor: "text-cyan-400",
			name: "text-cyan-300",
			accent: "hover:bg-cyan-500/10",
		},
		TodoWrite: {
			icon: CheckSquare,
			iconBg: "bg-pink-500/15",
			iconColor: "text-pink-400",
			name: "text-pink-300",
			accent: "hover:bg-pink-500/10",
		},
		NotebookEdit: {
			icon: FilePen,
			iconBg: "bg-amber-500/15",
			iconColor: "text-amber-400",
			name: "text-amber-300",
			accent: "hover:bg-amber-500/10",
		},
		SlashCommand: {
			icon: Sparkles,
			iconBg: "bg-fuchsia-500/15",
			iconColor: "text-fuchsia-400",
			name: "text-fuchsia-300",
			accent: "hover:bg-fuchsia-500/10",
		},
		ExitPlanMode: {
			icon: ListTree,
			iconBg: "bg-teal-500/15",
			iconColor: "text-teal-400",
			name: "text-teal-300",
			accent: "hover:bg-teal-500/10",
		},
		ToolSearch: {
			icon: Cog,
			iconBg: "bg-slate-500/15",
			iconColor: "text-slate-400",
			name: "text-slate-300",
			accent: "hover:bg-slate-500/10",
		},
	};
	return palettes[toolName] ?? fallback;
}

function MessageRow({ event }: { event: TodoStreamEvent }) {
	if (event.kind === "assistant_text") {
		return (
			<div className="group text-xs py-1 px-1">
				<MarkdownRenderer content={event.text} scrollable={false} />
			</div>
		);
	}
	if (event.kind === "result") {
		return (
			<div className="group border-l-2 border-emerald-500/50 bg-emerald-500/5 pl-2 py-1 text-xs my-1 rounded-r">
				<MarkdownRenderer content={event.text} scrollable={false} />
			</div>
		);
	}
	if (event.kind === "error") {
		return (
			<div className="border-l-2 border-rose-500/60 bg-rose-500/5 pl-2 py-1 text-xs my-1 whitespace-pre-wrap font-mono text-rose-400 rounded-r">
				{event.text}
			</div>
		);
	}
	if (event.kind === "remote_control") {
		// `event.text` is `接続 URL: https://claude.ai/code/session_...`
		// – extract the URL so the badge can render a real link.
		const urlMatch = event.text.match(
			/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/,
		);
		const url = urlMatch?.[0];
		return (
			<div className="group flex items-center gap-2 border-l-2 border-indigo-500/60 bg-indigo-500/5 pl-2 pr-1 py-1 my-1 rounded-r text-xs">
				<span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">
					Remote Control 接続中
				</span>
				{url ? (
					<a
						href={url}
						onClick={(e) => {
							e.preventDefault();
							window.open(url, "_blank", "noopener,noreferrer");
						}}
						className="truncate font-mono text-[11px] text-indigo-200/90 hover:text-indigo-100 underline-offset-2 hover:underline"
						title="claude.ai/code で開く"
					>
						{url}
					</a>
				) : (
					<span className="truncate text-[11px] opacity-80">{event.text}</span>
				)}
			</div>
		);
	}
	if (event.kind === "remote_control_error") {
		return (
			<div className="group flex items-center gap-2 border-l-2 border-amber-500/60 bg-amber-500/5 pl-2 pr-1 py-1 my-1 rounded-r text-xs">
				<span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
					Remote Control エラー
				</span>
				<span className="truncate text-[11px] opacity-80">{event.text}</span>
			</div>
		);
	}
	if (event.kind === "system_init") {
		return (
			<div className="flex items-baseline gap-2 text-[10px] text-muted-foreground py-0.5 px-1">
				<span className="font-semibold shrink-0 uppercase tracking-wide">
					{event.label}
				</span>
				<span className="truncate font-mono opacity-70">{event.text}</span>
			</div>
		);
	}
	return (
		<details className="text-xs py-0.5">
			<summary className="list-none cursor-pointer flex items-baseline gap-1 text-muted-foreground hover:text-foreground">
				<span className="text-[10px] opacity-50">▶</span>
				<span className="text-[10px] font-semibold uppercase">
					{event.label}
				</span>
				<span className="text-[10px] truncate font-mono opacity-70">
					{event.text.slice(0, 100)}
				</span>
			</summary>
			<pre className="ml-3 mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80 max-h-40 overflow-y-auto">
				{event.text}
			</pre>
		</details>
	);
}

function _formatClock(ms: number): string {
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
	// Hide the iter suffix for:
	//   - single-turn mode (no verifyCommand) — there is never more than
	//     one iteration inside a single run; the counter is implementation
	//     detail, not something users care about
	//   - iteration === 1 in verify mode — same reason, only show when
	//     the retry loop has actually advanced
	const showIter = !!session.verifyCommand && session.iteration > 1;
	const iter = showIter ? ` · iter ${session.iteration}` : "";
	if (session.status === "waiting" && session.waitingUntil) {
		return `waiting${iter} · ${formatWaitingRemaining(session.waitingUntil)}`;
	}
	return `${session.status}${iter}`;
}

/**
 * Human-friendly "N秒後" / "N分後" hint for a ScheduleWakeup-paused
 * session. Called from the session row label, so it is cheap and has
 * no side effects beyond reading the timestamp.
 */
function formatWaitingRemaining(waitingUntil: number): string {
	const remainingMs = waitingUntil - Date.now();
	if (remainingMs <= 0) return "wake soon";
	const remainingSec = Math.round(remainingMs / 1000);
	if (remainingSec < 60) return `${remainingSec}秒後`;
	const remainingMin = Math.round(remainingSec / 60);
	if (remainingMin < 60) return `${remainingMin}分後`;
	const remainingHr = Math.round(remainingMin / 60);
	return `${remainingHr}時間後`;
}

/**
 * HH:MM:SS-ish countdown for the detail pane's "待機終了まで" block.
 * More granular than `formatWaitingRemaining` because the detail view
 * has room for a live-ticking clock, while the session list label
 * only has room for a coarse "N分後" hint.
 */
function formatWaitingCountdown(waitingUntil: number): string {
	const remainingMs = waitingUntil - Date.now();
	if (remainingMs <= 0) return "まもなく再開します";
	const totalSec = Math.floor(remainingMs / 1000);
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${pad(minutes)}:${pad(seconds)}`;
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

interface TodoComposerProps {
	currentWorkspaceId?: string;
	onCreated: (sessionId: string) => void;
	onCancel: () => void;
}

/**
 * Inline TODO creation form rendered inside the AgentManager's detail
 * pane (mirrors Antigravity IDE's "New Conversation" UX).
 *
 * Scope is **project-based** so the same form works across all of a
 * project's worktrees:
 *   - Pick project
 *   - Either create a brand-new worktree (AI-named from title/desc),
 *     or pick an existing workspace of that project
 *
 * Preset pickers for `description`, `goal`, and system-prompt are
 * filtered by project (preset.workspaceId is repurposed to hold a
 * projectId — global presets have workspaceId=null).
 */
function TodoComposer({
	currentWorkspaceId,
	onCreated,
	onCancel,
}: TodoComposerProps) {
	const { data: projects } = electronTrpc.projects.getRecents.useQuery();
	const { data: workspaces } = electronTrpc.workspaces.getAll.useQuery();
	const { data: todoSettings } = electronTrpc.todoAgent.settings.get.useQuery();
	const { data: presets } = electronTrpc.todoAgent.presets.list.useQuery();

	// Project-first: auto-pick the current workspace's project if we can
	// infer one, otherwise the first project in the list.
	const defaultProjectId = useMemo(() => {
		if (currentWorkspaceId) {
			const ws = (workspaces ?? []).find((w) => w.id === currentWorkspaceId);
			if (ws) return ws.projectId;
		}
		return (projects ?? [])[0]?.id ?? "";
	}, [projects, workspaces, currentWorkspaceId]);

	const [projectId, setProjectId] = useState<string>("");
	const [createWorktree, setCreateWorktree] = useState(true);
	const [workspaceId, setWorkspaceId] = useState<string>("");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [descAttachments, setDescAttachments] = useState<ImageAttachment[]>([]);
	const [goal, setGoal] = useState("");
	const [goalAttachments, setGoalAttachments] = useState<ImageAttachment[]>([]);
	const [verifyCommand, setVerifyCommand] = useState("");
	const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
	const [claudeModel, setClaudeModel] =
		useState<ClaudeModelPick>(DEFAULT_SENTINEL);
	const [claudeEffort, setClaudeEffort] =
		useState<ClaudeEffortPick>(DEFAULT_SENTINEL);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!projectId && defaultProjectId) setProjectId(defaultProjectId);
	}, [projectId, defaultProjectId]);

	// Seed model/effort pickers from the global defaults once the settings
	// query resolves. Only runs until the user touches a picker — after
	// that any manual pick is preserved even if a refetch comes in.
	const claudeSeededRef = useRef(false);
	useEffect(() => {
		if (claudeSeededRef.current) return;
		if (!todoSettings) return;
		setClaudeModel(fromPersistedModel(todoSettings.defaultClaudeModel ?? null));
		setClaudeEffort(
			fromPersistedEffort(todoSettings.defaultClaudeEffort ?? null),
		);
		claudeSeededRef.current = true;
	}, [todoSettings]);

	// Workspaces scoped to the picked project, excluding the ones
	// scheduled for deletion.
	const projectWorkspaces = useMemo(
		() => (workspaces ?? []).filter((w) => w.projectId === projectId),
		[workspaces, projectId],
	);

	// Keep the workspace picker consistent: if the selected workspace
	// doesn't belong to the current project any more, reset it.
	useEffect(() => {
		if (
			!createWorktree &&
			workspaceId &&
			!projectWorkspaces.some((w) => w.id === workspaceId)
		) {
			setWorkspaceId(projectWorkspaces[0]?.id ?? "");
		}
	}, [createWorktree, workspaceId, projectWorkspaces]);

	useEffect(() => {
		if (!createWorktree && !workspaceId && projectWorkspaces.length > 0) {
			// Prefer the current workspace if it belongs to this project.
			const preferred =
				projectWorkspaces.find((w) => w.id === currentWorkspaceId) ??
				projectWorkspaces[0];
			setWorkspaceId(preferred?.id ?? "");
		}
	}, [createWorktree, workspaceId, projectWorkspaces, currentWorkspaceId]);

	const maxIterations = todoSettings?.defaultMaxIterations ?? 10;
	const maxWallClockSec = (todoSettings?.defaultMaxWallClockMin ?? 30) * 60;

	const scopedPresets = useMemo(() => {
		const all = presets ?? [];
		const matches = (p: { workspaceId: string | null }): boolean =>
			p.workspaceId == null || p.workspaceId === projectId;
		return {
			system: all.filter(
				(p) => (p.kind ?? "system") === "system" && matches(p),
			),
			description: all.filter((p) => p.kind === "description" && matches(p)),
			goal: all.filter((p) => p.kind === "goal" && matches(p)),
		};
	}, [presets, projectId]);

	const createMut = electronTrpc.todoAgent.create.useMutation();
	const createWorkspaceMut = electronTrpc.workspaces.create.useMutation();
	const utils = electronTrpc.useUtils();

	const canSubmit =
		projectId.length > 0 &&
		title.trim().length > 0 &&
		description.trim().length > 0 &&
		!submitting &&
		(createWorktree || workspaceId.length > 0);

	const handleCreate = useCallback(async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			let targetWorkspaceId = workspaceId;
			if (createWorktree) {
				const namingPrompt = [title.trim(), description.trim()]
					.filter(Boolean)
					.join("\n\n");
				const result = await createWorkspaceMut.mutateAsync({
					projectId,
					prompt: namingPrompt || title.trim(),
				});
				targetWorkspaceId = result.workspace.id;
			}
			const selected = scopedPresets.system.find(
				(p) => p.id === selectedPresetId,
			);
			// Expand [imageN] tokens → ![](abs-path) markdown right before
			// sending so Claude's Read tool can open the attachment while
			// the UI kept the short token for readability.
			const resolvedDescription = resolveAttachmentTokens(
				description.trim(),
				descAttachments,
			);
			const resolvedGoal = resolveAttachmentTokens(
				goal.trim(),
				goalAttachments,
			);
			const res = await createMut.mutateAsync({
				workspaceId: targetWorkspaceId,
				projectId,
				title: title.trim(),
				description: resolvedDescription,
				goal: resolvedGoal || undefined,
				verifyCommand: verifyCommand.trim() || undefined,
				maxIterations,
				maxWallClockSec,
				customSystemPrompt: selected?.content ?? undefined,
				claudeModel: toPersistedModel(claudeModel),
				claudeEffort: toPersistedEffort(claudeEffort),
			});
			await utils.todoAgent.listAll.invalidate();
			toast.success(
				createWorktree
					? "新しい worktree と TODO を作成しました"
					: "TODO を作成しました",
			);
			onCreated(res.sessionId);
			// Success path: leave submitting=true — the composer is about
			// to unmount via onCreated → re-enabling the button would
			// flicker. The finally below only runs on error / throw.
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "作成に失敗しました",
			);
		} finally {
			// Even if onCreated itself throws synchronously, make sure the
			// button can be retried instead of being permanently disabled.
			setSubmitting(false);
		}
	}, [
		canSubmit,
		claudeEffort,
		claudeModel,
		createMut,
		createWorkspaceMut,
		createWorktree,
		description,
		descAttachments,
		goal,
		goalAttachments,
		maxIterations,
		maxWallClockSec,
		onCreated,
		projectId,
		scopedPresets.system,
		selectedPresetId,
		title,
		utils,
		verifyCommand,
		workspaceId,
	]);

	return (
		<div className="flex flex-col h-full min-h-0 overflow-hidden">
			<div className="shrink-0 border-b px-6 py-3 flex items-center justify-between">
				<div>
					<h2 className="text-sm font-semibold">新しい TODO</h2>
					<p className="text-[11px] text-muted-foreground">
						作成後、すぐに Start できます。
					</p>
				</div>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={onCancel}
					disabled={submitting}
					className="h-7 text-xs"
				>
					キャンセル
				</Button>
			</div>
			<div className="flex-1 min-h-0 flex overflow-hidden">
				<div className="flex-1 min-w-0 overflow-y-auto p-6 border-r">
					<div className="max-w-2xl flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composer-project">対象プロジェクト</Label>
							<select
								id="composer-project"
								value={projectId}
								onChange={(e) => setProjectId(e.target.value)}
								className="h-9 rounded-md border border-input bg-background px-2 text-xs"
							>
								{(projects ?? []).map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
						</div>

						<label
							htmlFor="composer-new-worktree"
							className={cn(
								"flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition",
								createWorktree
									? "border-primary/40 bg-primary/5"
									: "border-border/40 hover:bg-muted/40",
							)}
						>
							<Checkbox
								id="composer-new-worktree"
								checked={createWorktree}
								onCheckedChange={(checked) =>
									setCreateWorktree(checked === true)
								}
							/>
							<span className="text-xs font-medium flex-1">
								新しい worktree を作成して実行
							</span>
							<HiMiniSparkles className="size-3 text-primary/70" />
						</label>

						{!createWorktree && (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="composer-ws">実行先ワークスペース</Label>
								<select
									id="composer-ws"
									value={workspaceId}
									onChange={(e) => setWorkspaceId(e.target.value)}
									className="h-9 rounded-md border border-input bg-background px-2 text-xs"
								>
									{projectWorkspaces.length === 0 && (
										<option value="">
											（このプロジェクトには worktree がありません）
										</option>
									)}
									{projectWorkspaces.map((w) => (
										<option key={w.id} value={w.id}>
											{w.name} ({w.branch})
										</option>
									))}
								</select>
							</div>
						)}

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composer-title">タイトル</Label>
							<Input
								id="composer-title"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="例: Issue #123 を修正"
								maxLength={200}
								autoFocus
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composer-desc">
								タスク{" "}
								<span className="text-[10px] text-muted-foreground">
									（画像貼り付け・ドロップ可）
								</span>
							</Label>
							<ImagePasteTextarea
								id="composer-desc"
								value={description}
								onValueChange={setDescription}
								attachments={descAttachments}
								onAttachmentsChange={setDescAttachments}
								placeholder="やってほしい作業を書く（右のテンプレートから挿入可・画像貼り付け可）"
								rows={5}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composer-goal">
								ゴール{" "}
								<span className="text-[10px] text-muted-foreground">任意</span>
							</Label>
							<ImagePasteTextarea
								id="composer-goal"
								value={goal}
								onValueChange={setGoal}
								attachments={goalAttachments}
								onAttachmentsChange={setGoalAttachments}
								placeholder="完了条件（空欄可、画像貼り付け可）"
								rows={3}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composer-verify">
								Verify{" "}
								<span className="text-[10px] text-muted-foreground">任意</span>
							</Label>
							<Input
								id="composer-verify"
								value={verifyCommand}
								onChange={(e) => setVerifyCommand(e.target.value)}
								placeholder="例: bun test"
							/>
						</div>

						<ClaudeRuntimePicker
							model={claudeModel}
							effort={claudeEffort}
							onModelChange={setClaudeModel}
							onEffortChange={setClaudeEffort}
							disabled={submitting}
						/>

						{selectedPresetId && (
							<div className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between">
									<Label>適用中のテンプレート（システム）</Label>
									<button
										type="button"
										onClick={() => setSelectedPresetId(null)}
										className="text-[10px] text-muted-foreground hover:text-destructive"
									>
										解除
									</button>
								</div>
								<div className="text-[11px] rounded-md border border-primary/30 bg-primary/5 p-2 font-mono whitespace-pre-wrap break-words max-h-24 overflow-auto">
									{
										scopedPresets.system.find((p) => p.id === selectedPresetId)
											?.content
									}
								</div>
							</div>
						)}
					</div>
				</div>

				<TemplateBrowser
					presets={presets ?? []}
					projects={projects ?? []}
					activeProjectId={projectId}
					onApplyDescription={(text) => setDescription(text)}
					onApplyGoal={(text) => setGoal(text)}
					onApplySystem={(id) => setSelectedPresetId(id)}
					activeSystemId={selectedPresetId}
				/>
			</div>
			<div className="shrink-0 border-t px-6 py-3 flex items-center justify-end gap-2">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={onCancel}
					disabled={submitting}
				>
					キャンセル
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={handleCreate}
					disabled={!canSubmit}
				>
					{submitting ? "作成中…" : "作成"}
				</Button>
			</div>
		</div>
	);
}

interface BrowserPreset {
	id: string;
	name: string;
	content: string;
	kind?: "system" | "description" | "goal";
	workspaceId?: string | null;
}

interface BrowserProject {
	id: string;
	name: string;
}

interface TemplateBrowserProps {
	presets: BrowserPreset[];
	projects: BrowserProject[];
	activeProjectId: string;
	activeSystemId: string | null;
	onApplyDescription: (text: string) => void;
	onApplyGoal: (text: string) => void;
	onApplySystem: (id: string) => void;
}

type KindFilter = "all" | "system" | "description" | "goal";

const KIND_META: Record<
	"system" | "description" | "goal",
	{ label: string; badge: string }
> = {
	system: { label: "システム", badge: "bg-primary/15 text-primary" },
	description: {
		label: "タスク",
		badge: "bg-amber-500/15 text-amber-600",
	},
	goal: { label: "ゴール", badge: "bg-emerald-500/15 text-emerald-600" },
};

/**
 * Rich template browser shown on the right side of the TodoComposer.
 * Groups templates by project (folder) then lets the user filter by
 * kind and free-text search. Clicking applies based on kind — system
 * templates wire up the Claude system prompt, description/goal
 * templates inject into the corresponding textarea.
 */
function TemplateBrowser({
	presets,
	projects,
	activeProjectId,
	activeSystemId,
	onApplyDescription,
	onApplyGoal,
	onApplySystem,
}: TemplateBrowserProps) {
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<KindFilter>("all");
	const [onlyCurrentProject, setOnlyCurrentProject] = useState(true);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return presets.filter((p) => {
			const kind = p.kind ?? "system";
			if (kindFilter !== "all" && kind !== kindFilter) return false;
			if (onlyCurrentProject) {
				if (p.workspaceId != null && p.workspaceId !== activeProjectId) {
					return false;
				}
			}
			if (!needle) return true;
			return (
				p.name.toLowerCase().includes(needle) ||
				p.content.toLowerCase().includes(needle)
			);
		});
	}, [presets, query, kindFilter, onlyCurrentProject, activeProjectId]);

	const grouped = useMemo(() => {
		const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
		const groups = new Map<string | null, BrowserPreset[]>();
		for (const p of filtered) {
			const key = p.workspaceId ?? null;
			const arr = groups.get(key) ?? [];
			arr.push(p);
			groups.set(key, arr);
		}
		return Array.from(groups.entries())
			.sort(([a], [b]) => {
				// Global first, then current project, then alphabetical.
				if (a === null) return -1;
				if (b === null) return 1;
				if (a === activeProjectId) return -1;
				if (b === activeProjectId) return 1;
				return 0;
			})
			.map(([id, items]) => ({
				id,
				label:
					id == null ? "グローバル" : (projectNameById.get(id) ?? "project"),
				items,
			}));
	}, [filtered, projects, activeProjectId]);

	const handleApply = useCallback(
		(preset: BrowserPreset) => {
			const kind = preset.kind ?? "system";
			if (kind === "system") {
				onApplySystem(preset.id);
				toast.success(`テンプレートを適用: ${preset.name}`);
			} else if (kind === "description") {
				onApplyDescription(preset.content);
				toast.success(`タスク欄に挿入: ${preset.name}`);
			} else {
				onApplyGoal(preset.content);
				toast.success(`ゴール欄に挿入: ${preset.name}`);
			}
		},
		[onApplyDescription, onApplyGoal, onApplySystem],
	);

	return (
		<aside className="w-[400px] shrink-0 flex flex-col min-h-0 bg-muted/10">
			<div className="shrink-0 border-b px-4 py-3 flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">テンプレート</h3>
					<span className="text-[10px] text-muted-foreground">
						{filtered.length} 件
					</span>
				</div>
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="名前・内容で検索"
					className="h-8 text-xs"
				/>
				<div className="flex items-center gap-1">
					{(["all", "system", "description", "goal"] as const).map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => setKindFilter(k)}
							className={cn(
								"px-2 py-0.5 rounded text-[10px] transition",
								kindFilter === k
									? "bg-primary text-primary-foreground"
									: "bg-muted text-muted-foreground hover:bg-accent",
							)}
						>
							{k === "all" ? "全て" : KIND_META[k].label}
						</button>
					))}
				</div>
				<label
					htmlFor="template-browser-only-current"
					className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer"
				>
					<Checkbox
						id="template-browser-only-current"
						checked={onlyCurrentProject}
						onCheckedChange={(v) => setOnlyCurrentProject(v === true)}
						className="size-3"
					/>
					<span>このプロジェクトのみ（+ グローバル）</span>
				</label>
			</div>

			<ScrollArea className="flex-1">
				<div className="p-2 flex flex-col gap-3">
					{grouped.length === 0 && (
						<p className="text-[11px] text-muted-foreground px-2 py-6 text-center">
							条件に一致するテンプレートがありません。
						</p>
					)}
					{grouped.map((group) => (
						<div key={group.id ?? "global"}>
							<div className="sticky top-0 z-10 bg-background/95 backdrop-blur px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b flex items-center gap-1">
								📁 {group.label}
								<span className="text-muted-foreground/60 normal-case tracking-normal">
									({group.items.length})
								</span>
							</div>
							<div className="flex flex-col gap-1 mt-1">
								{group.items.map((preset) => {
									const kind = preset.kind ?? "system";
									const isActive =
										kind === "system" && preset.id === activeSystemId;
									return (
										<button
											key={preset.id}
											type="button"
											onClick={() => handleApply(preset)}
											className={cn(
												"text-left rounded-md px-2.5 py-1.5 border transition",
												isActive
													? "border-primary/50 bg-primary/10"
													: "border-transparent hover:border-border/60 hover:bg-accent/30",
											)}
											title="クリックで適用"
										>
											<div className="flex items-center gap-1.5 mb-0.5">
												<span
													className={cn(
														"text-[9px] font-semibold px-1 py-0.5 rounded shrink-0",
														KIND_META[kind].badge,
													)}
												>
													{KIND_META[kind].label}
												</span>
												<span className="font-medium text-xs line-clamp-1 flex-1 min-w-0">
													{preset.name}
												</span>
												{isActive && (
													<span className="text-[9px] font-semibold text-primary shrink-0">
														適用中
													</span>
												)}
											</div>
											<div className="text-[10px] text-muted-foreground line-clamp-2">
												{preset.content.replace(/\s+/g, " ")}
											</div>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</ScrollArea>
		</aside>
	);
}
