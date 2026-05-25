import { describe, expect, test } from "bun:test";
import type { WorkspaceState } from "@superset/panes";
import {
	getAttachedTerminalIds,
	getBackgroundTerminalSessions,
} from "./BackgroundTerminalsButton.utils";

describe("BackgroundTerminalsButton utils", () => {
	test("returns stable sorted attached terminal ids", () => {
		const tabs = [
			{
				id: "tab-1",
				panes: {
					"pane-1": {
						id: "pane-1",
						kind: "terminal",
						data: { terminalId: "terminal-b" },
					},
					"pane-2": {
						id: "pane-2",
						kind: "terminal",
						data: { terminalId: "terminal-a" },
					},
				},
			},
		] as unknown as WorkspaceState<unknown>["tabs"];

		expect(getAttachedTerminalIds(tabs)).toEqual(["terminal-a", "terminal-b"]);
	});

	test("filters attached sessions and sorts newest first", () => {
		const sessions = [
			{ terminalId: "terminal-old", createdAt: 10, title: "old" },
			{ terminalId: "terminal-attached", createdAt: 30, title: "attached" },
			{ terminalId: "terminal-new", createdAt: 20, title: "new" },
		];

		expect(
			getBackgroundTerminalSessions(sessions, ["terminal-attached"]),
		).toEqual([
			{ terminalId: "terminal-new", createdAt: 20, title: "new" },
			{ terminalId: "terminal-old", createdAt: 10, title: "old" },
		]);
	});
});
