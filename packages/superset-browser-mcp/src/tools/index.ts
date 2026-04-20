import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "../transport/bridge-client.js";

interface BindingResponse {
	bound: boolean;
	paneId: string | null;
	sessionId: string | null;
	url: string | null;
	title: string | null;
}

interface CdpEndpointResponse {
	paneId: string;
	sessionId: string;
	targetId: string;
	cdpPort: number;
	httpBase: string;
	webSocketDebuggerUrl: string;
	url: string | null;
	title: string | null;
	filtered: boolean;
}

/**
 * This MCP is intentionally kept minimal. Browser automation primitives
 * (click / navigate / screenshot / DOM inspection) are delegated to
 * mature external CDP-speaking MCPs — chrome-devtools-mcp, browser-use,
 * playwright-mcp, etc. — connected to the bound pane via the filtered
 * CDP endpoint that `get_cdp_endpoint` returns. The two tools here are
 * the handoff: `get_cdp_endpoint` for the URL, `get_connected_pane` as
 * a metadata sanity check.
 */
export function registerTools(server: McpServer, client: BridgeClient): void {
	server.registerTool(
		"get_cdp_endpoint",
		{
			title: "Get CDP endpoint for the bound browser pane",
			description:
				"Return the Chrome DevTools Protocol (CDP) endpoint for the currently bound browser pane. Plug the returned `webSocketDebuggerUrl` (or `httpBase`) into any browser automation MCP that speaks CDP — chrome-devtools-mcp, browser-use, playwright-mcp, etc. — to drive the pane directly. The endpoint is proxied through a per-session filter so external tools only ever see the bound pane; sibling panes / devtools / the workspace shell stay hidden.",
			inputSchema: {},
		},
		async () => {
			const data = await client.request<CdpEndpointResponse>(
				"GET",
				"/mcp/cdp-endpoint",
			);
			const summary = [
				`CDP endpoint for pane ${data.paneId} (target ${data.targetId}):`,
				`  wsEndpoint : ${data.webSocketDebuggerUrl}`,
				`  httpBase   : ${data.httpBase}`,
				data.url ? `  current URL: ${data.url}` : undefined,
				data.title ? `  title      : ${data.title}` : undefined,
				data.filtered
					? "  Endpoint is pane-filtered: only this pane is visible to the CDP client."
					: "  NOTE: This endpoint exposes the full Chromium instance (filter proxy disabled).",
			]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text", text: summary }],
			};
		},
	);

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
