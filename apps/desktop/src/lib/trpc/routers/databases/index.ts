import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import Database from "better-sqlite3";
import fg from "fast-glob";
import { Client } from "pg";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	discoverWorkspaceConfiguredDatabases,
	postgresConnectionSourceSchema,
	resolvePostgresConnectionStringFromSource,
	saveWorkspaceDatabaseCredentials,
	updateWorkspaceDatabaseDefinition,
} from "./workspace-config";

const SQLITE_FILE_GLOBS = [
	"**/*.db",
	"**/*.sqlite",
	"**/*.sqlite3",
	"**/*.db3",
	"**/*.duckdb",
];

const SQLITE_ROW_ID_COLUMN = "__superset_rowid";
const SQLITE_PRIMARY_KEY_COLUMN = "__superset_primary_key";
const POSTGRES_ROW_ID_COLUMN = "__superset_ctid";
const PREVIEW_TEXT_LIMIT = 180;

function isAbsoluteFilesystemPath(inputPath: string): boolean {
	return path.isAbsolute(inputPath) || /^[A-Za-z]:[\\/]/.test(inputPath);
}

function ensureAbsoluteFilesystemPath(inputPath: string): void {
	if (!isAbsoluteFilesystemPath(inputPath)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Database path must be absolute.",
		});
	}
}

async function ensureExistingFile(inputPath: string): Promise<void> {
	let metadata: Stats;
	try {
		metadata = await stat(inputPath);
	} catch {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Database file not found: ${inputPath}`,
		});
	}

	if (!metadata.isFile()) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Path is not a file: ${inputPath}`,
		});
	}
}

async function ensureExistingDirectory(inputPath: string): Promise<void> {
	let metadata: Stats;
	try {
		metadata = await stat(inputPath);
	} catch {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Workspace path not found: ${inputPath}`,
		});
	}

	if (!metadata.isDirectory()) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Path is not a directory: ${inputPath}`,
		});
	}
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quotePostgresIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function buildSqlitePreviewExpression(
	columnName: string,
	declaredType: string | null | undefined,
): string {
	const quotedColumn = quoteSqliteIdentifier(columnName);
	const normalizedType = (declaredType ?? "").toLowerCase();

	if (normalizedType.includes("blob")) {
		return `CASE WHEN ${quotedColumn} IS NULL THEN NULL ELSE '<blob ' || length(${quotedColumn}) || ' bytes>' END AS ${quoteSqliteIdentifier(columnName)}`;
	}

	if (
		normalizedType.includes("text") ||
		normalizedType.includes("char") ||
		normalizedType.includes("clob") ||
		normalizedType.includes("json") ||
		normalizedType.length === 0
	) {
		return `CASE
			WHEN ${quotedColumn} IS NULL THEN NULL
			WHEN typeof(${quotedColumn}) = 'text' AND length(CAST(${quotedColumn} AS TEXT)) > ${PREVIEW_TEXT_LIMIT}
				THEN substr(CAST(${quotedColumn} AS TEXT), 1, ${PREVIEW_TEXT_LIMIT}) || '…'
			ELSE ${quotedColumn}
		END AS ${quoteSqliteIdentifier(columnName)}`;
	}

	return `${quotedColumn} AS ${quoteSqliteIdentifier(columnName)}`;
}

