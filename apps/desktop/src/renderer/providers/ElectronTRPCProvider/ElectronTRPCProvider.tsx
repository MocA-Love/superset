import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { reportError } from "renderer/lib/report-error";
import { electronReactClient } from "../../lib/trpc-client";

// tRPC errors are already reported server-side by the `sentryMiddleware` in
// `src/lib/trpc/index.ts`, so don't report them again from the renderer.
function isTRPCError(error: unknown): boolean {
	return error instanceof TRPCClientError;
}

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

/**
 * Provider for Electron IPC tRPC client.
 * QueryClient is shared with router context for loader prefetching.
 */
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
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</electronTrpc.Provider>
	);
}

// Export for router context
export { queryClient as electronQueryClient };
