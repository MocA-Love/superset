import { afterEach, describe, expect, it, mock } from "bun:test";

let jsonResponse: unknown;
let textResponse = "";

mock.module("./net-helpers", () => ({
	fetchJson: async () => jsonResponse,
	fetchText: async () => textResponse,
}));

const { fetchAwsHealth } = await import("./aws-health");
const { fetchAzureRss } = await import("./azure-rss");
const { fetchGcpIncidents } = await import("./gcp-incidents");
const { fetchInstatusSummary } = await import("./instatus-summary");
const { fetchSlackV2 } = await import("./slack-v2");
const { fetchStatusIo } = await import("./status-io");
const { fetchStatuspageV2 } = await import("./statuspage-v2");

const originalDateNow = Date.now;

afterEach(() => {
	jsonResponse = undefined;
	textResponse = "";
	Date.now = originalDateNow;
});

describe("service-status parsers", () => {
	it("keeps Statuspage v2 defaults conservative", async () => {
		jsonResponse = {
			status: {
				indicator: "none",
			},
		};

		await expect(
			fetchStatuspageV2("https://status.example/api"),
		).resolves.toEqual({
			indicator: "none",
			description: "全システム正常",
		});

		jsonResponse = {
			status: {
				indicator: "major",
			},
		};

		await expect(
			fetchStatuspageV2("https://status.example/api"),
		).resolves.toEqual({
			indicator: "major",
			description: "ステータス不明",
		});
	});

	it("maps AWS current events to the worst active status", async () => {
		jsonResponse = {
			current: [
				{ service_name: "Lambda", summary: "Elevated errors", status: "2" },
				{ service_name: "EC2", summary: "Unavailable", status: "3" },
			],
		};

		await expect(
			fetchAwsHealth("https://status.aws.amazon.com/data.json"),
		).resolves.toEqual({
			indicator: "major",
			description: "EC2: Unavailable",
		});

		jsonResponse = { current: [] };

		await expect(
			fetchAwsHealth("https://status.aws.amazon.com/data.json"),
		).resolves.toEqual({
			indicator: "none",
			description: "全システム正常",
		});
	});

	it("only treats explicit GCP end:null incidents as active", async () => {
		jsonResponse = [
			{
				external_desc: "Resolved incident without an end field",
				severity: "high",
			},
			{
				external_desc: "Cloud SQL disruption",
				severity: "medium",
				end: null,
			},
		];

		await expect(
			fetchGcpIncidents("https://status.cloud.google.com/incidents.json"),
		).resolves.toEqual({
			indicator: "minor",
			description: "Cloud SQL disruption",
		});
	});

	it("maps Slack active incident severity to Statuspage indicators", async () => {
		jsonResponse = {
			status: "active",
			active_incidents: [
				{ title: "Notice only", type: "notice" },
				{ title: "Workspace outage", type: "outage" },
			],
		};

		await expect(
			fetchSlackV2("https://slack-status.example/current"),
		).resolves.toEqual({
			indicator: "critical",
			description: "Workspace outage (他 1 件)",
		});
	});

	it("parses Azure RSS without accepting unsafe XML declarations", async () => {
		Date.now = () => new Date("2026-04-21T12:00:00Z").getTime();
		textResponse = [
			"<rss><channel><item>",
			"<title><![CDATA[<b>Azure Portal</b> degraded]]></title>",
			"<pubDate>Tue, 21 Apr 2026 10:00:00 GMT</pubDate>",
			"</item></channel></rss>",
		].join("");

		await expect(
			fetchAzureRss("https://status.azure.com/feed"),
		).resolves.toEqual({
			indicator: "minor",
			description: "Azure Portal degraded",
		});

		textResponse = '<!DOCTYPE rss SYSTEM "file:///etc/passwd"><rss />';

		await expect(
			fetchAzureRss("https://status.azure.com/feed"),
		).resolves.toEqual({
			indicator: null,
			description: "DOCTYPE を含む RSS はサポートしていません",
		});
	});

	it("maps status.io and Instatus provider-specific status codes", async () => {
		jsonResponse = {
			result: {
				status_overall: {
					status_code: 600,
					status: "",
				},
			},
		};

		await expect(
			fetchStatusIo("https://status.example/status"),
		).resolves.toEqual({
			indicator: "critical",
			description: "セキュリティ事象",
		});

		jsonResponse = {
			page: {
				name: "Perplexity",
				status: "HASISSUES",
			},
		};

		await expect(
			fetchInstatusSummary("https://status.example/summary.json"),
		).resolves.toEqual({
			indicator: "major",
			description: "Perplexity で障害発生中",
		});
	});
});
