import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeClient } from "../transport/bridge-client.js";

interface NavigateResponse {
	paneId: string;
	url: string;
}

interface ScreenshotResponse {
	paneId: string;
	base64: string;
	mimeType: string;
}

interface EvaluateResponse {
	paneId: string;
	value: unknown;
	exceptionDetails?: string;
}

interface ConsoleLogsResponse {
	paneId: string;
	entries: Array<{ level: string; message: string; at: number }>;
}

interface BindingResponse {
	bound: boolean;
	paneId: string | null;
	sessionId: string | null;
	url: string | null;
	title: string | null;
}

export function registerTools(server: McpServer, client: BridgeClient): void {
	server.registerTool(
		"get_connected_pane",
		{
			title: "Get connected browser pane",
			description:
				"Return the currently bound browser pane for this Claude session. Reports whether a pane is bound, its URL and title.",
			inputSchema: {},
		},
		async () => {
			const data = await client.request<BindingResponse>("GET", "/mcp/binding");
			return {
				content: [
					{
						type: "text",
						text: data.bound
							? `Bound to pane ${data.paneId} (${data.url ?? "blank"}): ${data.title ?? ""}`
							: "No browser pane is bound to this Claude session. Open the Connect dialog in the Superset UI to pick one.",
					},
				],
			};
		},
	);

	server.registerTool(
		"navigate",
		{
			title: "Navigate the bound browser pane",
			description:
				"Navigate the browser pane that the user has bound to this Claude session to the given URL. The binding is managed in the Superset UI.",
			inputSchema: {
				url: z.string().describe("Absolute URL (must include scheme)"),
			},
		},
		async ({ url }) => {
			const data = await client.request<NavigateResponse>(
				"POST",
				"/mcp/navigate",
				{ url },
			);
			return {
				content: [
					{
						type: "text",
						text: `Navigated pane ${data.paneId} to ${data.url}`,
					},
				],
			};
		},
	);

	server.registerTool(
		"screenshot",
		{
			title: "Screenshot the bound browser pane",
			description:
				"Capture the currently visible viewport of the bound browser pane as a PNG.",
			inputSchema: {},
		},
		async () => {
			const data = await client.request<ScreenshotResponse>(
				"POST",
				"/mcp/screenshot",
				{},
			);
			return {
				content: [
					{
						type: "image",
						data: data.base64,
						mimeType: data.mimeType,
					},
				],
			};
		},
	);

	server.registerTool(
		"evaluate_js",
		{
			title: "Run JavaScript in the bound browser pane",
			description:
				"Execute a JavaScript expression in the bound browser pane and return the serialized result. The expression runs in the page, not in Node.",
			inputSchema: {
				code: z.string().describe("JavaScript expression to evaluate"),
			},
		},
		async ({ code }) => {
			const data = await client.request<EvaluateResponse>(
				"POST",
				"/mcp/evaluate",
				{ code },
			);
			if (data.exceptionDetails) {
				return {
					isError: true,
					content: [
						{ type: "text", text: `Exception: ${data.exceptionDetails}` },
					],
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(data.value, null, 2) }],
			};
		},
	);

	server.registerTool(
		"get_console_logs",
		{
			title: "Get buffered console logs from the bound browser pane",
			description:
				"Return recent console.log / warn / error output the bound pane has emitted since the last call.",
			inputSchema: {},
		},
		async () => {
			const data = await client.request<ConsoleLogsResponse>(
				"GET",
				"/mcp/console-logs",
			);
			if (data.entries.length === 0) {
				return {
					content: [{ type: "text", text: "(no console output buffered)" }],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: data.entries
							.map((e) => `[${e.level}] ${e.message}`)
							.join("\n"),
					},
				],
			};
		},
	);
}
