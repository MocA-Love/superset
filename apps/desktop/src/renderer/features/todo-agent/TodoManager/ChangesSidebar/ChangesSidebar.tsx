import { ScrollArea } from "@superset/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMemo, useState } from "react";
import {
	HiMiniArrowPath,
	HiMiniChevronDown,
	HiMiniChevronRight,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface ChangesSidebarProps {
	sessionId: string;
	active: boolean;
}

type DiffScope = "session" | "staged" | "unstaged" | "commit";

interface SelectedDiff {
	key: string;
	path: string;
	scope: DiffScope;
	commitSha?: string;
	label: string;
}

/**
 * Right-side panel inside the TODO Agent Manager that surfaces the git
 * work the worker produced in a session. Relies on the per-session
 * `startHeadSha` the supervisor captures at run start to scope commits
 * to "this session only" via `git log startHeadSha..HEAD`.
 */
export function ChangesSidebar({ sessionId, active }: ChangesSidebarProps) {
	const [selected, setSelected] = useState<SelectedDiff | null>(null);
	const [commitsOpen, setCommitsOpen] = useState(true);
	const [workingTreeOpen, setWorkingTreeOpen] = useState(true);
	const [sessionFilesOpen, setSessionFilesOpen] = useState(true);

	const snapshot = electronTrpc.todoAgent.gitSnapshot.useQuery(
		{ sessionId },
		{
			refetchInterval: active ? 3000 : false,
			staleTime: 1000,
		},
	);

	const diffQuery = electronTrpc.todoAgent.gitFileDiff.useQuery(
		selected
			? {
					sessionId,
					path: selected.path,
					scope: selected.scope,
					commitSha: selected.commitSha,
				}
			: { sessionId, path: "", scope: "session" as const },
		{ enabled: !!selected, staleTime: 5_000 },
	);

	const utils = electronTrpc.useUtils();
	const handleRefresh = () => {
		void utils.todoAgent.gitSnapshot.invalidate({ sessionId });
		if (selected) {
			void utils.todoAgent.gitFileDiff.invalidate({
				sessionId,
				path: selected.path,
				scope: selected.scope,
				commitSha: selected.commitSha,
			});
		}
	};

	const data = snapshot.data;
	const commits = data?.commits ?? [];
	const workingTree = data?.workingTree ?? [];
	const sessionFiles = data?.sessionFiles ?? [];
	const startHeadUnreachable = data?.startHeadUnreachable ?? false;

	const stagedCount = useMemo(
		() => workingTree.filter((f) => f.stage === "staged").length,
		[workingTree],
	);
	const unstagedCount = useMemo(
		() => workingTree.filter((f) => f.stage === "unstaged").length,
		[workingTree],
	);
	const untrackedCount = useMemo(
		() => workingTree.filter((f) => f.stage === "untracked").length,
		[workingTree],
	);

	return (
		<div className="flex flex-col h-full min-h-0 overflow-hidden">
			<div className="shrink-0 border-b px-3 py-2 flex items-center justify-between">
				<div className="flex flex-col min-w-0">
					<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
						変更
					</div>
					{data?.branch ? (
						<Tooltip delayDuration={300}>
							<TooltipTrigger asChild>
								<div className="text-xs truncate">
									<span className="font-mono">{data.branch}</span>
								</div>
							</TooltipTrigger>
							<TooltipContent side="bottom" align="start">
								<span className="font-mono text-xs">{data.branch}</span>
							</TooltipContent>
						</Tooltip>
					) : (
						<div className="text-xs truncate">
							<span className="text-muted-foreground">（ブランチ取得中…）</span>
						</div>
					)}
				</div>
				<button
					type="button"
					className="size-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition"
					onClick={handleRefresh}
					title="再取得"
				>
					<HiMiniArrowPath
						className={cn("size-3.5", snapshot.isFetching && "animate-spin")}
					/>
				</button>
			</div>

			<ScrollArea className="flex-1">
				<div className="p-3 flex flex-col gap-4 text-xs">
					{data?.startHeadSha && (
						<div className="rounded-lg border border-border/40 bg-muted/30 p-2">
							<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
								開始時 HEAD
							</div>
							<div className="font-mono text-[11px] break-all">
								{data.startHeadSha.slice(0, 12)}
								{data.currentHeadSha &&
								data.currentHeadSha !== data.startHeadSha ? (
									<>
										{" → "}
										<span className="text-primary">
											{data.currentHeadSha.slice(0, 12)}
										</span>
									</>
								) : null}
							</div>
							{(data.ahead > 0 || data.behind > 0) && (
								<div className="text-[10px] text-muted-foreground mt-1">
									↑ {data.ahead} · ↓ {data.behind}
								</div>
							)}
						</div>
					)}

					{!data?.startHeadSha && snapshot.isSuccess && (
						<div className="text-[11px] text-muted-foreground px-1">
							開始時 HEAD が記録されていません。Start して最初のターンに入ると
							このパネルに差分とコミット履歴が表示されます。
						</div>
					)}

					{startHeadUnreachable && (
						<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
							開始時 HEAD
							のコミットが見つかりません。ブランチがリセットされたか、
							オブジェクトが失われている可能性があります。
						</div>
					)}

					{/* Cumulative session delta (startHeadSha ↔ HEAD), shown
					    even when no new commits exist so branch switches /
					    rebases don't leave the sidebar looking empty. */}
					<section>
						<button
							type="button"
							onClick={() => setSessionFilesOpen((v) => !v)}
							className="w-full flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1 hover:text-foreground transition"
						>
							{sessionFilesOpen ? (
								<HiMiniChevronDown className="size-3" />
							) : (
								<HiMiniChevronRight className="size-3" />
							)}
							セッション全体
							<span className="ml-1 text-muted-foreground/70">
								({sessionFiles.length})
							</span>
						</button>
						{sessionFilesOpen && (
							<div className="flex flex-col gap-0.5">
								{!data?.startHeadSha ? (
									<p className="text-[11px] text-muted-foreground px-1 py-2">
										開始時 HEAD が未記録のため、差分を算出できません。
									</p>
								) : sessionFiles.length === 0 ? (
									<p className="text-[11px] text-muted-foreground px-1 py-2">
										開始時からの差分はありません。
									</p>
								) : (
									sessionFiles.map((file) => {
										const key = `session:${file.path}`;
										// Deletions ARE the diff at session scope —
										// `git diff <start>..HEAD -- <path>` still emits
										// a valid deletion patch, so keep every entry
										// clickable. The working-tree section below
										// rightly disables `D`, because there the file
										// is already gone from the worktree.
										return (
											<Tooltip key={key} delayDuration={300}>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={() =>
															setSelected({
																key,
																path: file.path,
																scope: "session",
																label: file.path,
															})
														}
														className={cn(
															"text-left rounded-md px-2 py-1 border border-transparent hover:bg-accent/50 hover:border-border/40 transition flex items-center gap-2 min-w-0",
															selected?.key === key &&
																"bg-accent border-primary/40",
														)}
													>
														<StatusBadge code={file.code} stage="session" />
														<span className="text-[11px] font-mono truncate flex-1">
															{file.path}
														</span>
													</button>
												</TooltipTrigger>
												<TooltipContent side="left" align="start">
													<span className="font-mono text-[11px] break-all">
														{file.path}
													</span>
												</TooltipContent>
											</Tooltip>
										);
									})
								)}
							</div>
						)}
					</section>

					{/* Commits since session start */}
					<section>
						<button
							type="button"
							onClick={() => setCommitsOpen((v) => !v)}
							className="w-full flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1 hover:text-foreground transition"
						>
							{commitsOpen ? (
								<HiMiniChevronDown className="size-3" />
							) : (
								<HiMiniChevronRight className="size-3" />
							)}
							コミット
							<span className="ml-1 text-muted-foreground/70">
								({commits.length})
							</span>
						</button>
						{commitsOpen && (
							<div className="flex flex-col gap-1">
								{commits.length === 0 ? (
									<p className="text-[11px] text-muted-foreground px-1 py-2">
										このセッションでの新規コミットはありません。
									</p>
								) : (
									commits.map((commit) => (
										<Tooltip key={commit.sha} delayDuration={300}>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={() =>
														setSelected({
															key: `commit:${commit.sha}`,
															path: "",
															scope: "commit",
															commitSha: commit.sha,
															label: commit.shortSha,
														})
													}
													className={cn(
														"text-left rounded-md px-2 py-1.5 border border-border/30 hover:bg-accent/50 transition min-w-0",
														selected?.key === `commit:${commit.sha}` &&
															"bg-accent border-primary/40",
													)}
												>
													<div className="flex items-center gap-2">
														<span className="font-mono text-[10px] text-muted-foreground shrink-0">
															{commit.shortSha}
														</span>
														<span className="line-clamp-1 flex-1 text-[11px]">
															{commit.subject}
														</span>
													</div>
													<div className="text-[10px] text-muted-foreground pl-[3.25rem] mt-0.5 truncate">
														{commit.authorName}
														{commit.authorDate
															? ` · ${formatShortDate(commit.authorDate)}`
															: ""}
													</div>
												</button>
											</TooltipTrigger>
											<TooltipContent
												side="left"
												align="start"
												className="max-w-[360px]"
											>
												<div className="flex flex-col gap-0.5">
													<span className="text-[11px] break-words">
														{commit.subject}
													</span>
													<span className="text-[10px] opacity-70">
														{commit.shortSha} · {commit.authorName}
														{commit.authorDate
															? ` · ${formatShortDate(commit.authorDate)}`
															: ""}
													</span>
												</div>
											</TooltipContent>
										</Tooltip>
									))
								)}
							</div>
						)}
					</section>

					{/* Working tree */}
					<section>
						<button
							type="button"
							onClick={() => setWorkingTreeOpen((v) => !v)}
							className="w-full flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1 hover:text-foreground transition"
						>
							{workingTreeOpen ? (
								<HiMiniChevronDown className="size-3" />
							) : (
								<HiMiniChevronRight className="size-3" />
							)}
							ワーキングツリー
							<span className="ml-1 text-muted-foreground/70">
								({workingTree.length})
							</span>
							{stagedCount + unstagedCount + untrackedCount > 0 && (
								<span className="ml-auto text-[10px] text-muted-foreground/70 font-normal normal-case">
									staged {stagedCount} · unstaged {unstagedCount} · ?{" "}
									{untrackedCount}
								</span>
							)}
						</button>
						{workingTreeOpen && (
							<div className="flex flex-col gap-0.5">
								{workingTree.length === 0 ? (
									<p className="text-[11px] text-muted-foreground px-1 py-2">
										ワーキングツリーは clean です。
									</p>
								) : (
									workingTree.map((file) => {
										const key = `wt:${file.stage}:${file.path}`;
										const scope: DiffScope =
											file.stage === "staged" ? "staged" : "unstaged";
										const canDiff =
											file.stage !== "untracked" && file.code !== "D";
										return (
											<Tooltip key={key} delayDuration={300}>
												<TooltipTrigger asChild>
													<button
														type="button"
														aria-disabled={!canDiff}
														onClick={() => {
															if (!canDiff) return;
															setSelected({
																key,
																path: file.path,
																scope,
																label: file.path,
															});
														}}
														className={cn(
															"text-left rounded-md px-2 py-1 border border-transparent hover:bg-accent/50 hover:border-border/40 transition flex items-center gap-2 min-w-0",
															selected?.key === key &&
																"bg-accent border-primary/40",
															!canDiff && "opacity-60 cursor-default",
														)}
													>
														<StatusBadge code={file.code} stage={file.stage} />
														<span className="text-[11px] font-mono truncate flex-1">
															{file.path}
														</span>
													</button>
												</TooltipTrigger>
												<TooltipContent side="left" align="start">
													<span className="font-mono text-[11px] break-all">
														{file.path}
													</span>
												</TooltipContent>
											</Tooltip>
										);
									})
								)}
							</div>
						)}
					</section>

					{/* Diff viewer for the currently selected file/commit */}
					{selected && (
						<section className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
							<div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/30 gap-2">
								<Tooltip delayDuration={300}>
									<TooltipTrigger asChild>
										<div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate min-w-0 flex-1">
											{selected.scope === "commit"
												? `コミット ${selected.label}`
												: `${scopeLabel(selected.scope)} · ${selected.label}`}
										</div>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										align="start"
										className="max-w-[360px]"
									>
										<span className="text-[11px] break-all">
											{selected.scope === "commit"
												? `コミット ${selected.label}`
												: `${scopeLabel(selected.scope)} · ${selected.label}`}
										</span>
									</TooltipContent>
								</Tooltip>
								<button
									type="button"
									className="text-[10px] text-muted-foreground hover:text-foreground transition"
									onClick={() => setSelected(null)}
								>
									閉じる
								</button>
							</div>
							<DiffBlock
								content={diffQuery.data ?? ""}
								loading={diffQuery.isFetching}
							/>
						</section>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

function StatusBadge({ code, stage }: { code: string; stage: string }) {
	const { letter, color } = useMemo(() => {
		if (stage === "untracked") {
			return { letter: "?", color: "text-muted-foreground" };
		}
		switch (code) {
			case "M":
				return { letter: "M", color: "text-amber-500" };
			case "A":
				return { letter: "A", color: "text-emerald-500" };
			case "D":
				return { letter: "D", color: "text-rose-500" };
			case "R":
				return { letter: "R", color: "text-primary" };
			default:
				return { letter: code || "·", color: "text-muted-foreground" };
		}
	}, [code, stage]);
	return (
		<span
			className={cn(
				"size-4 shrink-0 rounded-sm bg-background border border-border/40 text-[9px] font-semibold font-mono flex items-center justify-center",
				color,
			)}
		>
			{letter}
		</span>
	);
}

function DiffBlock({
	content,
	loading,
}: {
	content: string;
	loading: boolean;
}) {
	if (loading && !content) {
		return (
			<div className="p-3 text-[11px] text-muted-foreground">読み込み中…</div>
		);
	}
	if (!content.trim()) {
		return (
			<div className="p-3 text-[11px] text-muted-foreground">
				差分はありません。
			</div>
		);
	}
	const lines = content.split("\n");
	return (
		<pre className="max-h-[50vh] overflow-auto text-[10px] leading-relaxed font-mono">
			<code>
				{lines.map((line, idx) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are stable snapshot
						key={idx}
						className={cn(
							"px-2.5 whitespace-pre",
							line.startsWith("+") && !line.startsWith("+++")
								? "text-emerald-500"
								: line.startsWith("-") && !line.startsWith("---")
									? "text-rose-500"
									: line.startsWith("@@")
										? "text-primary/80"
										: line.startsWith("diff ") ||
												line.startsWith("index ") ||
												line.startsWith("+++") ||
												line.startsWith("---")
											? "text-muted-foreground"
											: "text-foreground/80",
						)}
					>
						{line || " "}
					</div>
				))}
			</code>
		</pre>
	);
}

function formatShortDate(iso: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scopeLabel(scope: DiffScope): string {
	switch (scope) {
		case "staged":
			return "staged";
		case "unstaged":
			return "unstaged";
		case "session":
			return "セッション全体";
		case "commit":
			return "commit";
	}
}
