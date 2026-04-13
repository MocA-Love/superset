import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProjectCreationHandler } from "../../hooks/useProjectCreationHandler";

interface CloneRepoTabProps {
	onError: (error: string) => void;
	parentDir: string;
}

type CloneStatus = "idle" | "cloning" | "done" | "error" | "canceled";

interface LogLine {
	id: number;
	time: string;
	message: string;
	level: "info" | "warn" | "error" | "good";
}

interface ProgressState {
	stage: string;
	progress: number;
	processed: number;
	total: number;
}

const STAGE_LABELS: Record<string, string> = {
	counting: "Counting objects",
	compressing: "Compressing objects",
	receiving: "Receiving objects",
	resolving: "Resolving deltas",
	writing: "Writing objects",
	unknown: "Working",
};

const MAX_LOG_LINES = 500;

function formatTime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	const ms2 = Math.floor((ms % 1000) / 10);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms2).padStart(2, "0")}`;
}

export function CloneRepoTab({ onError, parentDir }: CloneRepoTabProps) {
	const [url, setUrl] = useState("");
	const [status, setStatus] = useState<CloneStatus>("idle");
	const [cloneId, setCloneId] = useState<string | null>(null);
	const [progress, setProgress] = useState<ProgressState | null>(null);
	const [logLines, setLogLines] = useState<LogLine[]>([]);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);
	const logIdRef = useRef(0);
	const logContainerRef = useRef<HTMLDivElement | null>(null);
	const wasCanceledRef = useRef(false);

	const cloneRepo = electronTrpc.projects.cloneRepo.useMutation();
	const cancelClone = electronTrpc.projects.cancelClone.useMutation();
	const { handleResult, handleError } = useProjectCreationHandler(onError);

	const isActive = status === "cloning";
	// Keep the subscription open as long as a cloneId exists so terminal
	// events (done/error/canceled) are delivered even after `status` flips
	// in the cloneRepo / cancelClone callbacks.
	electronTrpc.projects.cloneProgress.useSubscription(
		cloneId ? { cloneId } : (undefined as unknown as { cloneId: string }),
		{
			enabled: cloneId !== null,
			onData: (event) => {
				const t = startedAt
					? formatTime(event.time - startedAt)
					: formatTime(0);
				if (event.type === "log") {
					const level: LogLine["level"] = event.level;
					setLogLines((prev) => {
						logIdRef.current += 1;
						const next: LogLine[] = [
							...prev,
							{ id: logIdRef.current, time: t, message: event.message, level },
						];
						return next.length > MAX_LOG_LINES
							? next.slice(next.length - MAX_LOG_LINES)
							: next;
					});
				} else if (event.type === "progress") {
					setProgress({
						stage: event.stage,
						progress: event.progress,
						processed: event.processed,
						total: event.total,
					});
					const label = STAGE_LABELS[event.stage] ?? event.stage;
					setLogLines((prev) => {
						logIdRef.current += 1;
						const message = `${label}: ${event.progress}% (${event.processed}/${event.total})`;
						const last = prev[prev.length - 1];
						if (last?.message.startsWith(`${label}:`)) {
							return [...prev.slice(0, -1), { ...last, time: t, message }];
						}
						return [
							...prev,
							{ id: logIdRef.current, time: t, message, level: "info" },
						];
					});
				} else if (event.type === "done") {
					setLogLines((prev) => {
						logIdRef.current += 1;
						return [
							...prev,
							{
								id: logIdRef.current,
								time: t,
								message: "Clone complete",
								level: "good",
							},
						];
					});
				} else if (event.type === "error") {
					setLogLines((prev) => {
						logIdRef.current += 1;
						return [
							...prev,
							{
								id: logIdRef.current,
								time: t,
								message: event.message,
								level: "error",
							},
						];
					});
				} else if (event.type === "canceled") {
					setLogLines((prev) => {
						logIdRef.current += 1;
						return [
							...prev,
							{
								id: logIdRef.current,
								time: t,
								message: "Canceled",
								level: "warn",
							},
						];
					});
				}
			},
		},
	);

	useEffect(() => {
		if (!isActive || !startedAt) return;
		const interval = setInterval(() => {
			setElapsedMs(Date.now() - startedAt);
		}, 200);
		return () => clearInterval(interval);
	}, [isActive, startedAt]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: auto-scroll on new log lines
	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
	}, [logLines]);

	const resetProgressState = useCallback(() => {
		setProgress(null);
		setLogLines([]);
		logIdRef.current = 0;
		setElapsedMs(0);
		setStartedAt(null);
	}, []);

	const handleClone = () => {
		if (!url.trim()) {
			onError("Please enter a repository URL");
			return;
		}
		if (!parentDir.trim()) {
			onError("Please select a project location");
			return;
		}

		const newCloneId = crypto.randomUUID();
		resetProgressState();
		wasCanceledRef.current = false;
		setCloneId(newCloneId);
		setStatus("cloning");
		setStartedAt(Date.now());

		cloneRepo.mutate(
			{
				url: url.trim(),
				targetDirectory: parentDir.trim(),
				cloneId: newCloneId,
			},
			{
				onSuccess: (result) => {
					if (wasCanceledRef.current) return;
					setStatus(result.success ? "done" : "error");
					handleResult(result, () => {
						setUrl("");
					});
				},
				onError: (err) => {
					if (wasCanceledRef.current) return;
					setStatus("error");
					handleError(err);
				},
			},
		);
	};

	const handleCancel = () => {
		if (!cloneId) return;
		cancelClone.mutate(
			{ cloneId },
			{
				onSuccess: (result) => {
					if (!result.canceled) {
						// Backend had already finished or no controller remains —
						// leave the onSuccess/onError path from cloneRepo handle it.
						return;
					}
					wasCanceledRef.current = true;
					setStatus("canceled");
				},
				onError: (err) => {
					handleError(err);
				},
			},
		);
	};

	const handleReset = () => {
		setStatus("idle");
		setCloneId(null);
		resetProgressState();
	};

	const phaseLabel = useMemo(() => {
		if (status === "done") return "Clone complete";
		if (status === "error") return "Clone failed";
		if (status === "canceled") return "Canceled";
		if (!progress) return "Connecting...";
		const label = STAGE_LABELS[progress.stage] ?? progress.stage;
		return `${label} — ${progress.progress}%`;
	}, [status, progress]);

	const barClass = useMemo(() => {
		if (status === "done") return "bg-emerald-500";
		if (status === "error" || status === "canceled") return "bg-red-500";
		return "bg-blue-500";
	}, [status]);

	const barIndeterminate = isActive && !progress;
	const barWidth = progress ? `${progress.progress}%` : "100%";

	const showProgress = status !== "idle";

	return (
		<div className="flex flex-col gap-5">
			<div>
				<label
					htmlFor="clone-url"
					className="block text-sm font-medium text-foreground mb-2"
				>
					Repository URL
				</label>
				<Input
					id="clone-url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https:// or git@github.com:user/repo.git"
					disabled={isActive || status === "done"}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !isActive) {
							handleClone();
						}
					}}
					autoFocus
				/>
			</div>

			{showProgress ? (
				<div className="overflow-hidden rounded-md border border-border bg-muted/20">
					<div className="flex items-center justify-between px-3 py-2 border-b border-border">
						<div className="flex items-center gap-2 text-xs">
							{isActive ? (
								<div
									className="h-3 w-3 rounded-full border-2 border-border border-t-blue-500 animate-spin"
									aria-hidden
								/>
							) : status === "done" ? (
								<div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
							) : (
								<div className="h-2.5 w-2.5 rounded-full bg-red-500" />
							)}
							<span className="font-medium text-foreground">{phaseLabel}</span>
						</div>
						<div className="font-mono text-[11px] text-muted-foreground">
							{formatTime(elapsedMs)}
						</div>
					</div>
					<div className="relative h-[3px] bg-border">
						{barIndeterminate ? (
							<div
								className={`absolute top-0 bottom-0 w-2/5 ${barClass} animate-clone-indeterminate`}
							/>
						) : (
							<div
								className={`absolute top-0 bottom-0 left-0 ${barClass} transition-[width] duration-200`}
								style={{ width: barWidth }}
							/>
						)}
					</div>
					<div
						ref={logContainerRef}
						className="max-h-40 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.55] text-muted-foreground"
					>
						{logLines.map((line) => (
							<div
								key={line.id}
								className={
									line.level === "good"
										? "text-emerald-400"
										: line.level === "warn"
											? "text-amber-400"
											: line.level === "error"
												? "text-red-400"
												: "text-muted-foreground"
								}
							>
								<span className="text-muted-foreground/60">{line.time}</span>{" "}
								{line.message}
							</div>
						))}
					</div>
					{progress && progress.total > 0 ? (
						<div className="flex gap-4 border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
							<div>
								<span className="text-foreground">
									{progress.processed.toLocaleString()}
								</span>
								{" / "}
								<span>{progress.total.toLocaleString()}</span>
							</div>
							<div>
								stage: <span className="text-foreground">{progress.stage}</span>
							</div>
						</div>
					) : null}
				</div>
			) : null}

			<div className="flex justify-end gap-2 pt-2 border-t border-border/40">
				{status === "error" || status === "canceled" ? (
					<Button onClick={handleReset} size="sm" variant="ghost">
						Clear log
					</Button>
				) : null}
				{isActive ? (
					<Button
						onClick={handleCancel}
						size="sm"
						variant="ghost"
						disabled={cancelClone.isPending}
					>
						Cancel
					</Button>
				) : (
					<Button
						onClick={handleClone}
						disabled={cloneRepo.isPending || status === "done"}
						size="sm"
					>
						{status === "done" ? "Opening..." : "Clone"}
					</Button>
				)}
			</div>
		</div>
	);
}
