export interface ApiAuthProvider {
	getHeaders(): Promise<Record<string, string>>;
	/**
	 * Drop cached credentials so the next `getHeaders()` call re-derives them
	 * from the underlying source. Cloud clients call this on 401 to recover
	 * from stale JWT/session state.
	 */
	invalidateCache(): void;
}