function buildPostgresPreviewExpression(input: {
	columnName: string;
	dataType: string;
	udtName: string;
}): string {
	const quotedColumn = quotePostgresIdentifier(input.columnName);
	const outputAlias = quotePostgresIdentifier(input.columnName);
	const normalizedType = input.dataType.toLowerCase();
	const normalizedUdtName = input.udtName.toLowerCase();

	if (normalizedType === "bytea") {
		return `CASE WHEN ${quotedColumn} IS NULL THEN NULL ELSE '<bytea ' || octet_length(${quotedColumn})::text || ' bytes>' END AS ${outputAlias}`;
	}

	if (normalizedType === "json" || normalizedType === "jsonb") {
		return `CASE
			WHEN ${quotedColumn} IS NULL THEN NULL
			ELSE '<${normalizedType}> ' || left(${quotedColumn}::text, ${PREVIEW_TEXT_LIMIT}) ||
				CASE WHEN length(${quotedColumn}::text) > ${PREVIEW_TEXT_LIMIT} THEN '…' ELSE '' END
		END AS ${outputAlias}`;
	}

	if (normalizedType === "array") {
		return `CASE
			WHEN ${quotedColumn} IS NULL THEN NULL
			ELSE 'Array(' || coalesce(cardinality(${quotedColumn}), 0)::text || ') ' ||
				left(${quotedColumn}::text, ${PREVIEW_TEXT_LIMIT}) ||
				CASE WHEN length(${quotedColumn}::text) > ${PREVIEW_TEXT_LIMIT} THEN '…' ELSE '' END
		END AS ${outputAlias}`;
	}

	if (
		normalizedType === "text" ||
		normalizedType === "character varying" ||
		normalizedType === "character" ||
		normalizedType === "xml" ||
		normalizedType === "citext" ||
		normalizedType === "tsvector" ||
		normalizedType === "tsquery" ||
		normalizedUdtName === "vector" ||
		normalizedUdtName === "halfvec" ||
		normalizedUdtName === "sparsevec" ||
		normalizedUdtName === "geometry" ||
		normalizedUdtName === "geography" ||
		normalizedUdtName === "hstore"
	) {
		return `CASE
			WHEN ${quotedColumn} IS NULL THEN NULL
			WHEN length(${quotedColumn}::text) > ${PREVIEW_TEXT_LIMIT}
				THEN left(${quotedColumn}::text, ${PREVIEW_TEXT_LIMIT}) || '…'
			ELSE ${quotedColumn}::text
		END AS ${outputAlias}`;
	}

	return `${quotedColumn} AS ${outputAlias}`;
}

