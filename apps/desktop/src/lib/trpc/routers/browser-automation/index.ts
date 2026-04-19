import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Browser automation bindings router.
 *
 * Stores the paneId -> sessionId assignment for browser pane automation,
 * and exposes MCP-readiness detection by reading the user's agent config
 * files (Claude Code / Codex) for the `superset-browser` entry.
 *
 * State is in-memory and process-local. Persistence across app restarts
 * is intentionally out of scope for Phase 1; the binding is re-established
 * by the user next time they open the Connect dialog.
 */

export interface BrowserAutomationBinding {
	paneId: string;
	sessionId: string;
	connectedAt: number;
}

class BindingStore {
	private readonly byPane = new Map<string, BrowserAutomationBinding>();
	private readonly emitter = new EventEmitter();

	constructor() {
		// One subscription per renderer hook instance; a workspace with many
		// open panes can blow past Node's 10-listener default otherwise.
		this.emitter.setMaxListeners(0);
	}

	list(): BrowserAutomationBinding[] {
		return Array.from(this.byPane.values());
	}

	get(paneId: string): BrowserAutomationBinding | null {
		return this.byPane.get(paneId) ?? null;
	}

	getBySessionId(sessionId: string): BrowserAutomationBinding | null {
		for (const b of this.byPane.values()) {
			if (b.sessionId === sessionId) return b;
		}
		return null;
	}

	set(paneId: string, sessionId: string): { previousPaneId: string | null } {
		let previousPaneId: string | null = null;
		for (const [pid, binding] of this.byPane.entries()) {
			if (binding.sessionId === sessionId && pid !== paneId) {
				previousPaneId = pid;
				this.byPane.delete(pid);
			}
		}
		this.byPane.set(paneId, {
			paneId,
			sessionId,
			connectedAt: Date.now(),
		});
		this.emitChange();
		return { previousPaneId };
	}

	remove(paneId: string): boolean {
		const existed = this.byPane.delete(paneId);
		if (existed) this.emitChange();
		return existed;
	}

	private emitChange() {
		this.emitter.emit("change", this.list());
	}

	onChange(cb: (bindings: BrowserAutomationBinding[]) => void): () => void {
		this.emitter.on("change", cb);
		return () => {
			this.emitter.off("change", cb);
		};
	}
}

export const bindingStore = new BindingStore();

/**
 * Detect whether the given agent config file exposes the
 * `superset-browser` MCP entry. We do a conservative string check so
 * this works for both JSON (Claude) and TOML (Codex) without pulling
 * in a TOML parser.
 */
function detectSupersetBrowserMcp(filePath: string): boolean {
	try {
		const contents = readFileSync(filePath, "utf8");
		return contents.includes("superset-browser");
	} catch {
		return false;
	}
}

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

export const createBrowserAutomationRouter = () => {
	return router({
		getMcpStatus: publicProcedure
			.input(
				z.object({
					provider: z.enum(["Claude", "Codex"]).optional(),
				}),
			)
			.query(({ input }) => {
				const claudeReady = detectSupersetBrowserMcp(CLAUDE_SETTINGS_PATH);
				const codexReady = detectSupersetBrowserMcp(CODEX_CONFIG_PATH);
				const resolved =
					input.provider === "Claude"
						? claudeReady
						: input.provider === "Codex"
							? codexReady
							: claudeReady || codexReady;
				return {
					claudeReady,
					codexReady,
					ready: resolved,
					claudeConfigPath: CLAUDE_SETTINGS_PATH,
					codexConfigPath: CODEX_CONFIG_PATH,
				};
			}),

		listBindings: publicProcedure.query(() => bindingStore.list()),

		getBindingByPane: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => bindingStore.get(input.paneId)),

		getBindingBySession: publicProcedure
			.input(z.object({ sessionId: z.string() }))
			.query(({ input }) => bindingStore.getBySessionId(input.sessionId)),

		setBinding: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					sessionId: z.string(),
				}),
			)
			.mutation(({ input }) => bindingStore.set(input.paneId, input.sessionId)),

		removeBinding: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => ({
				removed: bindingStore.remove(input.paneId),
			})),

		onBindingsChanged: publicProcedure.subscription(() => {
			return observable<BrowserAutomationBinding[]>((emit) => {
				emit.next(bindingStore.list());
				const off = bindingStore.onChange((list) => emit.next(list));
				return () => {
					off();
				};
			});
		}),
	});
};
