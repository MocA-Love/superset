/**
 * VS Code Extension Host Shim for Superset Desktop.
 *
 * Provides a minimal VS Code API surface to run official VS Code extensions
 * (Claude Code, ChatGPT/Codex) inside the Electron app.
 */

export {
	initExtensionHost,
	shutdownExtensionHost,
	updateWorkspacePath,
	getActiveExtensions,
} from "./extension-host.js";

export {
	loadExtension,
	deactivateExtension,
	getLoadedExtension,
	getLoadedExtensions,
	discoverExtensions,
} from "./loader.js";

export {
	resolveWebviewView,
	onWebviewEvent,
	getViewProvider,
	getActiveView,
	getActivePanel,
} from "./api/webview.js";

export type { ExtensionManifest, ExtensionInfo, WebviewMessage } from "./types.js";
