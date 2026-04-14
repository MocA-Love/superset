/**
 * OSC 133 / OSC 777 shell readiness scanner.
 *
 * Recognises two markers:
 *   - OSC 133;A  ("\x1b]133;A" + optional params + "\a") — current standard
 *   - OSC 777    ("\x1b]777;superset-shell-ready\a")     — legacy marker
 *
 * Pure scanning logic — no side effects. Callers handle their own readiness
 * resolution (promises, state machines, event broadcasts, etc.).
 *
 * Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
 * Vendored from WezTerm (MIT, Copyright 2018-Present Wez Furlong).
 */

/** The OSC 133;A prefix that signals shell prompt start (= shell ready). */
const OSC_133_A = "\x1b]133;A";

/**
 * Legacy OSC 777 marker emitted by older shell wrappers.
 * Full string must match before \a — no optional params.
 */
const OSC_777 = "\x1b]777;superset-shell-ready";

/** Both markers share the "\x1b]" ESC-] prefix. */
const SHARED_PREFIX = "\x1b]";

/** Shells whose wrapper files inject OSC markers. */
export const SHELLS_WITH_READY_MARKER = new Set(["zsh", "bash", "fish"]);

/**
 * Mutable state for the character-by-character scanner.
 * Callers should create one per terminal session via {@link createScanState}.
 */
export interface ShellReadyScanState {
	matchPos: number;
	heldBytes: string;
	/** Which marker we're currently tracking after the shared ESC-] prefix. */
	matchTarget: "osc133" | "osc777" | null;
}

export interface ShellReadyScanResult {
	/** Output data with the marker stripped (if found). */
	output: string;
	/** Whether a shell-ready marker was matched in this chunk. */
	matched: boolean;
}

export function createScanState(): ShellReadyScanState {
	return { matchPos: 0, heldBytes: "", matchTarget: null };
}

function resetState(state: ShellReadyScanState): void {
	state.matchPos = 0;
	state.heldBytes = "";
	state.matchTarget = null;
}

/**
 * Scan a chunk of PTY output for a shell-ready marker (OSC 133;A or OSC 777).
 *
 * Matching bytes are held back from output. On full match, they're discarded
 * and `matched` is true. On mismatch, held bytes are flushed as regular output.
 *
 * The scanner handles markers spanning multiple data chunks.
 */
export function scanForShellReady(
	state: ShellReadyScanState,
	data: string,
): ShellReadyScanResult {
	let output = "";

	for (let i = 0; i < data.length; i++) {
		const ch = data[i] as string;

		// Phase 1: match the shared "\x1b]" prefix (matchPos 0-1, target=null)
		if (state.matchTarget === null) {
			if (ch === SHARED_PREFIX[state.matchPos]) {
				state.heldBytes += ch;
				state.matchPos++;
				if (state.matchPos === SHARED_PREFIX.length) {
					// Shared prefix matched — peek ahead to determine the target.
					// We'll resolve on the next character.
					state.matchTarget = "pending" as "osc133"; // temporary sentinel
				}
			} else {
				output += state.heldBytes;
				resetState(state);
				if (ch === SHARED_PREFIX[0]) {
					state.heldBytes = ch;
					state.matchPos = 1;
				} else {
					output += ch;
				}
			}
			continue;
		}

		// Phase 1b: shared prefix matched, resolve target from next char
		if ((state.matchTarget as string) === "pending") {
			if (ch === "1") {
				state.matchTarget = "osc133";
			} else if (ch === "7") {
				state.matchTarget = "osc777";
			} else {
				// Not a recognised marker — flush and reset
				output += state.heldBytes;
				resetState(state);
				output += ch;
				continue;
			}
			state.heldBytes += ch;
			state.matchPos++;
			continue;
		}

		// Phase 2: continue matching the chosen target prefix
		const target = state.matchTarget === "osc133" ? OSC_133_A : OSC_777;

		if (state.matchPos < target.length) {
			if (ch === target[state.matchPos]) {
				state.heldBytes += ch;
				state.matchPos++;
			} else {
				// Mismatch — flush held bytes, re-test current char
				output += state.heldBytes;
				resetState(state);
				if (ch === SHARED_PREFIX[0]) {
					state.heldBytes = ch;
					state.matchPos = 1;
				} else {
					output += ch;
				}
			}
		} else {
			// Matched full target prefix — consume until string terminator \a
			if (ch === "\x07") {
				// Full match — discard held bytes
				const remaining = data.slice(i + 1);
				resetState(state);
				return { output: output + remaining, matched: true };
			}
			if (state.matchTarget === "osc777") {
				// OSC 777 must match exactly — any extra char is a mismatch
				output += state.heldBytes;
				resetState(state);
				if (ch === SHARED_PREFIX[0]) {
					state.heldBytes = ch;
					state.matchPos = 1;
				} else {
					output += ch;
				}
			} else {
				// OSC 133;A: consume optional params (e.g. ";cl=m;aid=123") before \a
				state.heldBytes += ch;
			}
		}
	}

	return { output, matched: false };
}
