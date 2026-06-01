import { describe, expect, test } from "bun:test";
import {
	getDefaultV1ProjectImportCandidate,
	isProjectAlreadyImported,
	shouldSkipV1ProjectImportAll,
} from "./importProjectPolicy";

const localCandidate = {
	id: "local-project",
	name: "Local Project",
	repoCloneUrl: "https://github.com/acme/app",
	source: "local-path",
	matchesExpected: true,
	staleLocalLink: false,
} as const;

const remoteCandidate = {
	id: "cloud-project",
	name: "Cloud Project",
	repoCloneUrl: "https://github.com/acme/app",
	source: "remote",
	matchesExpected: true,
	staleLocalLink: false,
} as const;

describe("v1 project import candidate policy", () => {
	test("treats only local-path candidates as already imported", () => {
		expect(
			isProjectAlreadyImported({
				candidates: [remoteCandidate],
				cloudErrors: [],
			}),
		).toBe(false);
		expect(
			isProjectAlreadyImported({
				candidates: [localCandidate, remoteCandidate],
				cloudErrors: [],
			}),
		).toBe(true);
	});

	test("does not auto-link remote-only candidates", () => {
		expect(
			getDefaultV1ProjectImportCandidate({
				candidates: [remoteCandidate],
				cloudErrors: [],
			}),
		).toBeNull();
		expect(
			getDefaultV1ProjectImportCandidate({
				candidates: [localCandidate, remoteCandidate],
				cloudErrors: [],
			})?.id,
		).toBe("local-project");
	});

	test("allows Import all to create a path-specific project for remote-only matches", () => {
		expect(
			shouldSkipV1ProjectImportAll({
				candidates: [remoteCandidate],
				cloudErrors: [],
			}),
		).toBe(false);
		expect(
			shouldSkipV1ProjectImportAll({
				candidates: [],
				cloudErrors: [
					{ url: "https://github.com/acme/app", message: "offline" },
				],
			}),
		).toBe(true);
	});
});
