import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMcpOverview } from "./mcp-overview";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "chat-mcp-overview-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("getMcpOverview", () => {
	it("returns empty list when no MCP config files are present", () => {
		const cwd = createTempDirectory();
		expect(getMcpOverview(cwd)).toEqual({
			sourcePath: null,
			servers: [],
		});
	});

	it("reads servers from .mcp.json and derives states", () => {
		const cwd = createTempDirectory();
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					remoteEnabled: {
						type: "http",
						url: "https://example.com/mcp",
					},
					localDisabled: {
						command: "bun",
						args: ["run", "mcp.ts"],
						disabled: true,
					},
					invalidServer: {
						enabled: true,
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "invalidServer",
				state: "invalid",
				transport: "unknown",
				target: "Not configured",
			},
			{
				name: "localDisabled",
				state: "disabled",
				transport: "local",
				target: "bun run mcp.ts",
			},
			{
				name: "remoteEnabled",
				state: "enabled",
				transport: "remote",
				target: "https://example.com/mcp",
			},
		]);
	});

	it("prefers .mastracode/mcp.json over .mcp.json", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".mastracode"), { recursive: true });
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					legacyRemote: {
						type: "http",
						url: "https://legacy.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(cwd, ".mastracode", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					mastraLocal: {
						command: "bun",
						args: ["run", "mcp.ts"],
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".mastracode", "mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "mastraLocal",
				state: "enabled",
				transport: "local",
				target: "bun run mcp.ts",
			},
		]);
	});

	it("reads servers from .amp/settings.json when present", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".amp"), { recursive: true });
		writeFileSync(
			join(cwd, ".amp", "settings.json"),
			JSON.stringify({
				"amp.mcpServers": {
					ampRemote: {
						url: "https://amp.example.com/mcp",
					},
					ampLocalDisabled: {
						command: "bun",
						args: ["run", "mcp.ts"],
						enabled: false,
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".amp", "settings.json"));
		expect(result.servers).toEqual([
			{
				name: "ampLocalDisabled",
				state: "disabled",
				transport: "local",
				target: "bun run mcp.ts",
			},
			{
				name: "ampRemote",
				state: "enabled",
				transport: "remote",
				target: "https://amp.example.com/mcp",
			},
		]);
	});

	it("reads servers from .cursor/mcp.json when present", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(
			join(cwd, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					cursorRemote: {
						url: "https://cursor.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".cursor", "mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "cursorRemote",
				state: "enabled",
				transport: "remote",
				target: "https://cursor.example.com/mcp",
			},
		]);
	});

	it("reads servers from .gemini/settings.json when present", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".gemini"), { recursive: true });
		writeFileSync(
			join(cwd, ".gemini", "settings.json"),
			JSON.stringify({
				mcpServers: {
					geminiRemote: {
						type: "http",
						httpUrl: "https://gemini.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".gemini", "settings.json"));
		expect(result.servers).toEqual([
			{
				name: "geminiRemote",
				state: "enabled",
				transport: "remote",
				target: "https://gemini.example.com/mcp",
			},
		]);
	});

	it("treats Gemini httpUrl as a remote target", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".gemini"), { recursive: true });
		writeFileSync(
			join(cwd, ".gemini", "settings.json"),
			JSON.stringify({
				mcpServers: {
					geminiHttpUrlOnly: {
						httpUrl: "https://gemini-http-url.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".gemini", "settings.json"));
		expect(result.servers).toEqual([
			{
				name: "geminiHttpUrlOnly",
				state: "enabled",
				transport: "remote",
				target: "https://gemini-http-url.example.com/mcp",
			},
		]);
	});

	it("reads servers from opencode.json when present", () => {
		const cwd = createTempDirectory();
		writeFileSync(
			join(cwd, "opencode.json"),
			JSON.stringify({
				mcp: {
					opencodeRemote: {
						type: "remote",
						url: "https://opencode.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, "opencode.json"));
		expect(result.servers).toEqual([
			{
				name: "opencodeRemote",
				state: "enabled",
				transport: "remote",
				target: "https://opencode.example.com/mcp",
			},
		]);
	});

	it("documents unsupported Codex global config by returning no project config", () => {
		const cwd = createTempDirectory();
		const result = getMcpOverview(cwd);
		expect(result).toEqual({
			sourcePath: null,
			servers: [],
		});
	});

	it("prefers .mcp.json over client-specific configs", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					sharedRemote: {
						url: "https://shared.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(cwd, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					cursorRemote: {
						url: "https://cursor.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "sharedRemote",
				state: "enabled",
				transport: "remote",
				target: "https://shared.example.com/mcp",
			},
		]);
	});

	it("prefers .mcp.json over .amp/settings.json", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".amp"), { recursive: true });
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					sharedRemote: {
						type: "http",
						url: "https://shared.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(cwd, ".amp", "settings.json"),
			JSON.stringify({
				"amp.mcpServers": {
					personalRemote: {
						url: "https://personal.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "sharedRemote",
				state: "enabled",
				transport: "remote",
				target: "https://shared.example.com/mcp",
			},
		]);
	});

	it("falls back to .mcp.json when .mastracode/mcp.json is invalid", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".mastracode"), { recursive: true });
		writeFileSync(join(cwd, ".mastracode", "mcp.json"), "{ invalid", "utf-8");
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fallbackRemote: {
						type: "http",
						url: "https://fallback.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "fallbackRemote",
				state: "enabled",
				transport: "remote",
				target: "https://fallback.example.com/mcp",
			},
		]);
	});

	it("falls back through client-specific configs when earlier files are invalid", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".cursor"), { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), "{ invalid", "utf-8");
		writeFileSync(
			join(cwd, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					cursorFallback: {
						url: "https://cursor.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".cursor", "mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "cursorFallback",
				state: "enabled",
				transport: "remote",
				target: "https://cursor.example.com/mcp",
			},
		]);
	});

	it("falls back to .mcp.json when .amp/settings.json is invalid", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".amp"), { recursive: true });
		writeFileSync(join(cwd, ".amp", "settings.json"), "{ invalid", "utf-8");
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fallbackRemote: {
						type: "http",
						url: "https://fallback.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".mcp.json"));
		expect(result.servers).toEqual([
			{
				name: "fallbackRemote",
				state: "enabled",
				transport: "remote",
				target: "https://fallback.example.com/mcp",
			},
		]);
	});

	it("falls back to .amp/settings.json when .mcp.json is invalid", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".amp"), { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), "{ invalid", "utf-8");
		writeFileSync(
			join(cwd, ".amp", "settings.json"),
			JSON.stringify({
				"amp.mcpServers": {
					ampFallback: {
						url: "https://amp.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".amp", "settings.json"));
		expect(result.servers).toEqual([
			{
				name: "ampFallback",
				state: "enabled",
				transport: "remote",
				target: "https://amp.example.com/mcp",
			},
		]);
	});

	it("falls back to opencode.json when earlier files are invalid", () => {
		const cwd = createTempDirectory();
		writeFileSync(join(cwd, ".mcp.json"), "{ invalid", "utf-8");
		writeFileSync(
			join(cwd, "opencode.json"),
			JSON.stringify({
				mcp: {
					opencodeFallback: {
						url: "https://opencode.example.com/mcp",
					},
				},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, "opencode.json"));
		expect(result.servers).toEqual([
			{
				name: "opencodeFallback",
				state: "enabled",
				transport: "remote",
				target: "https://opencode.example.com/mcp",
			},
		]);
	});

	it("returns first existing path with empty servers when config shape is unsupported", () => {
		const cwd = createTempDirectory();
		mkdirSync(join(cwd, ".gemini"), { recursive: true });
		writeFileSync(
			join(cwd, ".gemini", "settings.json"),
			JSON.stringify({
				notMcpServers: {},
			}),
			"utf-8",
		);

		const result = getMcpOverview(cwd);
		expect(result.sourcePath).toBe(join(cwd, ".gemini", "settings.json"));
		expect(result.servers).toEqual([]);
	});
});
