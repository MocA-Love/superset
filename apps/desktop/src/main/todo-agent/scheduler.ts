import type { SelectTodoSchedule, SelectTodoSession } from "@superset/local-db";
import { CronExpressionParser } from "cron-parser";
import { getTodoScheduleStore } from "./schedule-store";
import { autoSyncProjectMain } from "./schedule-sync";
import {
	ensureProjectBranchWorkspaceId,
	getTodoSessionStore,
	resolveWorktreePath,
} from "./session-store";
import { getTodoSupervisor } from "./supervisor";
import type { TodoScheduleFireEvent } from "./types";

const TICK_INTERVAL_MS = 30_000;

/**
 * Compute the next fire time (epoch ms) for a schedule, starting from
 * `from`. For `custom` we delegate to cron-parser; for the builder-backed
 * frequencies we compute it directly to avoid forcing the user through
 * cron syntax.
 */
export function computeNextRunAt(
	schedule: Pick<
		SelectTodoSchedule,
		"frequency" | "minute" | "hour" | "weekday" | "monthday" | "cronExpr"
	>,
	from: Date,
): number | null {
	if (schedule.frequency === "custom") {
		if (!schedule.cronExpr) return null;
		try {
			const interval = CronExpressionParser.parse(schedule.cronExpr, {
				currentDate: from,
			});
			return interval.next().getTime();
		} catch {
			return null;
		}
	}

	const minute = schedule.minute ?? 0;
	const hour = schedule.hour ?? 0;
	const next = new Date(from);
	// Snap seconds/ms to zero so fires land exactly on the minute boundary.
	next.setSeconds(0, 0);

	switch (schedule.frequency) {
		case "hourly": {
			next.setMinutes(minute);
			if (next.getTime() <= from.getTime()) {
				next.setHours(next.getHours() + 1);
			}
			return next.getTime();
		}
		case "daily": {
			next.setHours(hour, minute, 0, 0);
			if (next.getTime() <= from.getTime()) {
				next.setDate(next.getDate() + 1);
			}
			return next.getTime();
		}
		case "weekly": {
			const targetWeekday = schedule.weekday ?? 0;
			next.setHours(hour, minute, 0, 0);
			const currentWeekday = next.getDay();
			let delta = targetWeekday - currentWeekday;
			if (delta < 0) delta += 7;
			if (delta === 0 && next.getTime() <= from.getTime()) {
				delta = 7;
			}
			next.setDate(next.getDate() + delta);
			return next.getTime();
		}
		case "monthly": {
			const targetMonthday = schedule.monthday ?? 1;
			// Snap the target to the last valid day of each month so
			// e.g. "every 31st" doesn't overflow Feb to Mar 3 — users
			// who pick 31 expect "last day of every month" on short
			// months.
			const placeOnMonth = (base: Date) => {
				const lastDay = new Date(
					base.getFullYear(),
					base.getMonth() + 1,
					0,
				).getDate();
				base.setDate(Math.min(targetMonthday, lastDay));
				base.setHours(hour, minute, 0, 0);
			};
			next.setDate(1);
			placeOnMonth(next);
			if (next.getTime() <= from.getTime()) {
				next.setDate(1);
				next.setMonth(next.getMonth() + 1);
				placeOnMonth(next);
			}
			return next.getTime();
		}
		default:
			return null;
	}
}

function isSessionActive(session: SelectTodoSession | undefined): boolean {
	if (!session) return false;
	return (
		session.status === "queued" ||
		session.status === "preparing" ||
		session.status === "running" ||
		session.status === "verifying" ||
		session.status === "paused" ||
		// `waiting` means the worker called `ScheduleWakeup` to pause
		// itself and will be resumed by the scheduler tick. Count it as
		// active so the overlap guard and the concurrency display do not
		// treat a self-parked session as finished.
		session.status === "waiting"
	);
}

class TodoScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight = false;
	private isStopped = false;

	start(): void {
		if (this.timer) return;
		this.isStopped = false;
		// Re-seed nextRunAt for any schedule that lost its value (e.g. migration
		// from schedules inserted before this field got populated). Safe to
		// re-run on every boot because `lastRunAt` is respected.
		this.rebuildNextRunTimes();
		this.timer = setInterval(() => {
			void this.tick();
		}, TICK_INTERVAL_MS);
		// Run an immediate tick so schedules already past-due when the app
		// starts up fire on the first 30s window instead of waiting for it.
		void this.tick();
	}

	stop(): void {
		this.isStopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private rebuildNextRunTimes(): void {
		const store = getTodoScheduleStore();
		const now = new Date();
		for (const schedule of store.listAll()) {
			if (!schedule.enabled) continue;
			if (schedule.nextRunAt !== null) continue;
			const next = computeNextRunAt(schedule, now);
			if (next !== null) {
				store.setNextRunAt(schedule.id, next);
			}
		}
	}

	/**
	 * Public hook used by the tRPC layer when a schedule is created or its
	 * cadence definition changes. Recomputes nextRunAt relative to `now`.
	 */
	refreshNextRunAt(scheduleId: string): void {
		const store = getTodoScheduleStore();
		const schedule = store.get(scheduleId);
		if (!schedule) return;
		if (!schedule.enabled) {
			store.setNextRunAt(scheduleId, null);
			return;
		}
		const next = computeNextRunAt(schedule, new Date());
		store.setNextRunAt(scheduleId, next);
	}

	private async tick(): Promise<void> {
		if (this.inFlight || this.isStopped) return;
		this.inFlight = true;
		try {
			const store = getTodoScheduleStore();
			// Wake self-paced (`ScheduleWakeup`) sessions whose deadline
			// has passed before we process new schedule fires. Doing this
			// first means a schedule firing into an already-waiting
			// session sees the updated status and respects overlap mode.
			this.resumeDueWaitingSessions();
			// Snapshot "due" using tick start time, but compute each
			// schedule's firedAt from the actual moment fire() runs.
			// Otherwise a slow fire leaves the next schedule in the loop
			// advancing `nextRunAt` from a stale tick-start timestamp —
			// for minute-level cron that can emit a "next run" already
			// in the past and trigger duplicate fires on the next tick.
			const due = store.listDue(Date.now());
			for (const schedule of due) {
				// Abort mid-iteration if a shutdown came in while we were
				// awaiting a previous fire. Prevents inserting a session
				// row after closeLocalDb() has torn down SQLite.
				if (this.isStopped) break;
				await this.fire(schedule, Date.now());
			}
		} catch (error) {
			console.warn("[todo-scheduler] tick failed:", error);
		} finally {
			this.inFlight = false;
		}
	}

	/**
	 * Scan for `waiting` sessions whose `waitingUntil` has elapsed and
	 * hand them back to the supervisor. The status flip is gated on the
	 * row still being `waiting` at claim time so a race with the user
	 * clicking Abort (which writes `aborted`) between `listWaitingDue`
	 * and the update cannot resurrect an abort into a fresh run. If
	 * `supervisor.start` rejects after we've claimed, we mark the
	 * session `failed` with a clear reason — the alternative (leaving
	 * it stuck at `queued` with no timer) would silently strand a
	 * `ScheduleWakeup` session forever.
	 */
	private resumeDueWaitingSessions(): void {
		const sessionStore = getTodoSessionStore();
		const due = sessionStore.listWaitingDue(Date.now());
		if (due.length === 0) return;
		const supervisor = getTodoSupervisor();
		for (const session of due) {
			if (this.isStopped) return;
			const claimed = sessionStore.claimWaitingForResume(session.id);
			if (!claimed) continue;
			void supervisor.start(session.id).catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(
					`[todo-scheduler] resume waiting failed for ${session.id}:`,
					err,
				);
				// Only mark `failed` if the row is still the row we claimed —
				// the user may have aborted or deleted the session between
				// claim and the rejection, and we must not overwrite that.
				const current = sessionStore.get(session.id);
				if (!current || current.status !== "queued") return;
				sessionStore.update(session.id, {
					status: "failed",
					phase: "failed",
					verdictPassed: false,
					verdictReason: `ScheduleWakeup 再開時に supervisor.start が失敗しました: ${message}`,
					completedAt: Date.now(),
				});
			});
		}
	}

	private async fire(
		schedule: SelectTodoSchedule,
		firedAt: number,
	): Promise<void> {
		const store = getTodoScheduleStore();
		const sessionStore = getTodoSessionStore();
		const supervisor = getTodoSupervisor();

		const nextRunAt = computeNextRunAt(schedule, new Date(firedAt));

		// Overlap guard: if a previous session from this schedule is still
		// active and the user asked us to skip, short-circuit without
		// creating a new session. Still advance nextRunAt so we don't busy
		// loop on the same tick.
		//
		// `overlapMode === "queue"` is intentionally handled by the existing
		// TodoSupervisor queue: we always insert the new session and call
		// supervisor.start(), which enqueues when another session is already
		// running instead of spawning in parallel. No extra branch needed here.
		if (schedule.overlapMode === "skip" && schedule.lastRunSessionId) {
			const prev = sessionStore.get(schedule.lastRunSessionId);
			if (isSessionActive(prev)) {
				store.recordRun({
					id: schedule.id,
					sessionId: schedule.lastRunSessionId,
					firedAt,
					nextRunAt,
				});
				this.emit({
					scheduleId: schedule.id,
					scheduleName: schedule.name,
					kind: "skipped",
					sessionId: null,
					message: "前回の実行が終わっていないためスキップしました",
					firedAt,
				});
				return;
			}
		}

		// Resolve the workspace to attach the fired session to. If the
		// schedule was saved project-only (workspaceId = null), fall back
		// to the project's branch-type workspace, materializing one if the
		// project doesn't already have it. That keeps `todo_sessions`
		// workspaceId NOT NULL intact while letting the UI expose the
		// "run on project main repo" mental model.
		const fireWorkspaceId =
			schedule.workspaceId ??
			ensureProjectBranchWorkspaceId(schedule.projectId);
		if (!fireWorkspaceId) {
			store.recordRun({
				id: schedule.id,
				sessionId: null,
				firedAt,
				nextRunAt,
			});
			this.emit({
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				kind: "failed",
				sessionId: null,
				message: "プロジェクトのワークスペースを用意できませんでした",
				firedAt,
			});
			return;
		}

		const worktreePath = resolveWorktreePath(fireWorkspaceId);
		if (!worktreePath) {
			store.recordRun({
				id: schedule.id,
				sessionId: null,
				firedAt,
				nextRunAt,
			});
			this.emit({
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				kind: "failed",
				sessionId: null,
				message: "ワークスペースのパスが解決できませんでした",
				firedAt,
			});
			return;
		}

		// Opt-in: freshen the project main repo before firing. Applies
		// only when the schedule itself has no workspaceId (we refuse to
		// yank HEAD on a worktree workspace — that would rewrite someone
		// else's working branch). If the tree is dirty we deliberately
		// skip the fire rather than stash the user's work.
		if (schedule.autoSyncBeforeFire && schedule.workspaceId === null) {
			const syncResult = await autoSyncProjectMain(worktreePath);
			if (syncResult.kind !== "ok") {
				store.recordRun({
					id: schedule.id,
					sessionId: null,
					firedAt,
					nextRunAt,
				});
				this.emit({
					scheduleId: schedule.id,
					scheduleName: schedule.name,
					kind: syncResult.kind === "dirty" ? "skipped" : "failed",
					sessionId: null,
					message: syncResult.message,
					firedAt,
				});
				return;
			}
		}

		try {
			const sessionId = crypto.randomUUID();
			const artifactPath = supervisor.computeArtifactPath({
				sessionId,
				workspaceId: fireWorkspaceId,
			});
			const inserted = sessionStore.insertQueuedFromTemplate({
				id: sessionId,
				projectId: schedule.projectId,
				workspaceId: fireWorkspaceId,
				title: schedule.title,
				description: schedule.description,
				goal: schedule.goal,
				verifyCommand: schedule.verifyCommand,
				maxIterations: schedule.maxIterations,
				maxWallClockSec: schedule.maxWallClockSec,
				customSystemPrompt: schedule.customSystemPrompt,
				artifactPath,
			});
			supervisor.prepareArtifacts(inserted);
			void supervisor.start(inserted.id).catch((err) => {
				const failureMessage =
					err instanceof Error ? err.message : "Unknown error";
				console.warn(
					`[todo-scheduler] supervisor.start failed for ${inserted.id}:`,
					err,
				);
				// The triggered toast has already fired, so publish a
				// follow-up failed event. Otherwise the UI would claim the
				// fire succeeded even though the supervisor never ran.
				this.emit({
					scheduleId: schedule.id,
					scheduleName: schedule.name,
					kind: "failed",
					sessionId: inserted.id,
					message: `実行開始に失敗しました: ${failureMessage}`,
					firedAt,
				});
			});
			store.recordRun({
				id: schedule.id,
				sessionId: inserted.id,
				firedAt,
				nextRunAt,
			});
			this.emit({
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				kind: "triggered",
				sessionId: inserted.id,
				message: null,
				firedAt,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			store.recordRun({
				id: schedule.id,
				sessionId: null,
				firedAt,
				nextRunAt,
			});
			this.emit({
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				kind: "failed",
				sessionId: null,
				message,
				firedAt,
			});
		}
	}

	private emit(event: TodoScheduleFireEvent): void {
		getTodoScheduleStore().emitFire(event);
	}
}

let instance: TodoScheduler | null = null;

export function getTodoScheduler(): TodoScheduler {
	if (!instance) {
		instance = new TodoScheduler();
	}
	return instance;
}
