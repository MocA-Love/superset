import type {
	BrowserBookmark,
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

function parseBookmarkList(list: Element | null): BrowserBookmarkTreeNode[] {
	if (!list) return [];

	const nodes: BrowserBookmarkTreeNode[] = [];
	for (const child of Array.from(list.children)) {
		if (child.tagName !== "DT") continue;

		const heading = Array.from(child.children).find((element) =>
			/^H[1-6]$/i.test(element.tagName),
		);
		if (heading) {
			const nestedList =
				child.nextElementSibling?.tagName === "DL"
					? child.nextElementSibling
					: null;
			nodes.push({
				id: crypto.randomUUID(),
				type: "folder",
				title: heading.textContent?.trim() || "Untitled Folder",
				createdAt: parseTimestamp(heading.getAttribute("add_date")),
				children: parseBookmarkList(nestedList),
			});
			continue;
		}

		const anchor = child.querySelector("a");
		if (!anchor) continue;
		const bookmark = parseBookmarkAnchor(anchor);
		if (bookmark) {
			nodes.push(bookmark);
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
	const parser = new DOMParser();
	const document = parser.parseFromString(html, "text/html");
	const rootList =
		document.querySelector("body > dl") ?? document.querySelector("dl");

	return parseBookmarkList(rootList);
}
