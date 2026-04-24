import { createRendererDebugChannel } from "renderer/lib/debug-channel";
import type { DebugData } from "shared/debug-channel";

function isTerminalDebugEnabled(): boolean {
	try {
		return globalThis.localStorage?.getItem("SUPERSET_TERMINAL_DEBUG") === "1";
	} catch {
		return false;
	}
}

// terminal renderer のログは v1/v2 の両経路で再利用する前提で置く。
// 主調査対象:
// - タブ切り替えや reattach 後に Codex 系 TUI の再描画が崩れる問題
// - 入力は通っていそうなのに画面へ描画されない問題
// 副次仮説:
// - hidden terminal が data を受け続けて xterm を回し続ける問題
// 生の terminal 本文は送らず、状態遷移と byte/count 集計だけを残す。
// とくに visible terminal 問題では「入力」「受信」「xterm.write 実行」の
// 3 点を突き合わせたいので、下の helper で共通集計する。
// こうしておくと Sentry 上で検索しやすく、payload も肥大化しにくい。
export const terminalRendererDebug = createRendererDebugChannel({
	namespace: "terminal.renderer",
	enabled: true,
	mirrorToConsole: isTerminalDebugEnabled(),
	captureMessageByDefault: false,
});

export function logTerminalWrite(
	source: string,
	bytes: number,
	data?: DebugData,
): void {
	terminalRendererDebug.increment("xterm-write-events", 1, {
		data: { source, ...(data ?? {}) },
	});
	terminalRendererDebug.observe("xterm-write-bytes", bytes, {
		data: { source, ...(data ?? {}) },
	});
}

export function logTerminalInput(
	source: string,
	bytes: number,
	data?: DebugData,
): void {
	terminalRendererDebug.increment("terminal-input-events", 1, {
		data: { source, ...(data ?? {}) },
	});
	terminalRendererDebug.observe("terminal-input-bytes", bytes, {
		data: { source, ...(data ?? {}) },
	});
}
