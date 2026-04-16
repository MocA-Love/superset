import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { v4 as uuidv4 } from "uuid";

/**
 * Reusable system prompt templates the user can attach to a TODO
 * session at creation time. Managed from the Agent Manager's
 * Settings panel (the "設定" row at the bottom of the left sidebar).
 */
export const todoPromptPresets = sqliteTable(
	"todo_prompt_presets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		name: text("name").notNull(),
		content: text("content").notNull(),
		/**
		 * What the preset is meant to fill in:
		 * - "system": appended to the Claude system prompt (--append-system-prompt)
		 * - "description": templates the "やって欲しいこと" field at TODO creation
		 * - "goal": templates the "ゴール" field at TODO creation
		 * Defaults to "system" so existing rows keep their previous semantics.
		 */
		kind: text("kind", { enum: ["system", "description", "goal"] })
			.notNull()
			.default("system"),
		/**
		 * Optional scoping to a specific workspace. NULL = global preset
		 * (available across every workspace). Used by the UI to fold
		 * presets into per-workspace folders.
		 */
		workspaceId: text("workspace_id"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("todo_prompt_presets_name_idx").on(table.name),
		index("todo_prompt_presets_updated_at_idx").on(table.updatedAt),
		index("todo_prompt_presets_kind_idx").on(table.kind),
		index("todo_prompt_presets_workspace_idx").on(table.workspaceId),
	],
);

export type InsertTodoPromptPreset = typeof todoPromptPresets.$inferInsert;
export type SelectTodoPromptPreset = typeof todoPromptPresets.$inferSelect;
