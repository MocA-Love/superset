import type { SelectTodoSchedule, SelectTodoSession } from "@superset/local-db";
import { CronExpressionParser } from "cron-parser";
import { getTodoScheduleStore } from "./schedule-store";
import { getTodoSessionStore, resolveWorktreePath } from "./session-store";
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
			next.setDate(targetMonthday);
			next.setHours(hour, minute, 0, 0);
			if (next.getTime() <= from.getTime()) {
				next.setMonth(next.getMonth() + 1);
				next.setDate(targetMonthday);
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
		session.status === "paused"
	);
}

class TodoScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight = false;

	start(): void {
		if (this.timer) return;
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
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			const store = getTodoScheduleStore();
			const now = Date.now();
			const due = store.listDue(now);
			for (const schedule of due) {
				await this.fire(schedule, now);
			}
		} catch (error) {
			console.warn("[todo-scheduler] tick failed:", error);
		} finally {
			this.inFlight = false;
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

		const worktreePath = resolveWorktreePath(schedule.workspaceId);
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

		try {
			const sessionId = crypto.randomUUID();
			const artifactPath = supervisor.computeArtifactPath({
				sessionId,
				workspaceId: schedule.workspaceId,
			});
			const inserted = sessionStore.insert({
				id: sessionId,
				projectId: schedule.projectId,
				workspaceId: schedule.workspaceId,
				title: schedule.title,
				description: schedule.description,
				goal: schedule.goal,
				verifyCommand: schedule.verifyCommand,
				maxIterations: schedule.maxIterations,
				maxWallClockSec: schedule.maxWallClockSec,
				status: "queued",
				phase: "queued",
				iteration: 0,
				attachedPaneId: null,
				attachedTabId: null,
				claudeSessionId: null,
				finalAssistantText: null,
				totalCostUsd: null,
				totalNumTurns: null,
				pendingIntervention: null,
				startHeadSha: null,
				customSystemPrompt: schedule.customSystemPrompt,
				verdictPassed: null,
				verdictReason: null,
				verdictFailingTest: null,
				artifactPath,
				startedAt: null,
				completedAt: null,
			});
			supervisor.prepareArtifacts(inserted);
			void supervisor.start(inserted.id).catch((err) => {
				console.warn(
					`[todo-scheduler] supervisor.start failed for ${inserted.id}:`,
					err,
				);
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
