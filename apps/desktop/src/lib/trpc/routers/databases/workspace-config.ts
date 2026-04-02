import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";

// Simple per-file async mutex to prevent concurrent read/modify/write races.
function createFileMutex() {
	let queue = Promise.resolve();
	return function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const next = queue.then(fn, fn);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
}
const withCredentialStoreLock = createFileMutex();
const withManualConnectionStoreLock = createFileMutex();

import {
	SUPERSET_HOME_DIR,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "main/lib/app-environment";
import { z } from "zod";
import { decrypt, encrypt } from "../auth/utils/crypto-storage";

const WORKSPACE_DATABASES_CONFIG_FILE = path.join(
	".superset",
	"databases.json",
);
const WORKSPACE_DATABASE_CREDENTIALS_FILE = path.join(
	SUPERSET_HOME_DIR,
	"workspace-database-credentials.enc",
);

const workspaceDatabaseBaseSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	group: z.string().trim().min(1).optional(),
});

const sqliteWorkspaceDatabaseSchema = workspaceDatabaseBaseSchema.extend({
	dialect: z.literal("sqlite"),
	path: z.string().min(1),
});

const postgresWorkspaceDatabaseSchema = workspaceDatabaseBaseSchema.extend({
	dialect: z.literal("postgres"),
	host: z.string().min(1),
	port: z.number().int().positive().max(65535).optional(),
	database: z.preprocess(
		(value) =>
			typeof value === "string" && value.trim().length === 0
				? undefined
				: value,
		z.string().min(1).default("postgres"),
	),
	ssl: z.boolean().optional(),
	username: z.string().min(1).optional(),
});

export const workspaceDatabaseDefinitionSchema = z.discriminatedUnion(
	"dialect",
	[sqliteWorkspaceDatabaseSchema, postgresWorkspaceDatabaseSchema],
);

const workspaceDatabaseConfigSchema = z.object({
	databases: z.array(workspaceDatabaseDefinitionSchema).default([]),
});

export const postgresConnectionSourceSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("connectionString"),
		connectionStringId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("workspaceConfig"),
		workspacePath: z.string().min(1),
		definitionId: z.string().min(1),
	}),
]);

const workspaceDatabaseCredentialEntrySchema = z.object({
	username: z.string().min(1),
	password: z.string(),
	updatedAt: z.number().int().nonnegative(),
});

const workspaceDatabaseCredentialStoreSchema = z.object({
	entries: z
		.record(z.string(), workspaceDatabaseCredentialEntrySchema)
		.default({}),
});

export type WorkspaceDatabaseDefinition = z.infer<
	typeof workspaceDatabaseDefinitionSchema
>;
export type WorkspaceConfiguredDatabaseDiscoveryItem =
	| {
			source: "config";
			dialect: "sqlite";
			definitionId: string;
			label: string;
			group?: string;
			absolutePath: string;
			relativePath: string;
	  }
	| {
			source: "config";
			dialect: "postgres";
			definitionId: string;
			label: string;
			group?: string;
			host: string;
			port: number;
			database: string;
			ssl: boolean;
			usernameHint?: string;
			relativePath: string;
			hasSavedCredentials: boolean;
	  };

function workspaceCredentialKey(
	workspacePath: string,
	definitionId: string,
): string {
	return `${workspacePath}::${definitionId}`;
}

function buildPostgresConnectionString(input: {
	host: string;
	port: number;
	username: string;
	password: string;
	database: string;
	ssl: boolean;
}): string {
	const auth =
		input.password.trim().length > 0
			? `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}`
			: encodeURIComponent(input.username);
	const query = input.ssl ? "?sslmode=require" : "";
	const trimmedHost = input.host.trim();
	const host =
		trimmedHost.startsWith("[") && trimmedHost.endsWith("]")
			? trimmedHost
			: trimmedHost.includes(":")
				? `[${trimmedHost}]`
				: trimmedHost;
	return `postgres://${auth}@${host}:${input.port}/${input.database}${query}`;
}

function getPostgresDatabaseName(
	definition: Extract<WorkspaceDatabaseDefinition, { dialect: "postgres" }>,
): string {
	return definition.database;
}

