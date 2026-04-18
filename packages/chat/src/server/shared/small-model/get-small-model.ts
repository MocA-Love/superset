import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createAuthStorage } from "mastracode";
import {
	type ClaudeCredentials,
	getCredentialsFromConfig as getAnthropicCredentialsFromConfig,
	getCredentialsFromKeychain as getAnthropicCredentialsFromKeychain,
	getAnthropicProviderOptions,
	isClaudeCredentialExpired,
} from "../../desktop/auth/anthropic";
import {
	getOpenAICredentialsFromAnySource,
	isOpenAICredentialExpired,
	type OpenAICredentials,
} from "../../desktop/auth/openai";
import { OPENAI_AUTH_PROVIDER_ID } from "../../desktop/auth/provider-ids";
import { parseAnthropicEnvText } from "../../desktop/chat-service/anthropic-env-config";

const ANTHROPIC_SMALL_MODEL_ID = "claude-haiku-4-5-20251001";
const OPENAI_API_SMALL_MODEL_ID = "gpt-4o-mini";
const OPENAI_CODEX_SMALL_MODEL_ID = "gpt-5.1-codex-mini";
const OPENAI_CODEX_API_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses";

export type SmallModelProviderId = "anthropic" | "openai";

export interface SmallModelCandidate {
	providerId: SmallModelProviderId;
	providerName: string;
	credentialKind: "apiKey" | "oauth";
	credentialSource: string;
	createModel: () => unknown;
}

/**
 * FORK NOTE: ported from upstream #3517's `getSmallModel()` but rebuilt
 * on top of fork's credential resolvers so it still honors:
 *   - Anthropic OAuth (claude-code-20250219 / oauth-2025-04-20 headers via
 *     getAnthropicProviderOptions — upstream lost this when it switched to
 *     apiKey-only resolution)
 *   - Anthropic managed env config (~/.superset/chat-anthropic-env.json
 *     with ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN; AUTH_TOKEN is
 *     routed through the OAuth header path, not apiKey)
 *   - OpenAI Codex OAuth (custom fetch that rewrites to the Codex
 *     backend endpoint and refreshes access tokens via mastracode)
 *   - OpenAI API key in mastracode AuthStorage's `openai-codex` slot
 *
 * Upstream's version collapsed credentials to apiKey-only. We keep the
 * simpler `getSmallModel()` export for upstream-compatible callers
 * (runtime.ts title generation) and add `getSmallModelCandidates()` so
 * the fork callSmallModel shim can iterate providers in order and
 * record attempts properly (restoring provider fallback behavior).
 */
function buildCandidates(): SmallModelCandidate[] {
	const candidates: SmallModelCandidate[] = [];

	const envApiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (envApiKey) {
		candidates.push({
			providerId: "anthropic",
			providerName: "Anthropic",
			credentialKind: "apiKey",
			credentialSource: "env:ANTHROPIC_API_KEY",
			createModel: () =>
				createAnthropic({ apiKey: envApiKey })(ANTHROPIC_SMALL_MODEL_ID),
		});
	}

	const anthropicStored = resolveAnthropicCredentialsSync();
	if (anthropicStored) {
		candidates.push({
			providerId: "anthropic",
			providerName: "Anthropic",
			credentialKind: anthropicStored.kind === "oauth" ? "oauth" : "apiKey",
			credentialSource: anthropicStored.source,
			createModel: () =>
				createAnthropic(getAnthropicProviderOptions(anthropicStored))(
					ANTHROPIC_SMALL_MODEL_ID,
				),
		});
	}

	const anthropicEnvConfigCred = resolveAnthropicEnvConfigCredential();
	if (anthropicEnvConfigCred) {
		candidates.push({
			providerId: "anthropic",
			providerName: "Anthropic",
			credentialKind:
				anthropicEnvConfigCred.kind === "oauth" ? "oauth" : "apiKey",
			credentialSource: anthropicEnvConfigCred.source,
			createModel: () =>
				createAnthropic(getAnthropicProviderOptions(anthropicEnvConfigCred))(
					ANTHROPIC_SMALL_MODEL_ID,
				),
		});
	}

	const envOpenAIKey = process.env.OPENAI_API_KEY?.trim();
	if (envOpenAIKey) {
		candidates.push({
			providerId: "openai",
			providerName: "OpenAI",
			credentialKind: "apiKey",
			credentialSource: "env:OPENAI_API_KEY",
			createModel: () =>
				createOpenAI({ apiKey: envOpenAIKey }).chat(OPENAI_API_SMALL_MODEL_ID),
		});
	}

	const openaiCreds = getOpenAICredentialsFromAnySource();
	if (openaiCreds && !isOpenAICredentialExpired(openaiCreds)) {
		candidates.push({
			providerId: "openai",
			providerName: "OpenAI",
			credentialKind: openaiCreds.kind === "oauth" ? "oauth" : "apiKey",
			credentialSource: openaiCreds.source,
			createModel: () =>
				openaiCreds.kind === "oauth"
					? createOpenAICodexOAuthModel(openaiCreds)
					: createOpenAI({ apiKey: openaiCreds.apiKey }).chat(
							OPENAI_API_SMALL_MODEL_ID,
						),
		});
	}

	return candidates;
}

