import {
	type InsertServiceStatusDefinition,
	serviceStatusDefinitions,
	settings,
} from "@superset/local-db";
import { asc, eq } from "drizzle-orm";
import type {
	ServiceStatusDefinition,
	ServiceStatusFormat,
	ServiceStatusIconType,
} from "shared/service-status-types";
import { localDb } from "../local-db";

/**
 * Defaults seeded into local-db on first launch. Matches the hardcoded pair
 * the feature originally shipped with. After seeding, users can freely add,
 * remove, or relabel rows — these defaults are not "built-in" / immutable.
 *
 * Kept alongside the seed logic (not in `shared/`) so the renderer bundle
 * doesn't pick up a constant it never needs.
 */
const DEFAULT_SERVICE_STATUS_DEFINITIONS: readonly ServiceStatusDefinition[] = [
	{
		id: "claude",
		label: "Claude",
		statusUrl: "https://status.claude.com/",
		apiUrl: "https://status.claude.com/api/v2/status.json",
		iconType: "simple-icon",
		iconValue: "claude",
		format: "statuspage-v2",
		sortOrder: 0,
	},
	{
		id: "codex",
		label: "Codex",
		statusUrl: "https://status.openai.com/",
		apiUrl: "https://status.openai.com/api/v2/status.json",
		iconType: "simple-icon",
		iconValue: "openai",
		format: "statuspage-v2",
		sortOrder: 1,
	},
];

const KNOWN_ICON_TYPES = new Set<ServiceStatusIconType>([
	"simple-icon",
	"favicon",
	"custom-url",
	"custom-file",
]);

const KNOWN_FORMATS = new Set<ServiceStatusFormat>([
	"statuspage-v2",
	"gcp-incidents",
	"aws-health",
	"azure-rss",
]);

/**
 * Drizzle's `$type<>` is compile-time only — a row that was hand-edited or
 * written by an older build could carry an unrecognized iconType. Fall back
 * to favicon so the dashboard never crashes on bad data, and log once so
 * the divergence is visible during support triage.
 */
function narrowIconType(value: string): ServiceStatusIconType {
	if ((KNOWN_ICON_TYPES as Set<string>).has(value)) {
		return value as ServiceStatusIconType;
	}
	console.warn(
		`[service-status] Unknown iconType "${value}" — falling back to favicon`,
	);
	return "favicon";
}

/**
 * Same defensive narrowing pattern as iconType, for the `format` column. An
 * unknown value is treated as `statuspage-v2` because that's the most likely
 * intent for any pre-migration row and because the Statuspage.io parser is
 * the most forgiving about unexpected JSON shapes.
 */
function narrowFormat(value: string): ServiceStatusFormat {
	if ((KNOWN_FORMATS as Set<string>).has(value)) {
		return value as ServiceStatusFormat;
	}
	console.warn(
		`[service-status] Unknown format "${value}" — falling back to statuspage-v2`,
	);
	return "statuspage-v2";
}

/**
 * Maps a DB row to the shape consumed by the poller / renderer. Keeps the
 * `string`-typed DB column from leaking into downstream callers.
 */
function rowToDefinition(row: {
	id: string;
	label: string;
	statusUrl: string;
	apiUrl: string;
	iconType: string;
	iconValue: string | null;
	format: string;
	sortOrder: number;
}): ServiceStatusDefinition {
	return {
		id: row.id,
		label: row.label,
		statusUrl: row.statusUrl,
		apiUrl: row.apiUrl,
		iconType: narrowIconType(row.iconType),
		iconValue: row.iconValue,
		format: narrowFormat(row.format),
		sortOrder: row.sortOrder,
	};
}

export function listServiceStatusDefinitions(): ServiceStatusDefinition[] {
	const rows = localDb
		.select()
		.from(serviceStatusDefinitions)
		.orderBy(
			asc(serviceStatusDefinitions.sortOrder),
			asc(serviceStatusDefinitions.createdAt),
		)
		.all();
	return rows.map(rowToDefinition);
}

export function getServiceStatusDefinition(
	id: string,
): ServiceStatusDefinition | null {
	const row = localDb
		.select()
		.from(serviceStatusDefinitions)
		.where(eq(serviceStatusDefinitions.id, id))
		.get();
	return row ? rowToDefinition(row) : null;
}

