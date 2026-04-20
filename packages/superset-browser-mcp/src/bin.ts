#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { BridgeClient } from "./transport/bridge-client.js";

const server = new McpServer(
	{ name: "superset-browser", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);

// process.ppid is the PID of whatever spawned us — typically the Claude Code
// or Codex CLI. The Superset app uses that to figure out which running LLM
// session this MCP is serving.
const ppid =
	typeof process.ppid === "number" && process.ppid > 0
		? process.ppid
		: process.pid;

const client = new BridgeClient(ppid);

// Announce ourselves to Superset so it can bind PPID -> MCP. Failure is not
// fatal — tool calls will surface BridgeUnavailableError if the app never
// comes online.
client.request("POST", "/mcp/register", { ppid }).catch(() => {
	/* ignore — the first tool call will surface a clearer error */
});

registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
