import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { parseAnthropicEnvText } from "../../desktop/chat-service/anthropic-env-config";

const ANTHROPIC_SMALL_MODEL_ID = "claude-haiku-4-5-20251001";
const OPENAI_SMALL_MODEL_ID = "gpt-4o-mini";

/**
 * Resolves the mastracode auth.json path (same logic as mastracode's
 * `getAppDataDir`). We read it directly to avoid importing mastracode,
 * which eagerly loads @mastra/fastembed → onnxruntime-node (208 MB native
 * binary) and breaks electron-vite bundling.
 */
function getAuthJsonPath(): string {
	const p = platform();
	let base: string;
	if (p === "darwin") {
		base = join(homedir(), "Library", "Application Support");
	} else if (p === "win32") {
		base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	} else {
		base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	}
	return join(base, "mastracode", "auth.json");
}

type AuthData = Record<string, unknown>;

function readAuthData(): AuthData | null {
	const path = getAuthJsonPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AuthData;
	} catch {
		return null;
	}
}

function getStoredApiKey(
	authData: AuthData | null,
	providerId: string,
): string | null {
	if (!authData) return null;
	const entry = authData[`apikey:${providerId}`];
	if (
		typeof entry === "object" &&
		entry !== null &&
		"type" in entry &&
		entry.type === "api_key" &&
		"key" in entry &&
		typeof entry.key === "string" &&
		entry.key.trim().length > 0
	) {
		return entry.key.trim();
	}
	return null;
}

// FORK NOTE: fork stores the OpenAI provider under the Codex CLI slot
// name `openai-codex`, while upstream small-model looks at `openai`.
// Try both so Settings-saved keys route to small-model tasks too.
const OPENAI_STORAGE_SLOTS = ["openai", "openai-codex"];

function getStoredOpenAIApiKey(authData: AuthData | null): string | null {
	for (const slot of OPENAI_STORAGE_SLOTS) {
		const key = getStoredApiKey(authData, slot);
		if (key) return key;
	}
	return null;
}

// FORK NOTE: fork's ChatService persists ANTHROPIC_API_KEY /
// ANTHROPIC_AUTH_TOKEN into `~/.superset/chat-anthropic-env.json` as a
// managed env config (so a proxy setup can run) and *strips* those keys
// from process.env before launching the chat model. Read that file here
// so small-model tasks can reuse the same credential.
function getAnthropicKeyFromEnvConfig(): string | null {
	try {
		const supersetHome =
			process.env.SUPERSET_HOME_DIR?.trim() || join(homedir(), ".superset");
		const path = join(supersetHome, "chat-anthropic-env.json");
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			envText?: string;
		};
		if (typeof parsed.envText !== "string") return null;
		const variables = parseAnthropicEnvText(parsed.envText);
		const apiKey = variables.ANTHROPIC_API_KEY?.trim();
		if (apiKey) return apiKey;
		const authToken = variables.ANTHROPIC_AUTH_TOKEN?.trim();
		if (authToken) return authToken;
	} catch {
		// Swallow; missing / malformed config falls back to other sources.
	}
	return null;
}

function resolveAnthropicApiKey(authData: AuthData | null): string | null {
	const env = process.env.ANTHROPIC_API_KEY?.trim();
	if (env) return env;
	const stored = getStoredApiKey(authData, "anthropic");
	if (stored) return stored;
	return getAnthropicKeyFromEnvConfig();
}

function resolveOpenAIApiKey(authData: AuthData | null): string | null {
	const env = process.env.OPENAI_API_KEY?.trim();
	if (env) return env;
	return getStoredOpenAIApiKey(authData);
}

/**
 * Returns an AI-SDK `LanguageModel` for small-model tasks (branch naming,
 * title generation). Tries Anthropic first, falls back to OpenAI. Returns
 * `null` if no credentials are available.
 *
 * Reads credentials from env vars, mastracode's auth.json, and fork's
 * managed Anthropic env config. OAuth-only users fall back to `null`.
 */
export function getSmallModel(): unknown | null {
	const authData = readAuthData();

	const anthropicKey = resolveAnthropicApiKey(authData);
	if (anthropicKey) {
		return createAnthropic({ apiKey: anthropicKey })(ANTHROPIC_SMALL_MODEL_ID);
	}

	const openaiKey = resolveOpenAIApiKey(authData);
	if (openaiKey) {
		return createOpenAI({ apiKey: openaiKey }).chat(OPENAI_SMALL_MODEL_ID);
	}

	return null;
}
