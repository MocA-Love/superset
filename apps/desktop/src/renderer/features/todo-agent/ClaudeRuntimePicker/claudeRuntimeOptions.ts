import {
	CLAUDE_EFFORT_OPTIONS,
	CLAUDE_MODEL_OPTIONS,
	type TodoClaudeEffort,
	type TodoClaudeModel,
} from "main/todo-agent/types";

/**
 * Sentinel string used in the model/effort Select to represent "no
 * explicit choice — let Claude Code's own default cascade win". The
 * Select value space can't hold `null`, so we round-trip through this
 * sentinel and convert to/from `null` at the persistence boundary.
 *
 * `__default__` was chosen over the empty string because Radix's Select
 * treats empty strings as "value missing", which disables the visual
 * selection state and forces the placeholder to render instead of the
 * "デフォルト" label we want to show.
 */
export const DEFAULT_SENTINEL = "__default__" as const;

export type ClaudeModelPick = typeof DEFAULT_SENTINEL | TodoClaudeModel;
export type ClaudeEffortPick = typeof DEFAULT_SENTINEL | TodoClaudeEffort;

interface Option<V extends string> {
	value: V;
	label: string;
	description: string;
}

export const CLAUDE_MODEL_SELECT_OPTIONS: ReadonlyArray<
	Option<ClaudeModelPick>
> = [
	{
		value: DEFAULT_SENTINEL,
		label: "デフォルト",
		description: "Claude Code の設定をそのまま使う（--model を渡さない）",
	},
	{
		value: "opus",
		label: "Opus（最新）",
		description: "opus 系の最新モデルを alias で指定（Claude 4.x）",
	},
	{
		value: "sonnet",
		label: "Sonnet（最新）",
		description: "sonnet 系の最新モデル",
	},
	{
		value: "haiku",
		label: "Haiku（最新）",
		description: "haiku 系の最新モデル（軽量・高速）",
	},
	{
		value: "claude-opus-4-7",
		label: "Opus 4.7（固定）",
		description: "Opus を 4.7 に固定したいとき",
	},
	{
		value: "claude-sonnet-4-6",
		label: "Sonnet 4.6（固定）",
		description: "Sonnet を 4.6 に固定したいとき",
	},
	{
		value: "claude-haiku-4-5-20251001",
		label: "Haiku 4.5（固定）",
		description: "Haiku を 4.5 に固定したいとき",
	},
] as const;

export const CLAUDE_EFFORT_SELECT_OPTIONS: ReadonlyArray<
	Option<ClaudeEffortPick>
> = [
	{
		value: DEFAULT_SENTINEL,
		label: "デフォルト",
		description: "Claude Code の既定値を尊重する",
	},
	{
		value: "low",
		label: "low（軽量）",
		description: "思考量を抑える。単純タスク向け",
	},
	{
		value: "medium",
		label: "medium",
		description: "中程度の思考量。バランス型",
	},
	{
		value: "high",
		label: "high",
		description: "深く考えさせたいとき",
	},
	{
		value: "xhigh",
		label: "xhigh",
		description: "最上位クラスの思考量",
	},
	{
		value: "max",
		label: "max（最大）",
		description: "上限まで思考。コストが高くなるので注意",
	},
] as const;

/**
 * Hoist both constants so importers don't have to pull them from the
 * main-process types alongside UI-only helpers.
 */
export {
	CLAUDE_EFFORT_OPTIONS,
	CLAUDE_MODEL_OPTIONS,
	type TodoClaudeEffort,
	type TodoClaudeModel,
};

export function toPersistedModel(
	pick: ClaudeModelPick,
): TodoClaudeModel | null {
	return pick === DEFAULT_SENTINEL ? null : pick;
}

export function toPersistedEffort(
	pick: ClaudeEffortPick,
): TodoClaudeEffort | null {
	return pick === DEFAULT_SENTINEL ? null : pick;
}

/**
 * Narrow a DB-side `string | null` back into the picker's discriminated
 * value space. Unknown strings (persisted from an older build with a
 * wider allowed set) fall back to the sentinel so the Select stays on
 * "デフォルト" instead of rendering as empty. We log a warning so a
 * silent data regression is at least visible in DevTools — users who
 * had a now-retired model selected will notice the reset when they
 * next save the TODO / schedule.
 */
export function fromPersistedModel(
	persisted: string | null | undefined,
): ClaudeModelPick {
	if (persisted == null) return DEFAULT_SENTINEL;
	if ((CLAUDE_MODEL_OPTIONS as readonly string[]).includes(persisted)) {
		return persisted as TodoClaudeModel;
	}
	console.warn(
		"[ClaudeRuntimePicker] unknown persisted model, falling back to default:",
		persisted,
	);
	return DEFAULT_SENTINEL;
}

export function fromPersistedEffort(
	persisted: string | null | undefined,
): ClaudeEffortPick {
	if (persisted == null) return DEFAULT_SENTINEL;
	if ((CLAUDE_EFFORT_OPTIONS as readonly string[]).includes(persisted)) {
		return persisted as TodoClaudeEffort;
	}
	console.warn(
		"[ClaudeRuntimePicker] unknown persisted effort, falling back to default:",
		persisted,
	);
	return DEFAULT_SENTINEL;
}

/**
 * Resolve a DB-persisted model/effort value to the human-readable label
 * the picker shows. Used by read-only views (session detail, schedule
 * list) so the label matches what the user originally selected.
 *
 * null/undefined → "デフォルト" (matches the sentinel's label).
 * Unknown values (persisted from an older build with a wider allowed set)
 * surface the raw string so detail views don't silently lie about what is
 * actually configured — we fall back to `fromPersisted*` only for the
 * `DEFAULT_SENTINEL` case.
 */
export function getClaudeModelLabel(
	persisted: string | null | undefined,
): string {
	if (persisted == null) {
		return (
			CLAUDE_MODEL_SELECT_OPTIONS.find((o) => o.value === DEFAULT_SENTINEL)
				?.label ?? "デフォルト"
		);
	}
	return (
		CLAUDE_MODEL_SELECT_OPTIONS.find((o) => o.value === persisted)?.label ??
		persisted
	);
}

export function getClaudeEffortLabel(
	persisted: string | null | undefined,
): string {
	if (persisted == null) {
		return (
			CLAUDE_EFFORT_SELECT_OPTIONS.find((o) => o.value === DEFAULT_SENTINEL)
				?.label ?? "デフォルト"
		);
	}
	return (
		CLAUDE_EFFORT_SELECT_OPTIONS.find((o) => o.value === persisted)?.label ??
		persisted
	);
}