async function loadWorkspaceDatabaseCredentialStore(): Promise<
	z.infer<typeof workspaceDatabaseCredentialStoreSchema>
> {
	try {
		const decrypted = decrypt(
			await readFile(WORKSPACE_DATABASE_CREDENTIALS_FILE),
		);
		return workspaceDatabaseCredentialStoreSchema.parse(JSON.parse(decrypted));
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return { entries: {} };
		}
		throw error;
	}
}

async function saveWorkspaceDatabaseCredentialStore(
	store: z.infer<typeof workspaceDatabaseCredentialStoreSchema>,
): Promise<void> {
	await mkdir(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
	await writeFile(
		WORKSPACE_DATABASE_CREDENTIALS_FILE,
		encrypt(JSON.stringify(store)),
		{ mode: SUPERSET_SENSITIVE_FILE_MODE },
	);
	await chmod(
		WORKSPACE_DATABASE_CREDENTIALS_FILE,
		SUPERSET_SENSITIVE_FILE_MODE,
	).catch(() => undefined);
}

export async function loadWorkspaceDatabaseDefinitions(
	workspacePath: string,
): Promise<{
	configPath: string;
	definitions: WorkspaceDatabaseDefinition[];
}> {
	const configPath = path.join(workspacePath, WORKSPACE_DATABASES_CONFIG_FILE);

	try {
		const raw = await readFile(configPath, "utf8");
		const parsed = workspaceDatabaseConfigSchema.parse(JSON.parse(raw));
		return {
			configPath,
			definitions: parsed.databases,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return { configPath, definitions: [] };
		}

		if (error instanceof z.ZodError) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Invalid workspace database config: ${error.issues[0]?.message ?? "Unknown schema error"}`,
			});
		}

		if (error instanceof SyntaxError) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Invalid JSON in .superset/databases.json",
			});
		}

		throw error;
	}
}

function toWorkspaceConfigSqlitePath(
	workspacePath: string,
	databasePath: string,
): string {
	const absoluteDatabasePath = path.resolve(workspacePath, databasePath);
	const relativePath = path.relative(workspacePath, absoluteDatabasePath);

	if (
		relativePath.length > 0 &&
		!relativePath.startsWith("..") &&
		!path.isAbsolute(relativePath)
	) {
		return relativePath;
	}

	return absoluteDatabasePath;
}

async function writeWorkspaceDatabaseDefinitions(input: {
	configPath: string;
	config: Record<string, unknown>;
}): Promise<void> {
	await mkdir(path.dirname(input.configPath), { recursive: true });
	await writeFile(
		input.configPath,
		`${JSON.stringify(input.config, null, 2)}\n`,
		"utf8",
	);
}

export async function discoverWorkspaceConfiguredDatabases(
	workspacePath: string,
): Promise<WorkspaceConfiguredDatabaseDiscoveryItem[]> {
	const { definitions } = await loadWorkspaceDatabaseDefinitions(workspacePath);
	if (definitions.length === 0) {
		return [];
	}

	const credentialStore = await loadWorkspaceDatabaseCredentialStore();

	return definitions.map((definition) => {
		if (definition.dialect === "sqlite") {
			return {
				source: "config",
				dialect: "sqlite",
				definitionId: definition.id,
				label: definition.label,
				group: definition.group,
				absolutePath: path.resolve(workspacePath, definition.path),
				relativePath: path.join(
					WORKSPACE_DATABASES_CONFIG_FILE,
					`#${definition.id}`,
				),
			};
		}

		const key = workspaceCredentialKey(workspacePath, definition.id);
		return {
			source: "config",
			dialect: "postgres",
			definitionId: definition.id,
			label: definition.label,
			group: definition.group,
			host: definition.host,
			port: definition.port ?? 5432,
			database: getPostgresDatabaseName(definition),
			ssl: definition.ssl ?? false,
			usernameHint:
				definition.username ?? credentialStore.entries[key]?.username,
			relativePath: path.join(
				WORKSPACE_DATABASES_CONFIG_FILE,
				`#${definition.id}`,
			),
			hasSavedCredentials: Boolean(credentialStore.entries[key]),
		};
	});
}

