import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	installExtension,
	listExtensions,
	toggleExtension,
	uninstallExtension,
} from "main/lib/extensions/extension-manager";

export const createExtensionsRouter = () => {
	return router({
		list: publicProcedure.query(async () => {
			return listExtensions();
		}),

		install: publicProcedure
			.input(z.object({ input: z.string() }))
			.mutation(async ({ input }) => {
				return installExtension(input.input);
			}),

		uninstall: publicProcedure
			.input(z.object({ extensionId: z.string() }))
			.mutation(async ({ input }) => {
				await uninstallExtension(input.extensionId);
			}),

		toggle: publicProcedure
			.input(z.object({ extensionId: z.string(), enabled: z.boolean() }))
			.mutation(async ({ input }) => {
				return toggleExtension(input.extensionId, input.enabled);
			}),
	});
};
