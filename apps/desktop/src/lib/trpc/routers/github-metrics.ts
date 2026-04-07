import { publicProcedure, router } from "..";
import { getGitHubMetricsSnapshot } from "./workspaces/utils/github/github-metrics";
import { getGitHubRateLimitState } from "./workspaces/utils/github/github-rate-limiter";
import { githubSyncService } from "./workspaces/utils/github/github-sync-service";

export const createGitHubMetricsRouter = () => {
	return router({
		getSnapshot: publicProcedure.query(() => {
			return {
				generatedAt: Date.now(),
				rateLimit: getGitHubRateLimitState(),
				syncService: githubSyncService.getDebugSnapshot(),
				metrics: getGitHubMetricsSnapshot(),
			};
		}),
	});
};

export type GitHubMetricsRouter = ReturnType<typeof createGitHubMetricsRouter>;
