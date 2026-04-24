import { fetchText } from "./net-helpers";
import type { ParsedStatus } from "./types";

/**
 * Azure publishes incidents as a plain RSS 2.0 feed
 * (`status.azure.com/en-us/status/feed/` and mirrored CDN variants). The feed
 * doesn't expose a severity level, so we can only distinguish "has recent
 * incident" vs. "clean". Items in the past 24 h are treated as active; older
 * entries are historical noise.
 *
 * We intentionally avoid pulling in `fast-xml-parser` to keep the dependency
 * surface small — the feed is simple enough for a regex pass and the result
 * tolerates missing fields (CDATA / plain text both handled).
 */

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Accept namespace-prefixed element names (`<atom:item>`, `<rss:item>`) —
// the Azure feed has emitted prefixed variants before.
const ITEM_REGEX = /<(?:\w+:)?item\b[^>]*>([\s\S]*?)<\/(?:\w+:)?item>/gi;
const TITLE_REGEX =
	/<(?:\w+:)?title\b[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?title>/i;
const PUB_DATE_REGEX =
	/<(?:\w+:)?pubDate\b[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?pubDate>/i;
const DESCRIPTION_REGEX =
	/<(?:\w+:)?description\b[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?description>/i;
// DOCTYPE blocks can harbor external entity references; refuse any feed
// that advertises one rather than risk tripping an XXE path in some future
// parser swap.
const DOCTYPE_REGEX = /<!DOCTYPE\b/i;

interface RssItem {
	title: string;
	pubDate: string | null;
	description: string;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function parseRssItems(xml: string): RssItem[] {
	const items: RssItem[] = [];
	ITEM_REGEX.lastIndex = 0;
	for (
		let match = ITEM_REGEX.exec(xml);
		match !== null;
		match = ITEM_REGEX.exec(xml)
	) {
		const body = match[1] ?? "";
		const title = stripHtml(TITLE_REGEX.exec(body)?.[1] ?? "").slice(0, 180);
		const pubDate = PUB_DATE_REGEX.exec(body)?.[1]?.trim() ?? null;
		const description = stripHtml(
			DESCRIPTION_REGEX.exec(body)?.[1] ?? "",
		).slice(0, 240);
		items.push({ title, pubDate, description });
	}
	return items;
}

function isRecent(pubDate: string | null, nowMs: number): boolean {
	if (!pubDate) return false;
	const parsed = Date.parse(pubDate);
	if (Number.isNaN(parsed)) return false;
	return nowMs - parsed < ACTIVE_WINDOW_MS;
}

export async function fetchAzureRss(apiUrl: string): Promise<ParsedStatus> {
	const xml = await fetchText(apiUrl, {
		accept: "application/rss+xml, application/xml, text/xml;q=0.9",
	});
	if (DOCTYPE_REGEX.test(xml)) {
		return {
			indicator: null,
			description: "DOCTYPE を含む RSS はサポートしていません",
		};
	}
	const items = parseRssItems(xml);
	const nowMs = Date.now();
	const recent = items.filter((i) => isRecent(i.pubDate, nowMs));
	if (recent.length === 0) {
		return { indicator: "none", description: "直近のインシデントなし" };
	}
	const top = recent[0];
	return {
		indicator: "minor",
		description: top?.title || top?.description || "進行中インシデント",
	};
}
