import { observable } from "@trpc/server/observable";
import { serviceStatusService } from "main/lib/service-status";
import type { ServiceStatusSnapshot } from "shared/service-status-types";
import { publicProcedure, router } from "..";

export const createServiceStatusRouter = () => {
	return router({
		getAll: publicProcedure.query(() => serviceStatusService.getAll()),

		onChange: publicProcedure.subscription(() => {
			return observable<ServiceStatusSnapshot>((emit) => {
				// Emit the current state immediately so late subscribers don't
				// have to wait for the next poll tick.
				for (const snapshot of serviceStatusService.getAll()) {
					emit.next(snapshot);
				}

				const onChange = (snapshot: ServiceStatusSnapshot) => {
					emit.next(snapshot);
				};
				serviceStatusService.on("change", onChange);
				return () => {
					serviceStatusService.off("change", onChange);
				};
			});
		}),
	});
};
