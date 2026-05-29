import { describe, test } from "bun:test";

describe("workspaceCreation misc procedures", () => {
	test.todo("getContext reports hasLocalRepo=false for unknown project");
	test.todo("getContext returns defaultBranch when project exists locally");
	test.todo("getProgress returns null for unknown pendingId");
	test.todo("getProgress reflects state set via the in-memory store");
	test.todo("generateBranchName returns null for empty prompts (no AI call)");
	test.todo("generateBranchName returns null when project is unknown");
});