export async function saveWorkspaceDatabaseCredentials(input: {
	workspacePath: string;
	definitionId: string;
	username: string;
	password: string;
}): Promise<void> {
	await withCredentialStoreLock(async () => {
		const store = await loadWorkspaceDatabaseCredentialStore();
		store.entries[
			workspaceCredentialKey(input.workspacePath, input.definitionId)
		] = {
			username: input.username.trim(),
			password: input.password,
			updatedAt: Date.now(),
		};
		await saveWorkspaceDatabaseCredentialStore(store);
	});
}

export async function updateWorkspaceDatabaseDefinition(input: {
	workspacePath: string;
	definitionId: string;
	definition:
		| {
				dialect: "sqlite";
				label: string;
				group?: string;
				databasePath: string;
		  }
		| {
				dialect: "postgres";
				label: string;
				group?: string;
				host: string;
				port: number;
				database?: string;
				ssl: boolean;
				username?: string;
		  };
}): Promise<WorkspaceDatabaseDefinition> {
	const { configPath, definitions } = await loadWorkspaceDatabaseDefinitions(
		input.workspacePath,
	);
	const definitionIndex = definitions.findIndex(
		(candidate) => candidate.id === input.definitionId,
	);

	if (definitionIndex === -1) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workspace database definition not found.",
		});
	}

	const currentDefinition = definitions[definitionIndex];
	const nextDefinition = workspaceDatabaseDefinitionSchema.parse(
		input.definition.dialect === "sqlite"
			? {
					id: input.definitionId,
					dialect: "sqlite",
					label: input.definition.label,
					group: input.definition.group,
					path: toWorkspaceConfigSqlitePath(
						input.workspacePath,
						input.definition.databasePath,
					),
				}
			: {
					id: input.definitionId,
					dialect: "postgres",
					label: input.definition.label,
					group: input.definition.group,
					host: input.definition.host,
					port: input.definition.port,
					database: input.definition.database,
					ssl: input.definition.ssl,
					username: input.definition.username,
				},
	);

	const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as {
		databases?: unknown[];
		[key: string]: unknown;
	};
	const rawDefinitions = Array.isArray(rawConfig.databases)
		? [...rawConfig.databases]
		: [];
	const currentRawDefinition =
		typeof rawDefinitions[definitionIndex] === "object" &&
		rawDefinitions[definitionIndex] !== null
			? (rawDefinitions[definitionIndex] as Record<string, unknown>)
			: {};

	const nextRawDefinition: Record<string, unknown> =
		nextDefinition.dialect === "sqlite"
			? {
					...currentRawDefinition,
					id: nextDefinition.id,
					label: nextDefinition.label,
					dialect: "sqlite",
					path: nextDefinition.path,
				}
			: {
					...currentRawDefinition,
					id: nextDefinition.id,
					label: nextDefinition.label,
					dialect: "postgres",
					host: nextDefinition.host,
					port: nextDefinition.port,
					database: nextDefinition.database,
					ssl: nextDefinition.ssl,
					username: nextDefinition.username,
				};

	if (nextDefinition.group) {
		nextRawDefinition.group = nextDefinition.group;
	} else {
		delete nextRawDefinition.group;
	}

	if (nextDefinition.dialect === "postgres") {
		delete nextRawDefinition.path;
		if (!nextDefinition.username) {
			delete nextRawDefinition.username;
		}
	} else {
		delete nextRawDefinition.host;
		delete nextRawDefinition.port;
		delete nextRawDefinition.database;
		delete nextRawDefinition.ssl;
		delete nextRawDefinition.username;
	}

	rawDefinitions[definitionIndex] = nextRawDefinition;
	await writeWorkspaceDatabaseDefinitions({
		configPath,
		config: {
			...rawConfig,
			databases: rawDefinitions,
		},
	});

	if (
		currentDefinition.dialect === "postgres" &&
		nextDefinition.dialect === "postgres" &&
		nextDefinition.username
	) {
		await withCredentialStoreLock(async () => {
			const store = await loadWorkspaceDatabaseCredentialStore();
			const credentialKey = workspaceCredentialKey(
				input.workspacePath,
				input.definitionId,
			);
			const existingCredentials = store.entries[credentialKey];
			if (existingCredentials) {
				store.entries[credentialKey] = {
					...existingCredentials,
					username:
						nextDefinition.username ?? existingCredentials.username,
					updatedAt: Date.now(),
				};
				await saveWorkspaceDatabaseCredentialStore(store);
			}
		});
	}

	return nextDefinition;
}

