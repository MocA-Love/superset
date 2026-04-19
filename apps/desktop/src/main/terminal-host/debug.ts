import { createMainDebugChannel } from "../lib/debug-channel";

const DEBUG_TERMINAL = process.env.SUPERSET_TERMINAL_DEBUG === "1";

// terminal host のログは、再起動前提の再現を避けるため
// Sentry には常時送る。
// これにより renderer 側の停止、hidden terminal の滞留、
// PTY/emulator の backpressure を事後に追いやすくする。
// env フラグは同じ内容を console にも出すかだけを制御する。
export const terminalHostDebug = createMainDebugChannel({
	namespace: "terminal.host",
	enabled: true,
	mirrorToConsole: DEBUG_TERMINAL,
});
