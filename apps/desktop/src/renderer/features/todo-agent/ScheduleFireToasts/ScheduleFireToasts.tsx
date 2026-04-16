import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Subscribes to the scheduler's fire events in the main process and shows
 * a toast for each one. Mounted once at the layout level so notifications
 * surface regardless of whether the TodoManager dialog is open.
 *
 * Renders nothing.
 */
export function ScheduleFireToasts() {
	const utils = electronTrpc.useUtils();

	electronTrpc.todoAgent.schedule.onFire.useSubscription(undefined, {
		onError: (err) => {
			console.warn("[schedule-toasts] subscription error", err);
		},
		onData: (event) => {
			if (event.kind === "triggered") {
				toast.success(`📅 ${event.scheduleName} を実行しました`, {
					description: event.sessionId
						? "TODO Manager のタスクタブから進捗を確認できます"
						: undefined,
				});
			} else if (event.kind === "skipped") {
				toast.info(`⏭️ ${event.scheduleName} をスキップしました`, {
					description: event.message ?? undefined,
				});
			} else if (event.kind === "failed") {
				toast.error(`⚠️ ${event.scheduleName} の発火に失敗しました`, {
					description: event.message ?? undefined,
				});
			}

			void utils.todoAgent.schedule.listAll.invalidate();
			void utils.todoAgent.listAll.invalidate();
		},
	});

	return null;
}
