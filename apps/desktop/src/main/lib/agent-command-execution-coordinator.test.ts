import { describe, expect, it } from "bun:test";
import { AgentCommandExecutionCoordinator } from "./agent-command-execution-coordinator";

describe("AgentCommandExecutionCoordinator", () => {
	it("grants the first claim and rejects duplicates until release", () => {
		const coordinator = new AgentCommandExecutionCoordinator(50);

		expect(coordinator.claim("cmd-1")).toBe(true);
		expect(coordinator.claim("cmd-1")).toBe(false);

		coordinator.release("cmd-1");

		expect(coordinator.claim("cmd-1")).toBe(true);
	});

	it("allows reclaim after the lease expires", async () => {
		const coordinator = new AgentCommandExecutionCoordinator(20);
		const expiredSoon = new Date(Date.now() + 20);

		expect(coordinator.claim("cmd-2", expiredSoon)).toBe(true);
		expect(coordinator.claim("cmd-2", expiredSoon)).toBe(false);

		await Bun.sleep(30);

		expect(coordinator.claim("cmd-2", expiredSoon)).toBe(true);
	});

	it("treats invalid timeout values as a fallback lease", () => {
		const coordinator = new AgentCommandExecutionCoordinator(50);

		expect(coordinator.claim("cmd-3", "invalid")).toBe(true);
		expect(coordinator.isClaimed("cmd-3")).toBe(true);
	});

	it("keeps a fallback lease even when timeoutAt is already expired", () => {
		const coordinator = new AgentCommandExecutionCoordinator(50);
		const alreadyExpired = new Date(Date.now() - 1_000);

		expect(coordinator.claim("cmd-4", alreadyExpired)).toBe(true);
		expect(coordinator.claim("cmd-4", alreadyExpired)).toBe(false);
		expect(coordinator.isClaimed("cmd-4")).toBe(true);
	});
});
