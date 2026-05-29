import { ORGANIZATION_HEADER } from "@superset/shared/constants";
import type { AppRouter } from "@superset/trpc";
import type { TRPCClient } from "@trpc/client";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import SuperJSON from "superjson";
import { getApiUrl, type SupersetConfig } from "./config";

export type ApiClient = TRPCClient<AppRouter>;

function isBetterAuthApiKey(token: string): boolean {
	return token.startsWith("sk_live_") || token.startsWith("sk_test_");
}

export function createApiClient(
	config: SupersetConfig,
	opts: { bearer: string; organizationId?: string },
): ApiClient {
	return createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: `${getApiUrl(config)}/api/trpc`,
				transformer: SuperJSON,
				headers() {
					const headers: Record<string, string> = isBetterAuthApiKey(
						opts.bearer,
					)
						? { "x-api-key": opts.bearer }
						: { Authorization: `Bearer ${opts.bearer}` };
					if (opts.organizationId) {
						headers[ORGANIZATION_HEADER] = opts.organizationId;
					}
					return headers;
				},
			}),
		],
	});
}
