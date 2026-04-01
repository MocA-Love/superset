import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import Database from "better-sqlite3";
import fg from "fast-glob";
import { Client } from "pg";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const SQLITE_FILE_GLOBS = [
	"**/*.db",
	"**/*.sqlite",
	"**/*.sqlite3",
	"**/*.db3",
	"**/*.duckdb",
];

const SQLITE_ROW_ID_COLUMN = "__superset_rowid";
const POSTGRES_ROW_ID_COLUMN = "__superset_ctid";

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
					connectionString: z.string().min(1),
				}),
			)
			.query(async ({ input }) => {
				return await withPostgresClient(
					input.connectionString,
					async (client) => {
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
					},
				);
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
				console.log("[databases.previewSqliteTable:start]", {
					databasePath: input.databasePath,
					tableName: input.tableName,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				});
				try {
					ensureAbsoluteFilesystemPath(input.databasePath);
					await ensureExistingFile(input.databasePath);

					const db = openSqliteDatabase(input.databasePath);
					const limit = input.limit ?? 50;
					const offset = input.offset ?? 0;
					const startedAt = performance.now();
					try {
						const statement = db.prepare(
							`SELECT rowid AS ${quoteSqliteIdentifier(SQLITE_ROW_ID_COLUMN)}, * FROM ${quoteSqliteIdentifier(input.tableName)} LIMIT ? OFFSET ?`,
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
								.filter((column) => column !== SQLITE_ROW_ID_COLUMN),
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
				} finally {
					console.log("[databases.previewSqliteTable:end]", {
						databasePath: input.databasePath,
						tableName: input.tableName,
					});
				}
			}),

		previewPostgresTable: publicProcedure
			.input(
				z.object({
					connectionString: z.string().min(1),
					schema: z.string().min(1),
					tableName: z.string().min(1),
					limit: z.number().int().positive().max(200).optional(),
					offset: z.number().int().min(0).optional(),
				}),
			)
			.query(async ({ input }) => {
				console.log("[databases.previewPostgresTable:start]", {
					schema: input.schema,
					tableName: input.tableName,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				});
				try {
					const limit = input.limit ?? 50;
					const offset = input.offset ?? 0;
					const startedAt = performance.now();

					return await withPostgresClient(
						input.connectionString,
						async (client) => {
							const qualifiedTableName = `${quotePostgresIdentifier(input.schema)}.${quotePostgresIdentifier(input.tableName)}`;
							const dataResult = await client.query(
								`SELECT ctid::text AS ${quotePostgresIdentifier(POSTGRES_ROW_ID_COLUMN)}, * FROM ${qualifiedTableName} LIMIT $1 OFFSET $2`,
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
						},
					);
				} finally {
					console.log("[databases.previewPostgresTable:end]", {
						schema: input.schema,
						tableName: input.tableName,
					});
				}
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
					connectionString: z.string().min(1),
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
				return await withPostgresClient(
					input.connectionString,
					async (client) => {
						const result = await client.query(sql);
						const limit = input.limit ?? 200;

						return {
							columns: result.fields.map(
								(field: { name: string }) => field.name,
							),
							rows: result.rows.slice(0, limit),
							rowCount: result.rowCount ?? result.rows.length,
							truncated: result.rows.length > limit,
							elapsedMs: Math.round(performance.now() - startedAt),
							command: result.command,
						};
					},
				);
			}),
	});
};
