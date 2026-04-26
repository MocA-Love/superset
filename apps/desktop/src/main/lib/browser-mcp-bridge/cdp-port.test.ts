import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let userDataDir = "";

mock.module("electron", () => ({
	app: {
		getPath: (name: string) => {
			if (name !== "userData") {
				throw new Error(`Unexpected app path lookup: ${name}`);
			}
			return userDataDir;
		},
	},
}));

const { resolveCdpPort } = await import("./cdp-port");

const previousAutomationPort = process.env.DESKTOP_AUTOMATION_PORT;

beforeEach(() => {
	userDataDir = mkdtempSync(path.join(tmpdir(), "superset-cdp-port-"));
	delete process.env.DESKTOP_AUTOMATION_PORT;
});

afterEach(() => {
	rmSync(userDataDir, { recursive: true, force: true });
	if (previousAutomationPort === undefined) {
		delete process.env.DESKTOP_AUTOMATION_PORT;
	} else {
		process.env.DESKTOP_AUTOMATION_PORT = previousAutomationPort;
	}
});

function writeDevToolsActivePort(contents: string): void {
	writeFileSync(path.join(userDataDir, "DevToolsActivePort"), contents);
}

describe("resolveCdpPort", () => {
	it("trusts an explicitly configured automation port", async () => {
		process.env.DESKTOP_AUTOMATION_PORT = "9223";

		await expect(resolveCdpPort(0)).resolves.toBe(9223);
	});

	it("falls back to Chromium's DevToolsActivePort file", async () => {
		process.env.DESKTOP_AUTOMATION_PORT = "not-a-port";
		writeDevToolsActivePort("51111\n/devtools/browser/session-id\n");

		await expect(resolveCdpPort(0)).resolves.toBe(51111);
	});

	it("returns null for missing or malformed DevToolsActivePort files", async () => {
		await expect(resolveCdpPort(0)).resolves.toBeNull();

		writeDevToolsActivePort("0\n");
		await expect(resolveCdpPort(0)).resolves.toBeNull();

		writeDevToolsActivePort("not-a-port\n");
		await expect(resolveCdpPort(0)).resolves.toBeNull();
	});
});
