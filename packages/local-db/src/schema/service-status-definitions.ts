import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { v4 as uuidv4 } from "uuid";

/**
 * Where a service status row's icon comes from.
 *
 *   - `simple-icon` — a brand glyph from `react-icons/si` (icon name stored in
 *      `iconValue`, e.g. `"claude"`, `"openai"`, `"github"`).
 *   - `favicon`     — auto-fetch the favicon of `statusUrl` at render time.
 *      `iconValue` is ignored.
 *   - `custom-url`  — user-supplied remote URL stored in `iconValue`.
 *   - `custom-file` — user-uploaded file; `iconValue` is an absolute path
 *      under the app's userData dir (written by the main process).
 */
export type ServiceStatusIconType =
	| "simple-icon"
	| "favicon"
	| "custom-url"
	| "custom-file";

/**
 * User-configurable list of external status pages to poll.
 *
 * Originally hardcoded for Claude + Codex; this table lets users add, remove,
 * or reorder arbitrary Statuspage.io v2-compatible providers (GitHub, Stripe,
 * etc.) from the Settings → Service status dashboard.
 */
export const serviceStatusDefinitions = sqliteTable(
	"service_status_definitions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		label: text("label").notNull(),
		statusUrl: text("status_url").notNull(),
		apiUrl: text("api_url").notNull(),
		iconType: text("icon_type")
			.notNull()
			.$type<ServiceStatusIconType>()
			.default("favicon"),
		iconValue: text("icon_value"),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("service_status_definitions_sort_order_idx").on(table.sortOrder),
	],
);

export type InsertServiceStatusDefinition =
	typeof serviceStatusDefinitions.$inferInsert;
export type SelectServiceStatusDefinition =
	typeof serviceStatusDefinitions.$inferSelect;
