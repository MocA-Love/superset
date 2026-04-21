import { observable } from "@trpc/server/observable";
import {
	PERMISSION_TOGGLE_KEYS,
	PERMISSION_TOGGLE_META,
	type PermissionConfig,
	type PermissionToggleKey,
	permissionStore,
} from "main/lib/browser-mcp-bridge/permissions";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const togglesSchema = z
	.record(z.string(), z.boolean())
	.transform((v): Partial<Record<PermissionToggleKey, boolean>> => {
		const out: Partial<Record<PermissionToggleKey, boolean>> = {};
		for (const k of PERMISSION_TOGGLE_KEYS) {
			if (k in v) out[k] = v[k];
		}
		return out;
	});

export const createBrowserPermissionsRouter = () => {
	return router({
		getConfig: publicProcedure.query(() => permissionStore.getConfig()),
		getToggleMeta: publicProcedure.query(() => PERMISSION_TOGGLE_META),
		setActive: publicProcedure
			.input(z.object({ presetId: z.string() }))
			.mutation(({ input }) => {
				permissionStore.setActive(input.presetId);
				return permissionStore.getConfig();
			}),
		savePreset: publicProcedure
			.input(
				z.object({
					id: z.string().optional(),
					name: z.string().min(1).max(64),
					toggles: togglesSchema,
				}),
			)
			.mutation(({ input }) => {
				return permissionStore.savePreset({
					id: input.id,
					name: input.name,
					toggles: input.toggles,
				});
			}),
		deletePreset: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				permissionStore.deletePreset(input.id);
				return permissionStore.getConfig();
			}),
		onChange: publicProcedure.subscription(() => {
			return observable<PermissionConfig>((emit) => {
				const handler = (config: PermissionConfig) => emit.next(config);
				permissionStore.on("change", handler);
				// Prime the subscription so clients get current state
				// without an extra query round-trip.
				emit.next(permissionStore.getConfig());
				return () => {
					permissionStore.off("change", handler);
				};
			});
		}),
	});
};
