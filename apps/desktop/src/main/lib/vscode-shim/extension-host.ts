/**
 * Extension Host: high-level API to manage VS Code extensions in Superset Desktop.
 *
 * In the per-workspace model, extension loading is done by individual worker processes
 * managed by ExtensionHostManager. This module handles process-level setup only.
 */

import { registerWebviewProtocol } from "./api/protocol-handler";
import { startWebviewServer, stopWebviewServer } from "./api/webview-server";
import { getExtensionHostManager } from "./extension-host-manager";

let isInitialized = false;

export async function initExtensionHost(): Promise<void> {
	if (isInitialized) {
		return;
	}

	// Register protocol handler for webview resources
	registerWebviewProtocol();

	// Start HTTP server for webview content
	await startWebviewServer();

	// Initialize manager singleton
	getExtensionHostManager();

	isInitialized = true;
}

export async function shutdownExtensionHost(): Promise<void> {
	getExtensionHostManager().stopAll();
	stopWebviewServer();
	isInitialized = false;
}

export { isInitialized as isExtensionHostInitialized };