const manualPostgresConnectionStoreSchema = z.object({
	entries: z
		.record(
			z.string(),
			z.object({
				connectionString: z.string().min(1),
				updatedAt: z.number().int().nonnegative(),
			}),
		)
		.default({}),
});

const MANUAL_POSTGRES_CONNECTIONS_FILE = path.join(
	SUPERSET_HOME_DIR,
	"manual-postgres-connections.enc",
);

async function loadManualPostgresConnectionStore(): Promise<
	z.infer<typeof manualPostgresConnectionStoreSchema>
> {
	try {
		const decrypted = decrypt(await readFile(MANUAL_POSTGRES_CONNECTIONS_FILE));
		return manualPostgresConnectionStoreSchema.parse(JSON.parse(decrypted));
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return { entries: {} };
		}
		throw error;
	}
}

async function saveManualPostgresConnectionStore(
	store: z.infer<typeof manualPostgresConnectionStoreSchema>,
): Promise<void> {
	await mkdir(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
	await writeFile(
		MANUAL_POSTGRES_CONNECTIONS_FILE,
		encrypt(JSON.stringify(store)),
		{ mode: SUPERSET_SENSITIVE_FILE_MODE },
	);
	await chmod(
		MANUAL_POSTGRES_CONNECTIONS_FILE,
		SUPERSET_SENSITIVE_FILE_MODE,
	).catch(() => undefined);
}

export async function saveManualPostgresConnectionString(
	connectionId: string,
	connectionString: string,
): Promise<void> {
	await withManualConnectionStoreLock(async () => {
		const store = await loadManualPostgresConnectionStore();
		store.entries[connectionId] = {
			connectionString,
			updatedAt: Date.now(),
		};
		await saveManualPostgresConnectionStore(store);
	});
}

export async function getManualPostgresConnectionString(
	connectionId: string,
): Promise<string | null> {
	const store = await loadManualPostgresConnectionStore();
	return store.entries[connectionId]?.connectionString ?? null;
}

export async function deleteManualPostgresConnectionString(
	connectionId: string,
): Promise<void> {
	await withManualConnectionStoreLock(async () => {
		const store = await loadManualPostgresConnectionStore();
		delete store.entries[connectionId];
		await saveManualPostgresConnectionStore(store);
	});
}

export async function resolvePostgresConnectionStringFromSource(input: {
	source: z.infer<typeof postgresConnectionSourceSchema>;
}): Promise<string> {
	const source = input.source;
	if (source.kind === "connectionString") {
		const connectionString = await getManualPostgresConnectionString(
			source.connectionStringId,
		);
		if (!connectionString) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Manual Postgres connection string not found.",
			});
		}
		return connectionString;
	}

	const { definitions } = await loadWorkspaceDatabaseDefinitions(
		source.workspacePath,
	);
	const definition = definitions.find(
		(candidate) => candidate.id === source.definitionId,
	);

	if (!definition || definition.dialect !== "postgres") {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workspace database definition not found.",
		});
	}

	const credentialStore = await loadWorkspaceDatabaseCredentialStore();
	const credentials =
		credentialStore.entries[
			workspaceCredentialKey(source.workspacePath, source.definitionId)
		];

	if (!credentials) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Credentials for this workspace database have not been saved yet.",
		});
	}

	return buildPostgresConnectionString({
		host: definition.host,
		port: definition.port ?? 5432,
		username: credentials.username,
		password: credentials.password,
		database: getPostgresDatabaseName(definition),
		ssl: definition.ssl ?? false,
	});
}
