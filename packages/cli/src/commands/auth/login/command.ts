import * as p from "@clack/prompts";
import { CLIError, string } from "@superset/cli-framework";
import { type ApiClient, createApiClient } from "../../../lib/api-client";
import { login } from "../../../lib/auth";
import { command } from "../../../lib/command";
import {
	getApiUrl,
	readConfig,
	type SupersetConfig,
	writeConfig,
} from "../../../lib/config";

type ChosenOrganization = { id: string; name: string };

function apiKeyFlagInArgv(): boolean {
	return process.argv.some(
		(arg) => arg === "--api-key" || arg.startsWith("--api-key="),
	);
}

async function pickOrganization({
	api,
	requested,
}: {
	api: ApiClient;
	requested: string | undefined;
}): Promise<{ chosen: ChosenOrganization | null; cancelled: boolean }> {
	const organizations = await api.user.myOrganizations.query();
	const sessionActive = await api.user.myOrganization.query();

	const explicitChoice = requested
		? organizations.find(
				(organization) =>
					organization.id === requested || organization.slug === requested,
			)
		: undefined;

	if (requested && !explicitChoice) {
		throw new CLIError(
			`Organization not found: ${requested}`,
			`Available: ${organizations.map((o) => o.slug).join(", ")}`,
		);
	}

	let chosen = explicitChoice ?? sessionActive ?? null;

	if (!chosen) {
		if (organizations.length === 1) {
			chosen = organizations[0] ?? null;
		} else if (organizations.length > 1) {
			if (!process.stdout.isTTY) {
				throw new CLIError(
					"Multiple organizations available; pass --organization <slug>",
					`Available: ${organizations.map((o) => o.slug).join(", ")}`,
				);
			}
			const selection = await p.select({
				message: "Select organization for this CLI",
				initialValue: organizations[0]?.id,
				options: organizations.map((organization) => ({
					value: organization.id,
					label: `${organization.name} (${organization.slug})`,
				})),
			});
			if (p.isCancel(selection)) {
				p.cancel("Login cancelled");
				return { chosen: null, cancelled: true };
			}
			chosen = organizations.find((o) => o.id === selection) ?? null;
		}
	}

	return {
		chosen: chosen ? { id: chosen.id, name: chosen.name } : null,
		cancelled: false,
	};
}

async function runApiKeyLogin({
	apiKey,
	config,
	requestedOrganization,
}: {
	apiKey: string;
	config: SupersetConfig;
	requestedOrganization: string | undefined;
}) {
	p.intro("superset auth login");

	const api = createApiClient(config, { bearer: apiKey });

	let user: Awaited<ReturnType<typeof api.user.me.query>>;
	try {
		user = await api.user.me.query();
		p.log.info(`${user.name} (${user.email})`);
	} catch (error) {
		throw new CLIError(
			"API key authentication failed",
			error instanceof Error ? error.message : String(error),
		);
	}

	const { chosen, cancelled } = await pickOrganization({
		api,
		requested: requestedOrganization,
	});
	if (cancelled) {
		return { data: { loggedIn: false } };
	}

	config.apiKey = apiKey;
	delete config.auth;
	if (chosen) {
		config.organizationId = chosen.id;
	}
	writeConfig(config);

	if (chosen) p.log.info(`Organization: ${chosen.name}`);
	p.outro("Logged in successfully.");

	return {
		data: chosen
			? {
					apiUrl: getApiUrl(config),
					userId: user.id,
					organizationId: chosen.id,
					organizationName: chosen.name,
				}
			: { apiUrl: getApiUrl(config), loggedIn: true },
	};
}

export default command({
	description: "Authenticate with Superset. Re-run to switch organizations.",
	skipMiddleware: true,
	options: {
		apiUrl: string().env("SUPERSET_API_URL").desc("Override API URL"),
		organization: string().desc("Organization id or slug to activate"),
	},
	run: async (opts) => {
		const options = opts.options as typeof opts.options & { apiKey?: string };
		const config = readConfig();
		if (options.apiUrl) config.apiUrl = options.apiUrl;
		const requestedOrganization = options.organization;
		const apiKeyExplicit = apiKeyFlagInArgv();
		const apiKeyFromCli = apiKeyExplicit ? options.apiKey?.trim() : undefined;

		if (apiKeyExplicit && !apiKeyFromCli) {
			throw new CLIError("Option --api-key requires a non-empty value");
		}

		if (apiKeyFromCli) {
			return runApiKeyLogin({
				apiKey: apiKeyFromCli,
				config,
				requestedOrganization,
			});
		}

		const apiUrl = getApiUrl(config);

		p.intro("superset auth login");

		// Clack's spinner redraws with ANSI cursor moves, which only works over a
		// real TTY. When stdout is piped (e.g. `bun run dev` → turbo → terminal)
		// every frame flushes as a new line, spamming the output.
		const spinner = process.stdout.isTTY ? p.spinner() : null;
		spinner?.start("Waiting for browser authorization...");
		if (!spinner) p.log.info("Waiting for browser authorization…");

		const result = await login(config, opts.signal);

		config.auth = {
			accessToken: result.accessToken,
			expiresAt: result.expiresAt,
		};
		delete config.apiKey;
		writeConfig(config);

		spinner?.stop("Authorized!");
		if (!spinner) p.log.success("Authorized!");

		const api = createApiClient(config, { bearer: result.accessToken });

		try {
			const user = await api.user.me.query();
			p.log.info(`${user.name} (${user.email})`);
		} catch (error) {
			p.log.warn(
				`Could not fetch user profile: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const { chosen, cancelled } = await pickOrganization({
			api,
			requested: requestedOrganization,
		});
		if (cancelled) {
			return { data: { apiUrl } };
		}

		if (chosen) {
			config.organizationId = chosen.id;
			writeConfig(config);
			p.log.info(`Organization: ${chosen.name}`);
		}

		p.outro("Logged in successfully.");
		return { data: { apiUrl } };
	},
});
