import { ScheduleFireToasts } from "renderer/features/todo-agent/ScheduleFireToasts";
import { isTearoffWindow } from "renderer/hooks/useTearoffInit/useTearoffInit";
import { WorkspaceInitEffects } from "renderer/screens/main/components/WorkspaceInitEffects";
import { AgentHooks } from "../AgentHooks";

/**
 * Effects that must have a single renderer owner. Tear-off windows render the
 * same authenticated tree but should stay read-only with respect to device-
 * scoped orchestration and global toasts.
 */
export function MainWindowEffects() {
	if (isTearoffWindow()) {
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
