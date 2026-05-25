import { CLIError } from "@superset/cli-framework";
import { type ApiClient, createApiClient } from "./api-client";
import { readConfig, type SupersetConfig } from "./config";

export type AuthSource = "override" | "config" | "oauth";

export type ResolvedAuth = {
	config: SupersetConfig;
	api: ApiClient;
	bearer: string;
	authSource: AuthSource;
};

export async function resolveAuth(
	apiKeyOption: string | undefined,
): Promise<ResolvedAuth> {
	const config = readConfig();

	const overrideKey = apiKeyOption?.trim();
	let bearer: string;
	let authSource: AuthSource;

	if (overrideKey) {
		bearer = overrideKey;
		authSource = "override";
	} else if (config.apiKey?.trim()) {
		bearer = config.apiKey.trim();
		authSource = "config";
	} else if (config.auth) {
		if (config.auth.expiresAt < Date.now()) {
			throw new CLIError("Session expired", "Run: superset auth login");
		}
		bearer = config.auth.accessToken;
		authSource = "oauth";
	} else {
		throw new CLIError(
			"Not logged in",
			"Run: superset auth login (or set SUPERSET_API_KEY)",
		);
	}

	const api = createApiClient(config, {
		bearer,
		organizationId: config.organizationId,
	});
	return { config, api, bearer, authSource };
}
