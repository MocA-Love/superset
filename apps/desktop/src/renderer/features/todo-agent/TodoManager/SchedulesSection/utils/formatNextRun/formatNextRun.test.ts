import { afterEach, describe, expect, it } from "bun:test";
import { formatNextRun } from "./formatNextRun";

const RealDate = Date;

function setNow(now: Date): void {
	const nowMs = now.getTime();
	globalThis.Date = class extends RealDate {
		constructor(...args: [] | [number | string]) {
			if (args.length === 0) {
				super(nowMs);
				return;
			}
			super(args[0]);
		}

		static now(): number {
			return nowMs;
		}
	} as DateConstructor;
}

afterEach(() => {
	globalThis.Date = RealDate;
});

describe("formatNextRun", () => {
	it("renders null next-run timestamps as unset", () => {
		expect(formatNextRun(null)).toBe("未設定");
	});

	it("renders pending and imminent schedule runs", () => {
		setNow(new RealDate(2026, 0, 2, 10, 0, 0));

		expect(formatNextRun(new RealDate(2026, 0, 2, 9, 59, 0).getTime())).toBe(
			"09:59 (処理待ち)",
		);
		expect(formatNextRun(new RealDate(2026, 0, 2, 10, 0, 30).getTime())).toBe(
			"まもなく",
		);
	});

	it("renders same-day and next-day schedule runs", () => {
		setNow(new RealDate(2026, 0, 2, 10, 0, 0));

		expect(formatNextRun(new RealDate(2026, 0, 2, 10, 20, 0).getTime())).toBe(
			"20分後 (10:20)",
		);
		expect(formatNextRun(new RealDate(2026, 0, 2, 14, 0, 0).getTime())).toBe(
			"今日 14:00",
		);
		expect(formatNextRun(new RealDate(2026, 0, 3, 9, 0, 0).getTime())).toBe(
			"明日 09:00",
		);
	});
});
