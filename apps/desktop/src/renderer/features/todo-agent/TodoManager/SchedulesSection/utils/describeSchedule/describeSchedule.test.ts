import { describe, expect, it } from "bun:test";
import { describeSchedule } from "./describeSchedule";

const baseSchedule = {
	minute: null,
	hour: null,
	weekday: null,
	monthday: null,
	cronExpr: null,
};

describe("describeSchedule", () => {
	it("renders built-in cadences as compact Japanese labels", () => {
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "hourly",
				minute: 5,
			}),
		).toBe("毎時 05分");
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "daily",
				hour: 9,
				minute: 7,
			}),
		).toBe("毎日 09:07");
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "weekly",
				weekday: 2,
				hour: 14,
				minute: 30,
			}),
		).toBe("毎週火曜 14:30");
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "monthly",
				monthday: 31,
				hour: 23,
				minute: 45,
			}),
		).toBe("毎月31日 23:45");
	});

	it("falls back to zeroed defaults for incomplete built-in cadences", () => {
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "daily",
			}),
		).toBe("毎日 00:00");
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "weekly",
			}),
		).toBe("毎週日曜 00:00");
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "monthly",
			}),
		).toBe("毎月1日 00:00");
	});

	it("keeps custom cron schedules readable and resilient", () => {
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "custom",
				cronExpr: null,
			}),
		).toBe("未設定");
		expect(
			describeSchedule({
				...baseSchedule,
				frequency: "custom",
				cronExpr: "not a cron",
			}),
		).toBe("not a cron");
	});
});
