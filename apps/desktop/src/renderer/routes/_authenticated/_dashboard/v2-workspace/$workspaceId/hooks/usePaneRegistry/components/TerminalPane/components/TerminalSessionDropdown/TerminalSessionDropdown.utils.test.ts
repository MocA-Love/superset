import { describe, expect, test } from "bun:test";
import {
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