export function getSmallModelCandidates(): SmallModelCandidate[] {
	return buildCandidates();
}

/**
 * Returns the first viable small-model AI-SDK LanguageModel or null.
 * Upstream-compatible surface for simple single-model callers
 * (runtime.ts title generation, ai-name.ts workspace naming).
 *
 * Iterates every candidate and returns the first one whose
 * `createModel()` does not throw, so a broken-but-listed credential
 * (e.g. stale cached account id) doesn't block the next provider.
 * Runtime-level failures (expired OAuth 401, rate limits) still need
 * to be handled by the caller — those surface when the returned
 * model is actually invoked, not when it's constructed.
 */
export function getSmallModel(): unknown | null {
	for (const candidate of buildCandidates()) {
		try {
			return candidate.createModel();
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

// ---- Anthropic credential resolution helpers -------------------------------

/**
 * Synchronous Anthropic credential resolver. Fork's
 * `getCredentialsFromAnySource` is async because it may kick a
 * mastracode token refresh. For the small-model candidate list we need
 * a sync decision, so we stick to synchronous sources (config file,
 * keychain, auth-storage main slot). If the resulting OAuth token is
 * actually expired, createAnthropic will 401 and the shim falls
 * through to the next candidate.
 */
function resolveAnthropicCredentialsSync(): ClaudeCredentials | null {
	// Walk the sync sources in priority order and return the first
	// non-expired credential. Unlike getCredentialsFromAnySource() we do
	// NOT fall back to a known-expired credential at the end — expired
	// OAuth tokens would poison buildCandidates() and block the later
	// env-config / OpenAI candidates, which matter for getSmallModel()'s
	// direct callers where we can't retry after a 401.
	const sources: Array<() => ClaudeCredentials | null> = [
		() => {
			try {
				return getAnthropicCredentialsFromConfig();
			} catch {
				return null;
			}
		},
		() => {
			try {
				return getAnthropicCredentialsFromKeychain();
			} catch {
				return null;
			}
		},
		() => resolveAnthropicFromStoreSync(),
	];
	for (const resolve of sources) {
		const credential = resolve();
		if (!credential) continue;
		if (!isClaudeCredentialExpired(credential)) return credential;
	}
	return null;
}

function resolveAnthropicFromStoreSync(): ClaudeCredentials | null {
	try {
		const storage = createAuthStorage();
		storage.reload();
		const raw = storage.get("anthropic");
		if (!raw || typeof raw !== "object") return null;
		const value = raw as Record<string, unknown>;
		if (
			value.type === "api_key" &&
			typeof value.key === "string" &&
			value.key.trim().length > 0
		) {
			return {
				apiKey: value.key.trim(),
				source: "auth-storage",
				kind: "apiKey",
			};
		}
		if (
			value.type === "oauth" &&
			typeof value.access === "string" &&
			value.access.trim().length > 0
		) {
			return {
				apiKey: value.access.trim(),
				source: "auth-storage",
				kind: "oauth",
				expiresAt:
					typeof value.expires === "number" ? value.expires : undefined,
			};
		}
	} catch {
		// Fall through to null.
	}
	return null;
}

function resolveAnthropicEnvConfigCredential(): ClaudeCredentials | null {
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
		if (apiKey) {
			// `source: "config"` keeps us inside fork's ClaudeCredentials
			// union; the actual display label comes from
			// SmallModelCandidate.credentialSource below.
			return { apiKey, source: "config", kind: "apiKey" };
		}
		const authToken = variables.ANTHROPIC_AUTH_TOKEN?.trim();
		if (authToken) {
			// FORK NOTE: AUTH_TOKEN must flow through the OAuth path
			// (authToken + anthropic-beta / x-app headers) — routing it
			// through `apiKey` was the original PR #313 regression.
			return { apiKey: authToken, source: "config", kind: "oauth" };
		}
	} catch {
		// Swallow — missing / malformed config falls back to other sources.
	}
	return null;
}

// ---- OpenAI Codex OAuth model ----------------------------------------------

function createOpenAICodexOAuthModel(credentials: OpenAICredentials) {
	const authStorage = createAuthStorage();
	const openAIAuthProviderId =
		credentials.providerId ?? OPENAI_AUTH_PROVIDER_ID;
	const oauthFetchImpl = async (
		url: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		authStorage.reload();
		const storedCredential = authStorage.get(openAIAuthProviderId);
		if (!storedCredential || storedCredential.type !== "oauth") {
			throw new Error("Not logged in to OpenAI Codex. Reconnect OpenAI.");
		}

		let accessToken = storedCredential.access;
		if (
			typeof storedCredential.expires === "number" &&
			Date.now() >= storedCredential.expires
		) {
			const refreshedToken = await authStorage.getApiKey(openAIAuthProviderId);
			if (!refreshedToken) {
				throw new Error(
					"Failed to refresh OpenAI Codex token. Please reconnect OpenAI.",
				);
			}
			accessToken = refreshedToken;
			authStorage.reload();
		}

		const refreshedCredential = authStorage.get(openAIAuthProviderId);
		const accountId =
			refreshedCredential &&
			typeof refreshedCredential === "object" &&
			"accountId" in refreshedCredential &&
			typeof refreshedCredential.accountId === "string" &&
			refreshedCredential.accountId.trim().length > 0
				? refreshedCredential.accountId.trim()
				: credentials.accountId?.trim() || undefined;

		// biome-ignore-start lint/suspicious/noExplicitAny: fetch signature varies across runtimes (bun vs. node vs. electron) and the cross-package typecheck context loses the DOM Request type overloads.
		const baseRequest = new Request(url as any, init as any);
		// biome-ignore-end lint/suspicious/noExplicitAny: matching pair
		const parsedUrl = new URL(baseRequest.url);
		const shouldRewrite =
			parsedUrl.pathname.includes("/v1/responses") ||
			parsedUrl.pathname.includes("/chat/completions");
		const outgoingRequest = new Request(
			shouldRewrite ? OPENAI_CODEX_API_ENDPOINT : baseRequest.url,
			baseRequest,
		);
		const headers = new Headers(outgoingRequest.headers);
		headers.delete("authorization");
		headers.set("Authorization", `Bearer ${accessToken}`);
		if (accountId) {
			headers.set("ChatGPT-Account-Id", accountId);
		}

		return fetch(
			new Request(outgoingRequest, {
				headers,
			}),
		);
	};
	const bunFetch = globalThis.fetch as typeof fetch & {
		preconnect?: typeof globalThis.fetch;
	};
	const oauthFetch = Object.assign(
		oauthFetchImpl,
		typeof bunFetch.preconnect === "function"
			? { preconnect: bunFetch.preconnect.bind(globalThis.fetch) }
			: {},
	) as typeof fetch;

	return createOpenAI({
		apiKey: "oauth-dummy-key",
		fetch: oauthFetch,
	}).responses(OPENAI_CODEX_SMALL_MODEL_ID);
}
