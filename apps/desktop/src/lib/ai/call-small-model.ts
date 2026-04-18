// FORK NOTE: upstream #3517 removed provider-diagnostics and the
// SmallModelProviders array based on per-attempt reporting — mastracode's
// AuthStorage is now the only credential source and getSmallModel() returns
// a single LanguageModel (Anthropic-then-OpenAI, API key only).
//
// Fork code (enhance-text.ts, git-operations.ts) still consumes the old
// callSmallModel({ invoke }) -> { result, attempts } shape. Rather than
// rewriting every callsite, expose a thin shim backed by the new
// getSmallModel() so the existing logging / error mapping keeps working.
//
// Trade-offs vs. upstream #3517:
// - OAuth-only users get no small-model service (upstream accepts this).
// - The attempts[] list collapses to a single entry (we don't try per-
//   provider anymore — getSmallModel() picks one and returns it).
import { getSmallModel } from "@superset/chat/server/shared";
import type { ProviderId, ProviderIssue } from "shared/ai/provider-status";

export type SmallModelCredentialKind = "api_key" | "oauth" | "env";
export interface SmallModelCredential {
	kind: SmallModelCredentialKind;
	source?: string;
}

export interface SmallModelAttempt {
	providerId: ProviderId;
	providerName: string;
	credentialKind?: SmallModelCredentialKind;
	credentialSource?: string;
	issue?: ProviderIssue;
	outcome:
		| "missing-credentials"
		| "expired-credentials"
		| "unsupported-credentials"
		| "empty-result"
		| "failed"
		| "succeeded";
	reason?: string;
}

export interface SmallModelInvocationContext {
	providerId: ProviderId;
	providerName: string;
	model: unknown;
	credentials: SmallModelCredential;
}

function providerNameFor(providerId: ProviderId): string {
	return providerId === "anthropic" ? "Anthropic" : "OpenAI";
}

// Mirror getSmallModel()'s resolution precedence so the synthesized
// attempt shows the provider that actually got used: Anthropic if env or
// mastracode auth.json carries an API key, else OpenAI, else fallback to
// Anthropic. We duplicate the path resolution rather than import
// getSmallModel internals because the store file path is stable
// (mastracode's CLI installs to the same OS-conventional dir).
function hasAnthropicAuthKey(): boolean {
	if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
	if (hasStoredApiKeyIn("anthropic")) return true;
	// FORK NOTE: match get-small-model.ts's read of
	// ~/.superset/chat-anthropic-env.json managed env config.
	return hasAnthropicEnvConfigKey();
}

function hasOpenAIAuthKey(): boolean {
	if (process.env.OPENAI_API_KEY?.trim()) return true;
	// FORK NOTE: fork stores OpenAI under the `openai-codex` slot; also
	// check the stock `openai` slot.
	if (hasStoredApiKeyIn("openai")) return true;
	return hasStoredApiKeyIn("openai-codex");
}

function hasAnthropicEnvConfigKey(): boolean {
	// Mirrors the same shape parseAnthropicEnvText in
	// packages/chat/src/server/desktop/chat-service/anthropic-env-config.ts
	// accepts: optional `export ` prefix, optional single/double quotes.
	// Whatever it can't parse, it falls back to false — the actual key
	// resolution lives in get-small-model.ts (which imports the real
	// parseAnthropicEnvText), so a miss here only degrades attempt-logging
	// labels, not small-model functionality.
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const os = require("node:os") as typeof import("node:os");
		const path = require("node:path") as typeof import("node:path");
		const supersetHome =
			process.env.SUPERSET_HOME_DIR?.trim() ||
			path.join(os.homedir(), ".superset");
		const configPath = path.join(supersetHome, "chat-anthropic-env.json");
		if (!fs.existsSync(configPath)) return false;
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			envText?: string;
		};
		if (typeof parsed.envText !== "string") return false;
		for (const line of parsed.envText.split("\n")) {
			const trimmed = line.trim().replace(/^export\s+/, "");
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (
				(key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") &&
				value.length > 0
			) {
				return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

function hasStoredApiKeyIn(providerId: string): boolean {
	try {
		// Lazy require so this never blocks in non-Node environments.
		const fs = require("node:fs") as typeof import("node:fs");
		const os = require("node:os") as typeof import("node:os");
		const path = require("node:path") as typeof import("node:path");
		const p = os.platform();
		let base: string;
		if (p === "darwin") {
			base = path.join(os.homedir(), "Library", "Application Support");
		} else if (p === "win32") {
			base =
				process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
		} else {
			base =
				process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
		}
		const authPath = path.join(base, "mastracode", "auth.json");
		if (!fs.existsSync(authPath)) return false;
		const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
			string,
			unknown
		>;
		const entry = data[`apikey:${providerId}`];
		return (
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			(entry as { type?: unknown }).type === "api_key" &&
			"key" in entry &&
			typeof (entry as { key?: unknown }).key === "string" &&
			(entry as { key: string }).key.trim().length > 0
		);
	} catch {
		return false;
	}
}

function detectProviderId(): ProviderId {
	if (hasAnthropicAuthKey()) return "anthropic";
	if (hasOpenAIAuthKey()) return "openai";
	return "anthropic";
}

export async function callSmallModel<TResult>({
	invoke,
}: {
	invoke: (
		context: SmallModelInvocationContext,
	) => Promise<TResult | null | undefined>;
	providerOrder?: ProviderId[];
}): Promise<{
	result: TResult | null;
	attempts: SmallModelAttempt[];
}> {
	const model = getSmallModel();
	if (!model) {
		return {
			result: null,
			attempts: [
				{
					providerId: "anthropic",
					providerName: providerNameFor("anthropic"),
					outcome: "missing-credentials",
				},
				{
					providerId: "openai",
					providerName: providerNameFor("openai"),
					outcome: "missing-credentials",
				},
			],
		};
	}

	const providerId = detectProviderId();
	const providerName = providerNameFor(providerId);
	const credentials: SmallModelCredential = { kind: "api_key" };

	try {
		const result = await invoke({
			providerId,
			providerName,
			model,
			credentials,
		});
		if (result === null || result === undefined) {
			return {
				result: null,
				attempts: [
					{
						providerId,
						providerName,
						credentialKind: "api_key",
						outcome: "empty-result",
					},
				],
			};
		}
		return {
			result,
			attempts: [
				{
					providerId,
					providerName,
					credentialKind: "api_key",
					outcome: "succeeded",
				},
			],
		};
	} catch (error) {
		return {
			result: null,
			attempts: [
				{
					providerId,
					providerName,
					credentialKind: "api_key",
					outcome: "failed",
					reason: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}
