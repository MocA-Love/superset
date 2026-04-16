export interface AttachmentRef {
	/** The full markdown match including `![]` and the parens. */
	fullMatch: string;
	/** The alt text inside `![alt]` (often empty). */
	alt: string;
	/** Absolute path on disk. */
	path: string;
	/** Pretty filename to show in the chip (UUID prefix stripped). */
	name: string;
}

/**
 * Match `![alt](path)` markdown image references whose path lives under
 * the desktop app's `todo-agent/attachments/` directory. Both POSIX and
 * Windows path separators are accepted so the same regex works for
 * existing sessions saved on either platform.
 *
 * The path inside the parens is captured up to the next `)` so URL-style
 * encoded characters survive. Spaces are intentionally rejected — the
 * saveAttachment writer sanitizes filenames to `[^\w.-] -> _`, so a
 * raw space in the path would mean the reference is unrelated to our
 * attachment store and we should leave it alone.
 */
const ATTACHMENT_REF_RE =
	/!\[([^\]]*)\]\(([^()\s]*[/\\]todo-agent[/\\]attachments[/\\][^)\s]+)\)/g;

/** Strip the `<uuid>-` prefix that `saveAttachment` adds. */
function prettyAttachmentName(filename: string): string {
	const m =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i.exec(
			filename,
		);
	return m?.[1] ?? filename;
}

function basename(p: string): string {
	const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Pull every attachment reference out of a description/goal text. Order
 * is preserved so the chips line up with the order they appear in the
 * source text. Duplicates of the exact same path are collapsed to a
 * single chip.
 */
export function extractAttachmentRefs(text: string): AttachmentRef[] {
	if (!text) return [];
	const seen = new Set<string>();
	const out: AttachmentRef[] = [];
	for (const m of text.matchAll(ATTACHMENT_REF_RE)) {
		const fullMatch = m[0];
		const alt = m[1] ?? "";
		const p = m[2];
		if (!p || seen.has(p)) continue;
		seen.add(p);
		out.push({
			fullMatch,
			alt,
			path: p,
			name: prettyAttachmentName(basename(p)),
		});
	}
	return out;
}

/**
 * Return the body text with attachment markdown references removed so
 * the user is not staring at long file paths inline. Adjacent blank
 * lines created by the removal are collapsed.
 */
export function stripAttachmentRefs(text: string): string {
	if (!text) return text;
	const stripped = text.replace(ATTACHMENT_REF_RE, "");
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}
