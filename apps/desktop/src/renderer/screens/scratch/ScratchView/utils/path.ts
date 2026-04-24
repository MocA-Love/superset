export function basename(p: string): string {
	if (!p) return "";
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] ?? p;
}
