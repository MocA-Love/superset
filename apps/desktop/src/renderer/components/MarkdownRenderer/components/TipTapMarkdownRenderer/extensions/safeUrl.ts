const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|data:text\/html)/i;

export function isSafeUrl(href: string | null | undefined): boolean {
	if (href === null || href === undefined || href === "") {
		return true;
	}
	return !DANGEROUS_SCHEME.test(href);
}

export function sanitizeUrl(href: string | null | undefined): string | null {
	if (href === null || href === undefined) {
		return null;
	}
	return isSafeUrl(href) ? href : null;
}
