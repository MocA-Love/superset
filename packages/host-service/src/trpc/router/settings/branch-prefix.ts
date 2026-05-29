import {
	BRANCH_PREFIX_MODES,
	type BranchPrefixMode,
} from "@superset/shared/workspace-launch";
import { z } from "zod";
import { hostSettings } from "../../../db/schema";
import { createUserSimpleGit } from "../../../runtime/git/simple-git";
import { protectedProcedure, router } from "../../index";
import { resolveGitInfo } from "../workspace-creation/utils/branch-prefix";

export const branchPrefixRouter = router({
	get: protectedProcedure.query(({ ctx }) => {
		const row = ctx.db.select().from(hostSettings).get();
		return {
			mode: (row?.branchPrefixMode ?? "none") satisfies BranchPrefixMode,
			customPrefix: row?.branchPrefixCustom ?? null,
		};
	}),

	set: protectedProcedure
		.input(
			z.object({
				mode: z.enum(BRANCH_PREFIX_MODES),
				customPrefix: z.string().nullable().optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			ctx.db
				.insert(hostSettings)
				.values({
					id: 1,
					branchPrefixMode: input.mode,
					branchPrefixCustom: input.customPrefix ?? null,
				})
				.onConflictDoUpdate({
					target: hostSettings.id,
					set: {
						branchPrefixMode: input.mode,
						branchPrefixCustom: input.customPrefix ?? null,
					},
				})
				.run();
			return { success: true as const };
		}),

	gitInfo: protectedProcedure.query(({ ctx }) =>
		resolveGitInfo(createUserSimpleGit(), ctx.execGh),
	),
});
