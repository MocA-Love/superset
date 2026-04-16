import { observable } from "@trpc/server/observable";
import { serviceStatusService } from "main/lib/service-status";
import type { ServiceStatusSnapshot } from "shared/service-status-types";
import { publicProcedure, router } from "..";

export const createServiceStatusRouter = () => {
	return router({
		// No `getAll` query: the subscription emits the current state for every
		// snapshot on connect, so the client gets the initial value without a
		// separate round-trip (and we avoid the staleTime-Infinity / subscription
		// race where the query would later clobber fresh subscription data).
		onChange: publicProcedure.subscription(() => {
			return observable<ServiceStatusSnapshot>((emit) => {
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