export interface CreateServiceStatusDefinitionInput {
	label: string;
	statusUrl: string;
	apiUrl: string;
	iconType: ServiceStatusIconType;
	iconValue: string | null;
	format?: ServiceStatusFormat;
	// When omitted, the new row is appended (sortOrder = max + 1).
	sortOrder?: number;
	// Allows the seed path to insert with deterministic ids matching the
	// previously-hardcoded "claude" / "codex" slugs so users' persisted
	// per-service preferences (if any) keep lining up after the table lands.
	id?: string;
}

export function createServiceStatusDefinition(
	input: CreateServiceStatusDefinitionInput,
): ServiceStatusDefinition {
	const nextSortOrder = input.sortOrder ?? nextAppendSortOrder();
	const now = Date.now();
	const insertValues: InsertServiceStatusDefinition = {
		...(input.id ? { id: input.id } : {}),
		label: input.label,
		statusUrl: input.statusUrl,
		apiUrl: input.apiUrl,
		iconType: input.iconType,
		iconValue: input.iconValue,
		format: input.format ?? "statuspage-v2",
		sortOrder: nextSortOrder,
		createdAt: now,
		updatedAt: now,
	};
	const row = localDb
		.insert(serviceStatusDefinitions)
		.values(insertValues)
		.returning()
		.get();
	return rowToDefinition(row);
}

export interface UpdateServiceStatusDefinitionInput {
	label?: string;
	statusUrl?: string;
	apiUrl?: string;
	iconType?: ServiceStatusIconType;
	iconValue?: string | null;
	format?: ServiceStatusFormat;
	sortOrder?: number;
}

export function updateServiceStatusDefinition(
	id: string,
	patch: UpdateServiceStatusDefinitionInput,
): ServiceStatusDefinition | null {
	const row = localDb
		.update(serviceStatusDefinitions)
		.set({ ...patch, updatedAt: Date.now() })
		.where(eq(serviceStatusDefinitions.id, id))
		.returning()
		.get();
	return row ? rowToDefinition(row) : null;
}

export function deleteServiceStatusDefinition(id: string): boolean {
	const row = localDb
		.delete(serviceStatusDefinitions)
		.where(eq(serviceStatusDefinitions.id, id))
		.returning({ id: serviceStatusDefinitions.id })
		.get();
	return Boolean(row);
}

function nextAppendSortOrder(): number {
	const rows = localDb
		.select({ sortOrder: serviceStatusDefinitions.sortOrder })
		.from(serviceStatusDefinitions)
		.all();
	if (rows.length === 0) return 0;
	return Math.max(...rows.map((r) => r.sortOrder)) + 1;
}

/**
 * On first launch, seed the default Claude + Codex rows so the poller has
 * something to show. The `serviceStatusDefaultsSeeded` flag on the settings
 * singleton ensures a user who deletes every row isn't surprised by a re-seed
 * on next launch.
 */
export function seedDefaultDefinitionsIfNeeded(): void {
	const settingsRow = localDb
		.select({ seeded: settings.serviceStatusDefaultsSeeded })
		.from(settings)
		.where(eq(settings.id, 1))
		.get();
	if (settingsRow?.seeded) return;

	const now = Date.now();
	localDb.transaction((tx) => {
		for (const def of DEFAULT_SERVICE_STATUS_DEFINITIONS) {
			// Skip if a row with the same id already exists (defensive: lets us
			// re-run the seed after a schema rebuild without throwing on the
			// primary-key collision).
			const existing = tx
				.select({ id: serviceStatusDefinitions.id })
				.from(serviceStatusDefinitions)
				.where(eq(serviceStatusDefinitions.id, def.id))
				.get();
			if (existing) continue;
			tx.insert(serviceStatusDefinitions)
				.values({
					id: def.id,
					label: def.label,
					statusUrl: def.statusUrl,
					apiUrl: def.apiUrl,
					iconType: def.iconType,
					iconValue: def.iconValue,
					format: def.format,
					sortOrder: def.sortOrder,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}
		// Upsert the settings singleton: insert with id=1 + flag, or update
		// the existing row.
		tx.insert(settings)
			.values({ id: 1, serviceStatusDefaultsSeeded: true })
			.onConflictDoUpdate({
				target: settings.id,
				set: { serviceStatusDefaultsSeeded: true },
			})
			.run();
	});
}
