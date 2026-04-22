import type { Terminal } from "@xterm/xterm";

/**
 * Registers parser hooks to suppress terminal query responses and queries
 * on the renderer's xterm instance.
 *
 * In the desktop terminal architecture, both the daemon-side headless emulator
 * and the renderer's xterm process the same PTY output stream. If the renderer
 * is allowed to answer terminal queries (DA/DSR/OSC color queries), those
 * responses are forwarded back into the PTY and interactive CLIs can receive
 * duplicate escape-sequence data.
 *
 * We suppress:
 * 1. Terminal queries, so the renderer does not generate responses
 * 2. Response-only sequences, so echoed responses do not render as garbage
 *
 * @param terminal - The xterm.js Terminal instance
 * @returns Cleanup function to dispose all registered handlers
 */
export function suppressQueryResponses(terminal: Terminal): () => void {
	const disposables: { dispose: () => void }[] = [];
	const parser = terminal.parser;

	// =========================================================================
	// Suppress terminal QUERIES — prevents the renderer from generating a reply.
	// The daemon-side headless emulator remains the single source of truth.
	// =========================================================================

	// DA1 (primary device attributes): CSI c / CSI 0 c
	disposables.push(parser.registerCsiHandler({ final: "c" }, () => true));

	// DA2 (secondary device attributes): CSI > c
	disposables.push(
		parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true),
	);

	// DA3 (tertiary device attributes): CSI = c
	disposables.push(
		parser.registerCsiHandler({ prefix: "=", final: "c" }, () => true),
	);

	// DSR queries: CSI n / CSI ? n
	disposables.push(parser.registerCsiHandler({ final: "n" }, () => true));
	disposables.push(
		parser.registerCsiHandler({ prefix: "?", final: "n" }, () => true),
	);

	// OSC color queries — only suppress actual queries, not set operations.
	disposables.push(parser.registerOscHandler(4, (data) => data.includes("?")));
	disposables.push(parser.registerOscHandler(10, (data) => data === "?"));
	disposables.push(parser.registerOscHandler(11, (data) => data === "?"));
	disposables.push(parser.registerOscHandler(12, (data) => data === "?"));

	// =========================================================================
	// Suppress RESPONSE-ONLY sequences — prevents echoed responses from rendering.
	// =========================================================================

	// CSI R: Cursor Position Report response (query is CSI 6n)
	disposables.push(parser.registerCsiHandler({ final: "R" }, () => true));

	// CSI I: Focus In report
	disposables.push(parser.registerCsiHandler({ final: "I" }, () => true));

	// CSI O: Focus Out report
	disposables.push(parser.registerCsiHandler({ final: "O" }, () => true));

	// CSI $y: Mode report response (query is CSI $p)
	disposables.push(
		parser.registerCsiHandler({ intermediates: "$", final: "y" }, () => true),
	);

	return () => {
		for (const disposable of disposables) {
			disposable.dispose();
		}
	};
}
