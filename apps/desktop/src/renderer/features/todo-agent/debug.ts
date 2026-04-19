import { createRendererDebugChannel } from "renderer/lib/debug-channel";

function isTodoAgentDebugEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem("SUPERSET_TODO_DEBUG") === "1";
	} catch {
		return false;
	}
}

// TODO Agent の renderer 側 logger。
// 作成 UI は TodoModal と AgentManager 内 composer の 2 系統あるため、
// どちらから、どの PTY / Remote Control フラグで submit されたかを残す。
// これにより main 側の runtime-config / daemon 判定ログと source を
// sessionId 単位で付き合わせられる。
export const todoAgentRendererDebug = createRendererDebugChannel({
	namespace: "todo.agent.renderer",
	enabled: true,
	mirrorToConsole: isTodoAgentDebugEnabled(),
});
