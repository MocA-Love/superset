import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "lib/trpc/routers";
import { createContext } from "react";

const electronTrpcReactContext = createContext<unknown>(null);

/**
 * tRPC React client for Electron IPC communication with main process.
 * For desktop-specific operations: workspaces, terminal, auth, etc.
 */
export const electronTrpc = createTRPCReact<AppRouter>({
	abortOnUnmount: true,
	context: electronTrpcReactContext,
});

export type ElectronRouterOutputs = inferRouterOutputs<AppRouter>;
