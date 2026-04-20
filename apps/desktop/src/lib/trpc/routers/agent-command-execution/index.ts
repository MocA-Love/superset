import { getAgentCommandExecutionCoordinator } from "main/lib/agent-command-execution-coordinator";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const claimInput = z.object({
	commandId: z.string(),
	timeoutAt: z.union([z.date(), z.string(), z.null()]).optional(),
});

const releaseInput = z.object({
	commandId: z.string(),
});

export const createAgentCommandExecutionRouter = () => {
	return router({
		claim: publicProcedure.input(claimInput).mutation(({ input }) => {
			const granted = getAgentCommandExecutionCoordinator().claim(
				input.commandId,
				input.timeoutAt,
			);
			return { granted };
		}),
		release: publicProcedure.input(releaseInput).mutation(({ input }) => {
			getAgentCommandExecutionCoordinator().release(input.commandId);
			return { released: true };
		}),
	});
};
