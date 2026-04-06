/**
 * Webview bridge: manages communication between VS Code extension webviews
 * and the Superset Desktop renderer process via an EventEmitter.
 *
 * The tRPC router subscribes to these events and forwards them to the renderer.
 */

import { EventEmitter } from "node:events";
import { shimLog, shimWarn } from "./api/debug-log";
import {
	getActiveView,
	onWebviewEvent,
	resolveWebviewView,
	type WebviewEvent,
	type WebviewInternal,
} from "./api/webview";
import { setWebviewHtml } from "./api/webview-server";

export interface WebviewBridgeEvent {
	type: "html" | "message" | "title" | "dispose";
	viewId: string;
	data: unknown;
}

class WebviewBridge extends EventEmitter {
	private _viewHtml = new Map<string, string>();
	private _viewIds = new Map<string, string>(); // viewType -> viewId

	constructor() {
		super();
		// Listen for events from the webview shim
		onWebviewEvent((event: WebviewEvent) => {
			shimLog(
				`[webview-bridge] Event: type=${event.type}, viewId=${event.viewId}, dataLen=${typeof event.data === "string" ? event.data.length : "N/A"}`,
			);
			if (event.type === "html") {
				this._viewHtml.set(event.viewId, event.data as string);
				setWebviewHtml(event.viewId, event.data as string);
				shimLog(
					`[webview-bridge] Stored HTML for ${event.viewId}, htmlStore now has ${this._viewHtml.size} entries`,
				);
			}
			this.emit("webview-event", event);
		});
	}

	/** Resolve a webview view (called when renderer requests a sidebar view) */
	resolveView(viewType: string, extensionPath: string): string | undefined {
		shimLog(`[vscode-shim] WebviewBridge.resolveView called: ${viewType}`);
		const result = resolveWebviewView(viewType, extensionPath);
		if (!result) {
			shimWarn(
				`[vscode-shim] WebviewBridge.resolveView: no result for ${viewType}`,
			);
			return undefined;
		}

		const { viewId } = result;
		this._viewIds.set(viewType, viewId);
		return viewId;
	}

	/** Get current HTML for a view */
	getHtml(viewId: string): string | undefined {
		return this._viewHtml.get(viewId);
	}

	/** Get all registered view types */
	getViewTypes(): string[] {
		return [...this._viewIds.keys()];
	}

	/** Get viewId for a viewType */
	getViewId(viewType: string): string | undefined {
		return this._viewIds.get(viewType);
	}

	/** Send message from renderer to extension webview */
	postMessageToExtension(viewId: string, message: unknown): void {
		const view = getActiveView(viewId);
		if (view) {
			(view.webview as WebviewInternal)._onDidReceiveMessage.fire(message);
		}
	}

	/** Subscribe to messages from extension to webview (postMessage calls) */
	subscribeToExtensionMessages(
		viewId: string,
		callback: (message: unknown) => void,
	): () => void {
		const view = getActiveView(viewId);
		if (!view) return () => {};
		const disposable = (
			view.webview as WebviewInternal
		)._onDidPostMessage.event(callback);
		return () => disposable.dispose();
	}
}

export const webviewBridge = new WebviewBridge();
