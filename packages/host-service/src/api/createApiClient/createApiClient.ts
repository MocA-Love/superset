import { ORGANIZATION_HEADER } from "@superset/shared/constants";
import type { AppRouter } from "@superset/trpc";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { ApiAuthProvider } from "../../providers/auth";
import type { ApiClient } from "../../types";

export function createApiClient(
	baseUrl: string,
	authProvider: ApiAuthProvider,
	organizationId: string,
): ApiClient {
	return createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: `${baseUrl}/api/trpc`,
				transformer: SuperJSON,
				async headers() {
					// Pin every host→cloud request to this host's bound org. The
					// host's session-exchanged JWT (better-auth jwt plugin) only
					// carries `organizationIds`, not a singular active org, so
					// `protectedProcedure` would otherwise reject any call that
					// reads `ctx.activeOrganizationId`. The cloud middleware
					// validates membership before honoring this header.
					return {
						...(await authProvider.getHeaders()),
						[ORGANIZATION_HEADER]: organizationId,
					};
				},
			}),
		],
	});
}
