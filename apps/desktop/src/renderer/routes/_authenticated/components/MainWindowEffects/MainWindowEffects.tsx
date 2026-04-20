import { ScheduleFireToasts } from "renderer/features/todo-agent/ScheduleFireToasts";
import { isTearoffWindow } from "renderer/hooks/useTearoffInit/useTearoffInit";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { WorkspaceInitEffects } from "renderer/screens/main/components/WorkspaceInitEffects";
import { AgentHooks } from "../AgentHooks";

/**
 * Effects that must have a single renderer owner. Tear-off windows render the
 * same authenticated tree but should stay read-only with respect to device-
 * scoped orchestration and global toasts.
 */
export function MainWindowEffects() {
	const isTearoff = isTearoffWindow();
	const tearoffWindowId = window.App?.tearoffWindowId ?? null;
	const { data: shouldOwnEffectsInTearoff } =
		electronTrpc.window.shouldOwnSingletonEffects.useQuery(
			{ tearoffWindowId },
			{
				enabled: isTearoff,
				refetchInterval: 1_000,
			},
		);

	if (isTearoff && !shouldOwnEffectsInTearoff) {
		return null;
	}

	return (
		<>
			<AgentHooks />
			<ScheduleFireToasts />
			<WorkspaceInitEffects />
		</>
	);
}
