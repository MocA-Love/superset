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
	],
);

export type InsertTodoPromptPreset = typeof todoPromptPresets.$inferInsert;
export type SelectTodoPromptPreset = typeof todoPromptPresets.$inferSelect;
