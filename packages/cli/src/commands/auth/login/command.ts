import * as p from "@clack/prompts";
import { CLIError, string } from "@superset/cli-framework";
import { render } from "ink";
import { createElement } from "react";
import { type ApiClient, createApiClient } from "../../../lib/api-client";
import { login } from "../../../lib/auth";
import { command } from "../../../lib/command";
import {
	getApiUrl,
	readConfig,
	type SupersetConfig,
	writeConfig,
} from "../../../lib/config";
import { copyToClipboard } from "./copyToClipboard";
import { LoginUI, type LoginUIProps } from "./LoginUI";

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
		const useInk =
			process.stdout.isTTY && process.stdin.isTTY && !process.env.CI;

		let pasteResolve: ((code: string) => void) | null = null;
		let pasteReject: ((err: Error) => void) | null = null;
		const pastePromise = new Promise<string>((resolve, reject) => {
			pasteResolve = resolve;
			pasteReject = reject;
		});

		let currentProps: LoginUIProps = {
			url: null,
			status: "starting",
			onSubmit: (code) => pasteResolve?.(code),
			onCancel: () => pasteReject?.(new CLIError("Login cancelled")),
			onCopy: async () => false,
		};

		const inkInstance = useInk
			? render(createElement(LoginUI, currentProps), { exitOnCtrlC: false })
			: null;

		const update = (patch: Partial<LoginUIProps>) => {
			currentProps = { ...currentProps, ...patch };
			inkInstance?.rerender(createElement(LoginUI, currentProps));
		};

		if (!inkInstance) {
			p.intro("superset auth login");
		}

		let result: Awaited<ReturnType<typeof login>> | null = null;
		let loginCancelled = false;
		try {
			result = await login(config, opts.signal, {
				onAuthorizationUrl: (url) => {
					if (inkInstance) {
						update({
							url,
							status: "waiting",
							onCopy: () => copyToClipboard(url),
						});
					} else {
						p.log.message("Browser didn't open? Use the url below to sign in");
						p.log.message(url);
					}
				},
				promptForPastedCode: async (signal) => {
					if (!inkInstance) {
						const pasted = await p.text({
							message: "Paste code here if prompted",
							validate: (value) =>
								value.includes("#") ? undefined : "Paste the entire value",
						});
						if (signal.aborted) return "";
						if (p.isCancel(pasted)) {
							throw new CLIError("Login cancelled");
						}
						return pasted;
					}
					const onAbort = () => pasteResolve?.("");
					signal.addEventListener("abort", onAbort);
					try {
						const code = await pastePromise;
						if (signal.aborted) return "";
						update({ status: "exchanging" });
						return code;
					} finally {
						signal.removeEventListener("abort", onAbort);
					}
				},
			});
			if (inkInstance) update({ status: "done" });
		} catch (err) {
			if (err instanceof CLIError && err.message === "Login cancelled") {
				loginCancelled = true;
			} else {
				throw err;
			}
		} finally {
			if (inkInstance) {
				inkInstance.unmount();
				await inkInstance.waitUntilExit().catch(() => {});
			}
		}

		if (loginCancelled || !result) {
			p.cancel("Login interrupted");
			return { data: { loggedIn: false, apiUrl } };
		}

		config.auth = {
			accessToken: result.accessToken,
			refreshToken: result.refreshToken,
			expiresAt: result.expiresAt,
		};
		delete config.apiKey;
		writeConfig(config);

		p.log.success("Authorized!");

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
