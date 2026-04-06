/**
 * VS Code Extension Host Shim for Superset Desktop.
 *
 * Provides a minimal VS Code API surface to run official VS Code extensions
 * (Claude Code, ChatGPT/Codex) inside the Electron app.
 */

export {
	getActivePanel,
	getActiveView,
	getViewProvider,
	onWebviewEvent,
	resolveWebviewView,
} from "./api/webview.js";
export { handleUri, setActiveTextEditor } from "./api/window.js";
export {
	getActiveExtensions,
	initExtensionHost,
	shutdownExtensionHost,
	updateWorkspacePath,
} from "./extension-host.js";
export {
	deactivateExtension,
	discoverExtensions,
	getLoadedExtension,
	getLoadedExtensions,
	loadExtension,
} from "./loader.js";
export type {
	ExtensionInfo,
	ExtensionManifest,
	WebviewMessage,
} from "./types.js";
export { webviewBridge } from "./webview-bridge.js";
