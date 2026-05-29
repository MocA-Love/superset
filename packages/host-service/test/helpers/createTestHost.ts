import { Database as BunDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import SuperJSON from "superjson";
import {
	type CreateAppOptions,
	type CreateAppResult,
	createApp,
} from "../../src/app";
import type { HostDb } from "../../src/db";
import * as schema from "../../src/db/schema";
import type { AppRouter as HostAppRouter } from "../../src/trpc/router";
import {
	createFakeApiClient,
	FakeApiAuthProvider,
	type FakeApiOverrides,
	FakeHostAuthProvider,
	FakeModelResolver,
	MemoryGitCredentialProvider,
} from "./fakes";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

export interface TestHostOptions {
	organizationId?: string;
	cloudApiUrl?: string;
	allowedOrigins?: string[];
	psk?: string;
	apiOverrides?: FakeApiOverrides;
	githubToken?: string | null;
	githubFactory?: () => Promise<unknown>;
	execGh?: (args: string[], options?: unknown) => Promise<unknown>;
	chatRuntime?: unknown;
	chatService?: unknown;
}

export interface TestHost {
	app: CreateAppResult["app"];
	api: CreateAppResult["api"];
	db: HostDb;
	dispose: () => Promise<void>;
	psk: string;
	dbPath: string;
	apiCalls: Array<{ path: string; input: unknown }>;
	setApi: (
		path: string,
		impl: (input: unknown) => unknown | Promise<unknown>,
	) => void;
	trpc: ReturnType<typeof createTRPCClient<HostAppRouter>>;
	unauthenticatedTrpc: ReturnType<typeof createTRPCClient<HostAppRouter>>;
	fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export async function createTestHost(
	options: TestHostOptions = {},
): Promise<TestHost> {
	const psk = options.psk ?? "test-psk-secret";
	const dataDir = mkdtempSync(join(tmpdir(), "host-service-test-db-"));
	const dbPath = join(dataDir, "host.db");

	const sqlite = new BunDatabase(dbPath, { create: true, readwrite: true });
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

	const fakeApi = createFakeApiClient(options.apiOverrides);

	const createOptions: CreateAppOptions = {
		config: {
			organizationId:
				options.organizationId ?? "00000000-0000-0000-0000-000000000001",
			dbPath,
			cloudApiUrl: options.cloudApiUrl ?? "http://localhost:0/cloud",
			migrationsFolder: MIGRATIONS_FOLDER,
			allowedOrigins: options.allowedOrigins ?? ["http://localhost:5173"],
		},
		providers: {
			auth: new FakeApiAuthProvider(),
			hostAuth: new FakeHostAuthProvider(psk),
			credentials: new MemoryGitCredentialProvider(options.githubToken ?? null),
			modelResolver: new FakeModelResolver(),
		},
		db: db as unknown as HostDb,
		api: fakeApi.client,
		github: options.githubFactory
			? (options.githubFactory as CreateAppOptions["github"])
			: undefined,
		execGh: options.execGh
			? (options.execGh as CreateAppOptions["execGh"])
			: async () => {
					throw new Error("execGh not configured in test");
				},
		chatRuntime: options.chatRuntime as CreateAppOptions["chatRuntime"],
		chatService: options.chatService as CreateAppOptions["chatService"],
	};

	const result = createApp(createOptions);

	const fetchApp = async (
		input: Request | string,
		init?: RequestInit,
	): Promise<Response> => {
		const request =
			typeof input === "string" ? new Request(input, init) : input;
		return result.app.fetch(request);
	};

	const buildClient = (authorized: boolean) =>
		createTRPCClient<HostAppRouter>({
			links: [
				httpBatchLink({
					url: "http://host-service.test/trpc",
					transformer: SuperJSON,
					fetch: async (url, init) => {
						return fetchApp(new Request(url as string, init as RequestInit));
					},
					headers: () => (authorized ? { authorization: `Bearer ${psk}` } : {}),
				}),
			],
		});

	const dispose = async (): Promise<void> => {
		try {
			await result.dispose();
		} finally {
			try {
				sqlite.close();
			} catch {
				// best-effort
			}
			try {
				rmSync(dataDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	};

	return {
		app: result.app,
		api: fakeApi.client,
		db: db as unknown as HostDb,
		dispose,
		psk,
		dbPath,
		apiCalls: fakeApi.calls,
		setApi: fakeApi.set,
		trpc: buildClient(true),
		unauthenticatedTrpc: buildClient(false),
		fetch: fetchApp,
	};
}
