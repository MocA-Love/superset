import type { AppRouter } from "@superset/host-service/trpc";
import { createTRPCReact } from "@trpc/react-query";
import { createContext } from "react";

const workspaceTrpcReactContext = createContext<unknown>(null);

export const workspaceTrpc = createTRPCReact<AppRouter>({
	abortOnUnmount: true,
	context: workspaceTrpcReactContext,
});
