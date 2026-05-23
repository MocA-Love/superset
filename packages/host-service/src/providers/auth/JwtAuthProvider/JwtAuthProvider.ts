import type { ApiAuthProvider } from "../types";

const JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const JWT_CACHE_DURATION_MS = 55 * 60 * 1000;

function looksLikeJwt(token: string): boolean {
	const parts = token.split(".");
	return parts.length === 3 && parts.every(Boolean);
}

export interface JwtApiAuthProviderOptions {
	/**
	 * Returns the current session/API-key/JWT token. Called whenever a fresh
	 * JWT is needed so re-login or refresh state can be picked up without
	 * restarting host-service.
	 */
	getSessionToken: () => Promise<string>;
	onInvalidateCache?: () => void;
	apiUrl: string;
}

export class JwtApiAuthProvider implements ApiAuthProvider {
	private readonly getSessionToken: () => Promise<string>;
	private readonly onInvalidateCache?: () => void;
	private readonly apiUrl: string;
	private cachedJwt: string | null = null;
	private cachedJwtExpiresAt = 0;

	constructor(options: JwtApiAuthProviderOptions) {
		this.getSessionToken = options.getSessionToken;
		this.onInvalidateCache = options.onInvalidateCache;
		this.apiUrl = options.apiUrl;
	}

	async getHeaders(): Promise<Record<string, string>> {
		const jwt = await this.getJwt();
		return { Authorization: `Bearer ${jwt}` };
	}

	invalidateCache(): void {
		this.cachedJwt = null;
		this.cachedJwtExpiresAt = 0;
		this.onInvalidateCache?.();
	}

	async getJwt(): Promise<string> {
		if (
			this.cachedJwt &&
			Date.now() < this.cachedJwtExpiresAt - JWT_REFRESH_BUFFER_MS
		) {
			return this.cachedJwt;
		}

		const sessionToken = await this.getSessionToken();
		if (looksLikeJwt(sessionToken)) {
			return sessionToken;
		}

		const response = await fetch(`${this.apiUrl}/api/auth/token`, {
			headers: sessionToken.startsWith("sk_live_")
				? { "x-api-key": sessionToken }
				: { Authorization: `Bearer ${sessionToken}` },
		});
		if (!response.ok) {
			throw new Error(`Failed to mint JWT: ${response.status}`);
		}
		const data = (await response.json()) as { token: string };
		this.cachedJwt = data.token;
		this.cachedJwtExpiresAt = Date.now() + JWT_CACHE_DURATION_MS;
		return data.token;
	}
}
