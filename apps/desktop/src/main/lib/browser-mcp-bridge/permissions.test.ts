import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "superset-browser-mcp-"));
const previousSupersetHomeDir = process.env.SUPERSET_HOME_DIR;
process.env.SUPERSET_HOME_DIR = testHome;

const { BUILTIN_PRESETS, checkMethodPermitted, isPrivilegedSchemeAllowed } =
	await import("./permissions");

if (previousSupersetHomeDir === undefined) {
	delete process.env.SUPERSET_HOME_DIR;
} else {
	process.env.SUPERSET_HOME_DIR = previousSupersetHomeDir;
}

afterAll(() => {
	rmSync(testHome, { recursive: true, force: true });
});

function presetToggles(id: string) {
	const preset = BUILTIN_PRESETS.find((item) => item.id === id);
	expect(preset).toBeDefined();
	return preset?.toggles ?? {};
}

describe("browser MCP permission presets", () => {
	it("keeps the secure preset locked down by default", () => {
		const toggles = presetToggles("builtin-secure");

		const cookieRead = checkMethodPermitted("Network.getCookies", toggles);
		expect(cookieRead.allowed).toBe(false);
		expect(cookieRead.togglesKey).toBe("cookieRead");
		expect(cookieRead.reason).toContain("Network.getCookies requires");
		expect(checkMethodPermitted("Debugger.resume", toggles)).toEqual({
			allowed: false,
			reason: "Debugger.resume requires the Debugger permission toggle.",
			togglesKey: "debugger",
		});
		expect(isPrivilegedSchemeAllowed(toggles)).toBe(false);
	});

	it("allows frontend-dev capabilities without enabling destructive browser controls", () => {
		const toggles = presetToggles("builtin-frontend-dev");

		expect(checkMethodPermitted("Network.getCookies", toggles)).toEqual({
			allowed: true,
		});
		expect(
			checkMethodPermitted("DOMStorage.setDOMStorageItem", toggles),
		).toEqual({
			allowed: true,
		});
		expect(checkMethodPermitted("Network.setCookie", toggles).allowed).toBe(
			false,
		);
		expect(
			checkMethodPermitted("Browser.grantPermissions", toggles).allowed,
		).toBe(false);
		expect(isPrivilegedSchemeAllowed(toggles)).toBe(false);
	});

	it("keeps pane lifecycle escape methods denied even in permissive mode", () => {
		const toggles = presetToggles("builtin-permissive");

		expect(
			checkMethodPermitted("Browser.setDownloadBehavior", toggles),
		).toEqual({
			allowed: true,
		});
		expect(isPrivilegedSchemeAllowed(toggles)).toBe(true);
		expect(checkMethodPermitted("Browser.close", toggles).allowed).toBe(false);
		expect(checkMethodPermitted("Page.close", toggles).allowed).toBe(false);
		expect(
			checkMethodPermitted("Target.createBrowserContext", toggles).allowed,
		).toBe(false);
	});

	it("allows ungated read-only CDP methods", () => {
		expect(checkMethodPermitted("Runtime.evaluate", {})).toEqual({
			allowed: true,
		});
		expect(checkMethodPermitted("Target.getBrowserContexts", {})).toEqual({
			allowed: true,
		});
	});
});
