import { describe, expect, test } from "bun:test";
import {
	getGitHubPRCommentsQueryPolicy,
	getGitHubStatusQueryPolicy,
} from "./githubQueryPolicy";

describe("getGitHubStatusQueryPolicy", () => {
	test("enables focus-only refresh for the active changes sidebar diffs view", () => {
		expect(
			getGitHubStatusQueryPolicy("changes-sidebar", {
				hasWorkspaceId: true,
				isActive: true,
				isReviewTabActive: false,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 0,
		});
	});

	test("polls backend cache for the active changes sidebar review view (reads SyncService-warmed cache)", () => {
		expect(
			getGitHubStatusQueryPolicy("changes-sidebar", {
				hasWorkspaceId: true,
				isActive: true,
				isReviewTabActive: true,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: 5_000,
			refetchOnWindowFocus: false,
			staleTime: 5_000,
		});
	});

	test("disables changes sidebar status when the surface is inactive", () => {
		expect(
			getGitHubStatusQueryPolicy("changes-sidebar", {
				hasWorkspaceId: true,
				isActive: false,
				isReviewTabActive: true,
			}),
		).toEqual({
			enabled: false,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 5_000,
		});
	});

	test("keeps the workspace page active without interval polling", () => {
		expect(
			getGitHubStatusQueryPolicy("workspace-page", {
				hasWorkspaceId: true,
				isActive: true,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 300_000,
		});
	});

	test("keeps hover-card surfaces lazy without focus refresh", () => {
		expect(
			getGitHubStatusQueryPolicy("workspace-hover-card", {
				hasWorkspaceId: true,
				isActive: true,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 300_000,
		});
	});

	test("keeps workspace list items cheaper than full-page PR surfaces", () => {
		expect(
			getGitHubStatusQueryPolicy("workspace-list-item", {
				hasWorkspaceId: true,
				isActive: true,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 30_000,
		});
	});

	test("disables passive hover surfaces when they are not visible", () => {
		expect(
			getGitHubStatusQueryPolicy("workspace-row", {
				hasWorkspaceId: true,
				isActive: false,
			}),
		).toEqual({
			enabled: false,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 300_000,
		});
	});
});

describe("getGitHubPRCommentsQueryPolicy", () => {
	test("fetches review comments without polling when changes is open on diffs", () => {
		expect(
			getGitHubPRCommentsQueryPolicy({
				hasWorkspaceId: true,
				hasActivePullRequest: true,
				isActive: true,
				isReviewTabActive: false,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 20_000,
		});
	});

	test("polls backend cache for review comments when review tab is active", () => {
		expect(
			getGitHubPRCommentsQueryPolicy({
				hasWorkspaceId: true,
				hasActivePullRequest: true,
				isActive: true,
				isReviewTabActive: true,
			}),
		).toEqual({
			enabled: true,
			refetchInterval: 20_000,
			refetchOnWindowFocus: false,
			staleTime: 20_000,
		});
	});

	test("disables comments when there is no active pull request", () => {
		expect(
			getGitHubPRCommentsQueryPolicy({
				hasWorkspaceId: true,
				hasActivePullRequest: false,
				isActive: true,
				isReviewTabActive: true,
			}),
		).toEqual({
			enabled: false,
			refetchInterval: false,
			refetchOnWindowFocus: false,
			staleTime: 20_000,
		});
	});
});
