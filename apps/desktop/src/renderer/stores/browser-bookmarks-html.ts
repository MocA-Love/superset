import type {
	BrowserBookmark,
	BrowserBookmarkFolder,
	BrowserBookmarkTreeNode,
} from "./browser-bookmarks";
import { isBrowserBookmark, normalizeBookmarkUrl } from "./browser-bookmarks";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function buildBookmarkHtml(node: BrowserBookmarkTreeNode, depth = 1): string {
	const indent = "    ".repeat(depth);

	if (isBrowserBookmark(node)) {
		const parts = [
			`${indent}<DT><A HREF="${escapeHtml(node.url)}"`,
			` ADD_DATE="${Math.floor(node.createdAt / 1000)}"`,
		];

		if (node.faviconUrl) {
			parts.push(` ICON="${escapeHtml(node.faviconUrl)}"`);
		}

		parts.push(`>${escapeHtml(node.title || node.url)}</A>\n`);
		return parts.join("");
	}

	const title = node.title.trim() || "Untitled Folder";
	return [
		`${indent}<DT><H3 ADD_DATE="${Math.floor(node.createdAt / 1000)}">${escapeHtml(title)}</H3>\n`,
		`${indent}<DL><p>\n`,
		...node.children.map((child) => buildBookmarkHtml(child, depth + 1)),
		`${indent}</DL><p>\n`,
	].join("");
}

function parseTimestamp(value: string | null): number {
	if (!value) return Date.now();
	const unixSeconds = Number(value);
	return Number.isFinite(unixSeconds) ? unixSeconds * 1000 : Date.now();
}

function parseBookmarkAnchor(
	anchor: HTMLAnchorElement,
): BrowserBookmark | null {
	const href = normalizeBookmarkUrl(anchor.getAttribute("href") ?? "");
	if (!href || href === "about:blank") {
		return null;
	}

	return {
		id: crypto.randomUUID(),
		type: "bookmark",
		url: href,
		title: anchor.textContent?.trim() || href,
		faviconUrl: anchor.getAttribute("icon") ?? undefined,
		createdAt: parseTimestamp(anchor.getAttribute("add_date")),
	};
}

function parseElementFragment<T extends Element>(
	parser: DOMParser,
	html: string,
	selector: string,
): T | null {
	const document = parser.parseFromString(html, "text/html");
	const element = document.body.firstElementChild;
	if (!element?.matches(selector)) {
		return null;
	}
	return element as T;
}

function parseFolderHeading(
	parser: DOMParser,
	html: string,
): BrowserBookmarkFolder | null {
	const heading = parseElementFragment<HTMLHeadingElement>(
		parser,
		html,
		"h1, h2, h3, h4, h5, h6",
	);
	if (!heading) {
		return null;
	}

	return {
		id: crypto.randomUUID(),
		type: "folder",
		title: heading.textContent?.trim() || "Untitled Folder",
		createdAt: parseTimestamp(heading.getAttribute("add_date")),
		children: [],
	};
}

function parseBookmarkListFromHtml(html: string): BrowserBookmarkTreeNode[] {
	const parser = new DOMParser();
	const nodes: BrowserBookmarkTreeNode[] = [];
	const listStack: BrowserBookmarkTreeNode[][] = [];
	let pendingFolder: BrowserBookmarkFolder | null = null;

	// Netscape bookmark exports commonly omit closing </DT> tags, so we parse the
	// raw token stream instead of relying on the browser's repaired DOM tree shape.
	const tokenPattern =
		/<a\b[^>]*>[\s\S]*?<\/a\s*>|<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>|<\/?dl\b[^>]*>|<\/?dt\b[^>]*>/gi;

	for (const match of html.matchAll(tokenPattern)) {
		const token = match[0];
		if (!token) continue;

		if (/^<dl\b/i.test(token)) {
			if (listStack.length === 0) {
				listStack.push(nodes);
				pendingFolder = null;
				continue;
			}

			if (pendingFolder) {
				listStack.push(pendingFolder.children);
				pendingFolder = null;
				continue;
			}

			listStack.push(listStack[listStack.length - 1] ?? nodes);
			continue;
		}

		if (/^<\/dl\b/i.test(token)) {
			pendingFolder = null;
			if (listStack.length > 0) {
				listStack.pop();
			}
			continue;
		}

		if (listStack.length === 0) {
			continue;
		}

		if (/^<h[1-6]\b/i.test(token)) {
			const folder = parseFolderHeading(parser, token);
			if (!folder) {
				pendingFolder = null;
				continue;
			}

			const currentList = listStack[listStack.length - 1];
			if (!currentList) {
				pendingFolder = null;
				continue;
			}

			currentList.push(folder);
			pendingFolder = folder;
			continue;
		}

		if (/^<a\b/i.test(token)) {
			const anchor = parseElementFragment<HTMLAnchorElement>(
				parser,
				token,
				"a",
			);
			const bookmark = anchor ? parseBookmarkAnchor(anchor) : null;
			if (bookmark) {
				const currentList = listStack[listStack.length - 1];
				currentList?.push(bookmark);
			}
			pendingFolder = null;
		}
	}

	return nodes;
}

export function exportBrowserBookmarksToHtml(
	nodes: BrowserBookmarkTreeNode[],
): string {
	return [
		"<!DOCTYPE NETSCAPE-Bookmark-file-1>",
		'<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
		"<TITLE>Bookmarks</TITLE>",
		"<H1>Bookmarks</H1>",
		"<DL><p>",
		...nodes.map((node) => buildBookmarkHtml(node)),
		"</DL><p>",
		"",
	].join("\n");
}

export function importBrowserBookmarksFromHtml(
	html: string,
): BrowserBookmarkTreeNode[] {
	return parseBookmarkListFromHtml(html);
}
