import { settings } from "@superset/local-db";
import { localDb } from "../local-db";

const BASE_URL = "https://api.aivis-project.com";

export class AivisApiKeyMissingError extends Error {
	constructor() {
		super("Aivis API key is not configured");
		this.name = "AivisApiKeyMissingError";
	}
}

export class AivisApiError extends Error {
	constructor(
		readonly status: number,
		readonly bodyText: string,
	) {
		super(`Aivis API error ${status}: ${bodyText.slice(0, 300)}`);
		this.name = "AivisApiError";
	}
}

function readApiKey(): string | null {
	try {
		const row = localDb.select().from(settings).get();
		const key = row?.aivisApiKey?.trim();
		return key || null;
	} catch {
		return null;
	}
}

export interface AivisFetchInit extends Omit<RequestInit, "body"> {
	query?: Record<string, string | number | boolean | undefined>;
	json?: unknown;
	/** Override the stored API key (used for validation from a form). */
	apiKey?: string | null;
	/** If true, do not require an API key (for public endpoints like model search). */
	optionalAuth?: boolean;
}

/**
 * Authorized fetch wrapper for the Aivis Cloud API.
 * Throws AivisApiKeyMissingError if no key is configured, and AivisApiError
 * on non-2xx responses.
 */
export async function aivisFetch(
	path: string,
	init: AivisFetchInit = {},
): Promise<Response> {
	const key = init.apiKey ?? readApiKey();
	if (!key && !init.optionalAuth) throw new AivisApiKeyMissingError();

	const url = new URL(path, BASE_URL);
	for (const [k, v] of Object.entries(init.query ?? {})) {
		if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
		...(init.headers as Record<string, string> | undefined),
	};
	if (key) headers.Authorization = `Bearer ${key}`;

	let body: BodyInit | undefined;
	if (init.json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(init.json);
	}

	const res = await fetch(url, {
		...init,
		headers,
		body,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new AivisApiError(res.status, text);
	}

	return res;
}

export async function aivisJson<T>(
	path: string,
	init: AivisFetchInit = {},
): Promise<T> {
	const res = await aivisFetch(path, init);
	return (await res.json()) as T;
}
