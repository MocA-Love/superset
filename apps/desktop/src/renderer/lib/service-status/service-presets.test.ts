import { describe, expect, it } from "bun:test";
import type { ServiceStatusFormat } from "shared/service-status-types";
import {
	groupPresetsByCategory,
	normalizeApiUrl,
	PRESET_CATEGORY_ORDER,
	SERVICE_PRESETS,
} from "./service-presets";

function preset(slug: string) {
	const found = SERVICE_PRESETS.find((item) => item.slug === slug);
	expect(found).toBeDefined();
	return found;
}

describe("service status presets", () => {
	it("keeps every preset uniquely identifiable and safe to fetch", () => {
		const slugs = new Set<string>();
		const urls = new Set<string>();

		for (const item of SERVICE_PRESETS) {
			expect(item.slug).toBeTruthy();
			expect(slugs.has(item.slug)).toBe(false);
			slugs.add(item.slug);
			expect(item.label).toBeTruthy();
			expect(PRESET_CATEGORY_ORDER).toContain(item.category);
			expect(item.statusUrl.startsWith("https://")).toBe(true);
			expect(item.apiUrl.startsWith("https://")).toBe(true);
			expect(urls.has(normalizeApiUrl(item.apiUrl))).toBe(false);
			urls.add(normalizeApiUrl(item.apiUrl));

			if (item.iconType === "simple-icon") {
				expect(item.iconValue).toBeTruthy();
			}
		}
	});

	it("pins non-Statuspage providers to their dedicated parser formats", () => {
		const expectedFormats: Record<string, ServiceStatusFormat> = {
			aws: "aws-health",
			gcp: "gcp-incidents",
			azure: "azure-rss",
			gitlab: "status-io",
			"docker-hub": "status-io",
			perplexity: "instatus-summary",
			slack: "slack-v2",
		};

		for (const [slug, format] of Object.entries(expectedFormats)) {
			expect(preset(slug)?.format).toBe(format);
		}
	});

	it("normalizes API URLs for duplicate detection without dropping query strings", () => {
		expect(
			normalizeApiUrl("HTTPS://Status.Example.COM:443/api/v2/status.json/"),
		).toBe("https://status.example.com/api/v2/status.json");
		expect(
			normalizeApiUrl("https://status.example.com/api?component=api"),
		).toBe("https://status.example.com/api?component=api");
		expect(normalizeApiUrl("not a url")).toBe("not a url");
	});

	it("groups presets by the configured category order", () => {
		const grouped = groupPresetsByCategory();

		expect(grouped.length).toBeGreaterThan(0);
		expect(grouped.map((item) => item.category)).toEqual(
			PRESET_CATEGORY_ORDER.filter((category) =>
				SERVICE_PRESETS.some((preset) => preset.category === category),
			),
		);
		expect(grouped.every((item) => item.items.length > 0)).toBe(true);
	});
});
