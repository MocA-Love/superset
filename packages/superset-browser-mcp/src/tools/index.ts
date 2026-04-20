import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "../transport/bridge-client.js";

interface BindingResponse {
	bound: boolean;
	paneId: string | null;
	sessionId: string | null;
	url: string | null;
	title: string | null;
}

/**
 * This MCP is intentionally kept minimal. The plan (see ./plan.md in
 * the repo root) is to expose the bound pane as a filtered CDP endpoint
 * so users can drive it with mature external browser MCPs
 * (chrome-devtools-mcp, browser-use, playwright-mcp). The tools here
 * are only the metadata shim LLMs need to verify the binding; the CDP
 * endpoint itself ships in follow-up PRs.
 */
export function registerTools(server: McpServer, client: BridgeClient): void {
	server.registerTool(
		"get_connected_pane",
		{
			title: "Get connected browser pane",
			description:
				"Return the currently bound browser pane for this LLM session (URL / title). Use this to confirm the UI-side binding before asking a browser-automation MCP (chrome-devtools-mcp / browser-use / etc.) to drive the pane.",
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
							: "No browser pane is bound to this LLM session. Open the Connect dialog in the Superset UI to pick one.",
					},
				],
			};
		},
	);
}
