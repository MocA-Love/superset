import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
	defaultShouldDehydrateQuery,
	MutationCache,
	QueryCache,
	QueryClient,
} from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { TRPCClientError } from "@trpc/client";
import { del, get, set } from "idb-keyval";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { reportError } from "renderer/lib/report-error";
import { electronReactClient } from "../../lib/trpc-client";

// tRPC errors are already reported server-side by the `sentryMiddleware` in
// `src/lib/trpc/index.ts`, so don't report them again from the renderer.
function isTRPCError(error: unknown): boolean {
	return error instanceof TRPCClientError;
}

// Bump when query response shapes change — invalidates the persisted cache.
const PERSIST_BUSTER = "v1";

// Shared QueryClient for tRPC hooks and router loaders
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			networkMode: "always",
			retry: false,
		},
		mutations: {
			networkMode: "always",
			retry: false,
		},
	},
	queryCache: new QueryCache({
		onError: (error, query) => {
			if (isTRPCError(error)) return;
			reportError(error, {
				severity: "error",
				tags: { subsystem: "react-query", kind: "query" },
				context: {
					queryKey: query.queryKey,
					queryHash: query.queryHash,
				},
			});
		},
	}),
	mutationCache: new MutationCache({
		onError: (error, _variables, _context, mutation) => {
			if (isTRPCError(error)) return;
			reportError(error, {
				severity: "error",
				tags: { subsystem: "react-query", kind: "mutation" },
				context: {
					mutationKey: mutation.options.mutationKey,
				},
			});
		},
	}),
});

// IndexedDB-backed persister. localStorage is too small (~5MB) for the
// volume of PR/issue rows we cache. idb-keyval uses a single object store
// keyed by the persister's `key` below.
const persister = createAsyncStoragePersister({
	storage: {
		getItem: async (key) => (await get<string>(key)) ?? null,
		setItem: async (key, value) => {
			await set(key, value);
		},
		removeItem: async (key) => {
			await del(key);
		},
	},
	key: "superset-rq-cache",
});

// Whitelist of queryKey prefixes worth persisting — anything else (auth
// tokens, ephemeral host state, transient mutations) is left in memory only.
const PERSIST_KEY_PREFIXES = new Set([
	"tasks", // PR/issue list infinite queries
	"pull-request-detail",
	"issue-detail",
]);

export function ElectronTRPCProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<electronTrpc.Provider
			client={electronReactClient}
			queryClient={queryClient}
		>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{
					persister,
					maxAge: 24 * 60 * 60 * 1000, // 24h
					buster: PERSIST_BUSTER,
					dehydrateOptions: {
						shouldDehydrateQuery: (query) => {
							if (!defaultShouldDehydrateQuery(query)) return false;
							const head = query.queryKey[0];
							return typeof head === "string" && PERSIST_KEY_PREFIXES.has(head);
						},
					},
				}}
			>
				{children}
			</PersistQueryClientProvider>
		</electronTrpc.Provider>
	);
}

// Export for router context
export { queryClient as electronQueryClient };
