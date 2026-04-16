import { EventEmitter } from "node:events";
import {
	type InsertTodoSchedule,
	type SelectTodoSchedule,
	todoSchedules,
} from "@superset/local-db";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import type {
	TodoScheduleCreateInput,
	TodoScheduleFireEvent,
	TodoScheduleUpdateInput,
} from "./types";

/**
 * Persistence layer for the TODO agent schedules table plus an event bus the
 * scheduler uses to broadcast fire events into the tRPC subscription.
 *
 * Kept deliberately thin: the scheduler is responsible for cadence math,
 * this module just does CRUD + emit.
 */
class TodoScheduleStore {
	private readonly emitter = new EventEmitter();

	emitFire(event: TodoScheduleFireEvent): void {
		this.emitter.emit("fire", event);
	}

	onFire(handler: (event: TodoScheduleFireEvent) => void): () => void {
		this.emitter.on("fire", handler);
		return () => {
			this.emitter.off("fire", handler);
		};
	}

	insert(
		input: TodoScheduleCreateInput & { nextRunAt: number | null },
	): SelectTodoSchedule {
		const row: InsertTodoSchedule = {
			projectId: input.projectId,
			workspaceId: input.workspaceId ?? null,
			name: input.name,
			enabled: input.enabled,
			frequency: input.frequency,
			minute: input.minute ?? null,
			hour: input.hour ?? null,
			weekday: input.weekday ?? null,
			monthday: input.monthday ?? null,
			cronExpr: input.cronExpr ?? null,
			title: input.title,
			description: input.description,
			goal: input.goal ?? null,
			verifyCommand: input.verifyCommand ?? null,
			maxIterations: input.maxIterations,
			maxWallClockSec: input.maxWallClockSec,
			customSystemPrompt: input.customSystemPrompt ?? null,
			overlapMode: input.overlapMode,
			nextRunAt: input.nextRunAt,
		};

		return localDb.insert(todoSchedules).values(row).returning().get();
	}

	update(input: TodoScheduleUpdateInput): SelectTodoSchedule | undefined {
		const { id, ...rest } = input;
		const patch: Partial<InsertTodoSchedule> & { updatedAt: number } = {
			updatedAt: Date.now(),
		};
		if (rest.name !== undefined) patch.name = rest.name;
		if (rest.enabled !== undefined) patch.enabled = rest.enabled;
		if (rest.frequency !== undefined) patch.frequency = rest.frequency;
		if (rest.minute !== undefined) patch.minute = rest.minute ?? null;
		if (rest.hour !== undefined) patch.hour = rest.hour ?? null;
		if (rest.weekday !== undefined) patch.weekday = rest.weekday ?? null;
		if (rest.monthday !== undefined) patch.monthday = rest.monthday ?? null;
		if (rest.cronExpr !== undefined) patch.cronExpr = rest.cronExpr ?? null;
		if (rest.title !== undefined) patch.title = rest.title;
		if (rest.description !== undefined) patch.description = rest.description;
		if (rest.goal !== undefined) patch.goal = rest.goal ?? null;
		if (rest.verifyCommand !== undefined)
			patch.verifyCommand = rest.verifyCommand ?? null;
		if (rest.maxIterations !== undefined)
			patch.maxIterations = rest.maxIterations;
		if (rest.maxWallClockSec !== undefined)
			patch.maxWallClockSec = rest.maxWallClockSec;
		if (rest.customSystemPrompt !== undefined)
			patch.customSystemPrompt = rest.customSystemPrompt ?? null;
		if (rest.overlapMode !== undefined) patch.overlapMode = rest.overlapMode;
		if (rest.workspaceId !== undefined)
			patch.workspaceId = rest.workspaceId ?? null;
		if (rest.projectId !== undefined) patch.projectId = rest.projectId;

		return localDb
			.update(todoSchedules)
			.set(patch)
			.where(eq(todoSchedules.id, id))
			.returning()
			.get();
	}

	setNextRunAt(id: string, nextRunAt: number | null): void {
		localDb
			.update(todoSchedules)
			.set({ nextRunAt, updatedAt: Date.now() })
			.where(eq(todoSchedules.id, id))
			.run();
	}

	recordRun({
		id,
		sessionId,
		firedAt,
		nextRunAt,
	}: {
		id: string;
		sessionId: string | null;
		firedAt: number;
		nextRunAt: number | null;
	}): void {
		localDb
			.update(todoSchedules)
			.set({
				lastRunAt: firedAt,
				lastRunSessionId: sessionId,
				nextRunAt,
				updatedAt: Date.now(),
			})
			.where(eq(todoSchedules.id, id))
			.run();
	}

	setEnabled(id: string, enabled: boolean): SelectTodoSchedule | undefined {
		return localDb
			.update(todoSchedules)
			.set({ enabled, updatedAt: Date.now() })
			.where(eq(todoSchedules.id, id))
			.returning()
			.get();
	}

	get(id: string): SelectTodoSchedule | undefined {
		return localDb
			.select()
			.from(todoSchedules)
			.where(eq(todoSchedules.id, id))
			.get();
	}

	delete(id: string): boolean {
		const result = localDb
			.delete(todoSchedules)
			.where(eq(todoSchedules.id, id))
			.run();
		return result.changes > 0;
	}

	listForWorkspace(workspaceId: string): SelectTodoSchedule[] {
		return localDb
			.select()
			.from(todoSchedules)
			.where(eq(todoSchedules.workspaceId, workspaceId))
			.orderBy(desc(todoSchedules.createdAt))
			.all();
	}

	listForProject(projectId: string): SelectTodoSchedule[] {
		return localDb
			.select()
			.from(todoSchedules)
			.where(eq(todoSchedules.projectId, projectId))
			.orderBy(desc(todoSchedules.createdAt))
			.all();
	}

	listAll(): SelectTodoSchedule[] {
		return localDb
			.select()
			.from(todoSchedules)
			.orderBy(desc(todoSchedules.createdAt))
			.all();
	}

	listDue(now: number): SelectTodoSchedule[] {
		return localDb
			.select()
			.from(todoSchedules)
			.where(
				and(
					eq(todoSchedules.enabled, true),
					isNotNull(todoSchedules.nextRunAt),
					lte(todoSchedules.nextRunAt, now),
				),
			)
			.all();
	}
}

let instance: TodoScheduleStore | null = null;

export function getTodoScheduleStore(): TodoScheduleStore {
	if (!instance) {
		instance = new TodoScheduleStore();
	}
	return instance;
}

export type { TodoScheduleStore };
