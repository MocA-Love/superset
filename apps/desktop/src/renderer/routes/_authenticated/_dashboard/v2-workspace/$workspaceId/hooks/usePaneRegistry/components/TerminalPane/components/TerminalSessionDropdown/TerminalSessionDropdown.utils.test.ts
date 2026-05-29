import { describe, expect, test } from "bun:test";
import {
	getTerminalDisplayTitle,
	getTerminalSessionListRefetchInterval,
	shouldQueryTerminalSessionList,
	TERMINAL_SESSION_LIST_REFETCH_INTERVAL_MS,
} from "./TerminalSessionDropdown.utils";

describe("TerminalSessionDropdown utils", () => {
	test("queries and refetches only while open", () => {
		expect(shouldQueryTerminalSessionList(false)).toBe(false);
		expect(getTerminalSessionListRefetchInterval(false)).toBe(false);

		expect(shouldQueryTerminalSessionList(true)).toBe(true);
		expect(getTerminalSessionListRefetchInterval(true)).toBe(
			TERMINAL_SESSION_LIST_REFETCH_INTERVAL_MS,
		);
	});
});

describe("getTerminalDisplayTitle", () => {
	test("prefers explicit pane title overrides over runtime titles", () => {
		expect(
			getTerminalDisplayTitle({
				titleOverride: "echo sequence",
				runtimeTitle: "Terminal",
				sessionTitle: "zsh",
			}),
		).toBe("echo sequence");
	});

	test("falls back through runtime, session, and default titles", () => {
		expect(getTerminalDisplayTitle({ runtimeTitle: "vim" })).toBe("vim");
		expect(getTerminalDisplayTitle({ sessionTitle: "zsh" })).toBe("zsh");
		expect(getTerminalDisplayTitle({})).toBe("Terminal");
	});
});