function getSqliteTableMetadata(
	db: Database.Database,
	tableName: string,
): {
	columns: Array<{
		cid: number;
		name: string;
		type: string | null;
		notnull: 0 | 1;
		dflt_value: string | null;
		pk: number;
	}>;
	primaryKeyColumns: Array<{
		cid: number;
		name: string;
		type: string | null;
		notnull: 0 | 1;
		dflt_value: string | null;
		pk: number;
	}>;
	hasRowId: boolean;
} {
	const columns = db
		.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`)
		.all() as Array<{
		cid: number;
		name: string;
		type: string | null;
		notnull: 0 | 1;
		dflt_value: string | null;
		pk: number;
	}>;
	const primaryKeyColumns = columns
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk);
	const tableDefinition = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
		)
		.get(tableName) as { sql?: string | null } | undefined;

	return {
		columns,
		primaryKeyColumns,
		hasRowId: !/without\s+rowid/i.test(tableDefinition?.sql ?? ""),
	};
}

function buildSqlitePrimaryKeyPreviewExpression(
	primaryKeyColumns: Array<{ name: string }>,
): string {
	if (primaryKeyColumns.length === 0) {
		return `NULL AS ${quoteSqliteIdentifier(SQLITE_PRIMARY_KEY_COLUMN)}`;
	}

	const jsonEntries = primaryKeyColumns.flatMap((column) => [
		quoteSqlStringLiteral(column.name),
		quoteSqliteIdentifier(column.name),
	]);

	return `json_object(${jsonEntries.join(", ")}) AS ${quoteSqliteIdentifier(SQLITE_PRIMARY_KEY_COLUMN)}`;
}

function openSqliteDatabase(databasePath: string): Database.Database {
	try {
		return new Database(databasePath, {
			fileMustExist: true,
		});
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error
					? error.message
					: "Failed to open SQLite database.",
		});
	}
}

async function withPostgresClient<T>(
	connectionString: string,
	callback: (client: Client) => Promise<T>,
): Promise<T> {
	const client = new Client({ connectionString });

	try {
		await client.connect();
		return await callback(client);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error
					? error.message
					: "Failed to connect to PostgreSQL.",
		});
	} finally {
		await client.end().catch(() => undefined);
	}
}

function stripTrailingSemicolon(sql: string): string {
	return sql.replace(/;\s*$/, "");
}

function canApplyPostgresReadLimit(sql: string): boolean {
	return /^(select|with|values|table)\b/i.test(sql.trim());
}

export const createDatabasesRouter = () => {
	return router({
		discoverSqliteFiles: publicProcedure
			.input(
				z.object({
					worktreePath: z.string().min(1),
					limit: z.number().int().positive().max(200).optional(),
				}),
			)
			.query(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.worktreePath);
				await ensureExistingDirectory(input.worktreePath);

				const limit = input.limit ?? 50;
				const files = await fg(SQLITE_FILE_GLOBS, {
					absolute: true,
					cwd: input.worktreePath,
					onlyFiles: true,
					unique: true,
					suppressErrors: true,
					ignore: [
						"**/.git/**",
						"**/.next/**",
						"**/.turbo/**",
						"**/dist/**",
						"**/node_modules/**",
					],
				});

				return {
					files: files
						.sort((left, right) => left.localeCompare(right))
						.slice(0, limit)
						.map((absolutePath) => ({
							absolutePath,
							relativePath: path.relative(input.worktreePath, absolutePath),
						})),
				};
			}),

		discoverWorkspaceDatabases: publicProcedure
			.input(
				z.object({
					worktreePath: z.string().min(1),
					limit: z.number().int().positive().max(200).optional(),
				}),
			)
			.query(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.worktreePath);
				await ensureExistingDirectory(input.worktreePath);

				const limit = input.limit ?? 50;
				const files = await fg(SQLITE_FILE_GLOBS, {
					absolute: true,
					cwd: input.worktreePath,
					onlyFiles: true,
					unique: true,
					suppressErrors: true,
					ignore: [
						"**/.git/**",
						"**/.next/**",
						"**/.turbo/**",
						"**/dist/**",
						"**/node_modules/**",
					],
				});

				const configuredDatabases = await discoverWorkspaceConfiguredDatabases(
					input.worktreePath,
				);
				const configuredSqlitePaths = new Set(
					configuredDatabases
						.filter((item) => item.dialect === "sqlite")
						.map((item) => item.absolutePath),
				);

				const fileItems = files
					.filter((absolutePath) => !configuredSqlitePaths.has(absolutePath))
					.map((absolutePath) => ({
						source: "file" as const,
						dialect: "sqlite" as const,
						absolutePath,
						relativePath: path.relative(input.worktreePath, absolutePath),
					}));

				const items = [...fileItems, ...configuredDatabases]
					.sort((left, right) =>
						left.relativePath.localeCompare(right.relativePath),
					)
					.slice(0, limit);

				return { items };
			}),

		saveWorkspaceDatabaseCredentials: publicProcedure
			.input(
				z.object({
					worktreePath: z.string().min(1),
					definitionId: z.string().min(1),
					username: z.string().min(1),
					password: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.worktreePath);
				await ensureExistingDirectory(input.worktreePath);
				await saveWorkspaceDatabaseCredentials({
					workspacePath: input.worktreePath,
					definitionId: input.definitionId,
					username: input.username,
					password: input.password,
				});
				return { ok: true };
			}),

		updateWorkspaceDatabaseDefinition: publicProcedure
			.input(
				z.object({
					worktreePath: z.string().min(1),
					definitionId: z.string().min(1),
					definition: z.discriminatedUnion("dialect", [
						z.object({
							dialect: z.literal("sqlite"),
							label: z.string().min(1),
							group: z.string().trim().min(1).optional(),
							databasePath: z.string().min(1),
						}),
						z.object({
							dialect: z.literal("postgres"),
							label: z.string().min(1),
							group: z.string().trim().min(1).optional(),
							host: z.string().min(1),
							port: z.number().int().positive().max(65535),
							database: z.string().optional(),
							ssl: z.boolean(),
							username: z.string().min(1).optional(),
						}),
					]),
				}),
			)
			.mutation(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.worktreePath);
				await ensureExistingDirectory(input.worktreePath);
				const definition = await updateWorkspaceDatabaseDefinition({
					workspacePath: input.worktreePath,
					definitionId: input.definitionId,
					definition: input.definition,
				});
				return { definition };
			}),

		inspectSqlite: publicProcedure
			.input(
				z.object({
					databasePath: z.string().min(1),
				}),
			)
			.query(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.databasePath);
				await ensureExistingFile(input.databasePath);

				const db = openSqliteDatabase(input.databasePath);

				try {
					const tables = db
						.prepare(
							`
								SELECT name, type
								FROM sqlite_master
								WHERE type IN ('table', 'view')
									AND name NOT LIKE 'sqlite_%'
								ORDER BY type, name
							`,
						)
						.all() as Array<{
						name: string;
						type: "table" | "view";
					}>;

					return {
						tables: tables.map((table) => ({
							schema: null,
							name: table.name,
							type: table.type,
							columns: db
								.prepare(
									`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`,
								)
								.all() as Array<{
								cid: number;
								name: string;
								type: string;
								notnull: 0 | 1;
								dflt_value: string | null;
								pk: 0 | 1;
							}>,
						})),
					};
				} finally {
					db.close();
				}
			}),

		inspectPostgres: publicProcedure
			.input(
				z.object({
					connection: postgresConnectionSourceSchema,
				}),
			)
			.query(async ({ input }) => {
				const connectionString =
					await resolvePostgresConnectionStringFromSource({
						source: input.connection,
					});
				return await withPostgresClient(connectionString, async (client) => {
					const result = await client.query<{
						table_schema: string;
						table_name: string;
						table_type: string;
						column_name: string;
						data_type: string;
						is_nullable: "YES" | "NO";
						ordinal_position: number;
					}>(`
						SELECT
							t.table_schema,
							t.table_name,
							t.table_type,
							c.column_name,
							c.data_type,
							c.is_nullable,
							c.ordinal_position
						FROM information_schema.tables t
						JOIN information_schema.columns c
							ON t.table_schema = c.table_schema
							AND t.table_name = c.table_name
						WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
						ORDER BY t.table_schema, t.table_name, c.ordinal_position
					`);

					const tables = new Map<
						string,
						{
							schema: string;
							name: string;
							type: string;
							columns: {
								cid: number;
								name: string;
								type: string;
								notnull: 0 | 1;
								dflt_value: string | null;
								pk: 0 | 1;
							}[];
						}
					>();

					for (const row of result.rows) {
						const key = `${row.table_schema}.${row.table_name}`;
						const current:
							| {
									schema: string;
									name: string;
									type: string;
									columns: {
										cid: number;
										name: string;
										type: string;
										notnull: 0 | 1;
										dflt_value: string | null;
										pk: 0 | 1;
									}[];
							  }
							| undefined = tables.get(key);
						const nextTable = current ?? {
							schema: row.table_schema,
							name: row.table_name,
							type: row.table_type.toLowerCase(),
							columns: [] as {
								cid: number;
								name: string;
								type: string;
								notnull: 0 | 1;
								dflt_value: string | null;
								pk: 0 | 1;
							}[],
						};
						nextTable.columns.push({
							cid: row.ordinal_position,
							name: row.column_name,
							type: row.data_type,
							notnull: row.is_nullable === "NO" ? 1 : 0,
							dflt_value: null,
							pk: 0,
						});
						tables.set(key, nextTable);
					}

					return {
						tables: Array.from(tables.values()),
					};
				});
			}),

		previewSqliteTable: publicProcedure
			.input(
				z.object({
					databasePath: z.string().min(1),
					tableName: z.string().min(1),
					limit: z.number().int().positive().max(200).optional(),
					offset: z.number().int().min(0).optional(),
				}),
			)
			.query(async ({ input }) => {
				try {
					ensureAbsoluteFilesystemPath(input.databasePath);
					await ensureExistingFile(input.databasePath);

					const db = openSqliteDatabase(input.databasePath);
					const limit = input.limit ?? 50;
					const offset = input.offset ?? 0;
					const startedAt = performance.now();
					try {
						const metadata = getSqliteTableMetadata(db, input.tableName);
						const previewSelect = metadata.columns
							.map((column) =>
								buildSqlitePreviewExpression(column.name, column.type),
							)
							.join(", ");
						const selectColumns = [
							metadata.hasRowId
								? `rowid AS ${quoteSqliteIdentifier(SQLITE_ROW_ID_COLUMN)}`
								: null,
							buildSqlitePrimaryKeyPreviewExpression(
								metadata.primaryKeyColumns,
							),
							previewSelect,
						].filter(Boolean);
						const statement = db.prepare(
							`SELECT ${selectColumns.join(", ")} FROM ${quoteSqliteIdentifier(input.tableName)} LIMIT ? OFFSET ?`,
						);
						const previewRows = statement.all(limit + 1, offset) as Array<
							Record<string, unknown>
						>;
						const hasMore = previewRows.length > limit;
						const rows = hasMore ? previewRows.slice(0, limit) : previewRows;

						return {
							columns: statement
								.columns()
								.map((column) => column.name)
								.filter(
									(column) =>
										column !== SQLITE_ROW_ID_COLUMN &&
										column !== SQLITE_PRIMARY_KEY_COLUMN,
								),
							rows,
							rowCount: rows.length,
							totalRows: null,
							hasMore,
							offset,
							limit,
							elapsedMs: Math.round(performance.now() - startedAt),
						};
					} finally {
						db.close();
					}
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error
								? error.message
								: "Failed to preview SQLite table.",
					});
				}
			}),

		getSqliteRowDetail: publicProcedure
			.input(
				z.object({
					databasePath: z.string().min(1),
					tableName: z.string().min(1),
					rowId: z.union([z.string(), z.number()]).optional(),
					primaryKey: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.databasePath);
				await ensureExistingFile(input.databasePath);

				const db = openSqliteDatabase(input.databasePath);
				try {
					const metadata = getSqliteTableMetadata(db, input.tableName);
					let whereClause = "";
					const parameters: Array<string | number | null> = [];

					if (metadata.primaryKeyColumns.length > 0) {
						if (!input.primaryKey) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message:
									"Primary key payload is required for this SQLite table.",
							});
						}

						let parsedPrimaryKey: Record<string, unknown>;
						try {
							parsedPrimaryKey = JSON.parse(input.primaryKey) as Record<
								string,
								unknown
							>;
						} catch {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: "Invalid SQLite primary key payload.",
							});
						}
						whereClause = metadata.primaryKeyColumns
							.map((column) => {
								const value = parsedPrimaryKey[column.name];
								if (value === null) {
									return `${quoteSqliteIdentifier(column.name)} IS NULL`;
								}
								parameters.push((value ?? null) as string | number | null);
								return `${quoteSqliteIdentifier(column.name)} = ?`;
							})
							.join(" AND ");
					} else if (metadata.hasRowId) {
						if (input.rowId === undefined) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: "rowid is required for this SQLite table.",
							});
						}
						whereClause = "rowid = ?";
						parameters.push(input.rowId);
					} else {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message:
								"This SQLite table has neither a rowid nor a primary key.",
						});
					}

					const row = db
						.prepare(
							`SELECT * FROM ${quoteSqliteIdentifier(input.tableName)} WHERE ${whereClause} LIMIT 1`,
						)
						.get(...parameters) as Record<string, unknown> | undefined;

					if (!row) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Row not found.",
						});
					}

					return { row };
				} finally {
					db.close();
				}
			}),

		previewPostgresTable: publicProcedure
			.input(
				z.object({
					connection: postgresConnectionSourceSchema,
					schema: z.string().min(1),
					tableName: z.string().min(1),
					limit: z.number().int().positive().max(200).optional(),
					offset: z.number().int().min(0).optional(),
				}),
			)
			.query(async ({ input }) => {
				const limit = input.limit ?? 50;
				const offset = input.offset ?? 0;
				const startedAt = performance.now();
				const connectionString =
					await resolvePostgresConnectionStringFromSource({
						source: input.connection,
					});

				return await withPostgresClient(connectionString, async (client) => {
					const columnInfo = await client.query<{
						column_name: string;
						data_type: string;
						udt_name: string;
						ordinal_position: number;
					}>(
						`
								SELECT column_name, data_type, udt_name, ordinal_position
								FROM information_schema.columns
								WHERE table_schema = $1 AND table_name = $2
								ORDER BY ordinal_position
							`,
						[input.schema, input.tableName],
					);
					const qualifiedTableName = `${quotePostgresIdentifier(input.schema)}.${quotePostgresIdentifier(input.tableName)}`;
					const previewSelect = columnInfo.rows
						.map((column) =>
							buildPostgresPreviewExpression({
								columnName: column.column_name,
								dataType: column.data_type,
								udtName: column.udt_name,
							}),
						)
						.join(", ");
					const dataResult = await client.query(
						`SELECT ctid::text AS ${quotePostgresIdentifier(POSTGRES_ROW_ID_COLUMN)}, ${previewSelect} FROM ${qualifiedTableName} LIMIT $1 OFFSET $2`,
						[limit + 1, offset],
					);
					const hasMore = dataResult.rows.length > limit;
					const rows = hasMore
						? dataResult.rows.slice(0, limit)
						: dataResult.rows;

					return {
						columns: dataResult.fields
							.map((field: { name: string }) => field.name)
							.filter((column) => column !== POSTGRES_ROW_ID_COLUMN),
						rows,
						rowCount: rows.length,
						totalRows: null,
						hasMore,
						offset,
						limit,
						elapsedMs: Math.round(performance.now() - startedAt),
					};
				});
			}),

		getPostgresRowDetail: publicProcedure
			.input(
				z.object({
					connection: postgresConnectionSourceSchema,
					schema: z.string().min(1),
					tableName: z.string().min(1),
					ctid: z.string().min(1),
				}),
			)
			.query(async ({ input }) => {
				const connectionString =
					await resolvePostgresConnectionStringFromSource({
						source: input.connection,
					});
				return await withPostgresClient(connectionString, async (client) => {
					const qualifiedTableName = `${quotePostgresIdentifier(input.schema)}.${quotePostgresIdentifier(input.tableName)}`;
					const result = await client.query(
						`SELECT ctid::text AS ${quotePostgresIdentifier(POSTGRES_ROW_ID_COLUMN)}, * FROM ${qualifiedTableName} WHERE ctid = $1::tid LIMIT 1`,
						[input.ctid],
					);

					const row = result.rows[0] as Record<string, unknown> | undefined;
					if (!row) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Row not found.",
						});
					}

					return { row };
				});
			}),

		executeSqlite: publicProcedure
			.input(
				z.object({
					databasePath: z.string().min(1),
					sql: z.string().min(1),
					limit: z.number().int().positive().max(1000).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				ensureAbsoluteFilesystemPath(input.databasePath);
				await ensureExistingFile(input.databasePath);

				const sql = input.sql.trim();
				if (!sql) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "SQL is required.",
					});
				}

				const db = openSqliteDatabase(input.databasePath);
				const startedAt = performance.now();

				try {
					const statement = db.prepare(sql);
					const limit = input.limit ?? 200;

					if (!statement.reader) {
						const result = statement.run();
						return {
							columns: [] as string[],
							rows: [] as Array<Record<string, unknown>>,
							rowCount: result.changes,
							truncated: false,
							elapsedMs: Math.round(performance.now() - startedAt),
							command: "write",
							lastInsertRowid:
								typeof result.lastInsertRowid === "bigint"
									? result.lastInsertRowid.toString()
									: result.lastInsertRowid,
						};
					}

					const rows: Array<Record<string, unknown>> = [];
					let truncated = false;
					for (const row of statement.iterate() as Iterable<
						Record<string, unknown>
					>) {
						if (rows.length >= limit) {
							truncated = true;
							break;
						}
						rows.push(row);
					}

					return {
						columns: statement.columns().map((column) => column.name),
						rows,
						rowCount: rows.length,
						truncated,
						elapsedMs: Math.round(performance.now() - startedAt),
						command: "read",
					};
				} catch (error) {
					if (error instanceof TRPCError) {
						throw error;
					}

					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error ? error.message : "Failed to execute SQL.",
					});
				} finally {
					db.close();
				}
			}),

		executePostgres: publicProcedure
			.input(
				z.object({
					connection: postgresConnectionSourceSchema,
					sql: z.string().min(1),
					limit: z.number().int().positive().max(1000).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const sql = input.sql.trim();
				if (!sql) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "SQL is required.",
					});
				}

				const startedAt = performance.now();
				const connectionString =
					await resolvePostgresConnectionStringFromSource({
						source: input.connection,
					});
				return await withPostgresClient(connectionString, async (client) => {
					const limit = input.limit ?? 200;
					if (canApplyPostgresReadLimit(sql)) {
						const limitedSql = `SELECT * FROM (${stripTrailingSemicolon(
							sql,
						)}) AS __superset_query LIMIT ${limit + 1}`;
						const limitedResult = await client.query(limitedSql);
						const truncated = limitedResult.rows.length > limit;
						const rows = truncated
							? limitedResult.rows.slice(0, limit)
							: limitedResult.rows;

						return {
							columns: limitedResult.fields.map(
								(field: { name: string }) => field.name,
							),
							rows,
							rowCount: rows.length,
							truncated,
							elapsedMs: Math.round(performance.now() - startedAt),
							command: "SELECT",
						};
					}

					const result = await client.query(sql);

					return {
						columns: result.fields.map((field: { name: string }) => field.name),
						rows: result.rows.slice(0, limit),
						rowCount: result.rowCount ?? result.rows.length,
						truncated: result.rows.length > limit,
						elapsedMs: Math.round(performance.now() - startedAt),
						command: result.command,
					};
				});
			}),
	});
};
