/**
 * VS Code Webview API shim.
 */

import { shimLog, shimWarn } from "./debug-log";
import { Disposable, type Event, EventEmitter } from "./event-emitter";
import { Uri } from "./uri";

export interface WebviewOptions {
	enableScripts?: boolean;
	enableCommandUris?: boolean;
	localResourceRoots?: Uri[];
	portMapping?: Array<{ webviewPort: number; extensionHostPort: number }>;
}

export interface Webview {
	options: WebviewOptions;
	html: string;
	readonly onDidReceiveMessage: Event<unknown>;
	postMessage(message: unknown): Promise<boolean>;
	asWebviewUri(localResource: Uri): Uri;
	readonly cspSource: string;
}

export interface WebviewView {
	readonly viewType: string;
	readonly webview: Webview;
	title?: string;
	description?: string;
	badge?: { tooltip: string; value: number };
	readonly visible: boolean;
	readonly onDidDispose: Event<void>;
	readonly onDidChangeVisibility: Event<void>;
	show(preserveFocus?: boolean): void;
	dispose(): void;
}

export interface WebviewPanel {
	readonly viewType: string;
	title: string;
	readonly webview: Webview;
	readonly active: boolean;
	readonly visible: boolean;
	readonly viewColumn: number | undefined;
	readonly onDidDispose: Event<void>;
	readonly onDidChangeViewState: Event<{ webviewPanel: WebviewPanel }>;
	iconPath?: Uri | { light: Uri; dark: Uri };
	reveal(viewColumn?: number, preserveFocus?: boolean): void;
	dispose(): void;
}

export interface WebviewViewProvider {
	resolveWebviewView(
		webviewView: WebviewView,
		context: { state?: unknown },
		token: {
			isCancellationRequested: boolean;
			onCancellationRequested: Event<void>;
		},
	): void | Promise<void>;
}

export interface WebviewPanelSerializer {
	deserializeWebviewPanel(
		webviewPanel: WebviewPanel,
		state: unknown,
	): Promise<void>;
}

// Emits when webview html/messages change — consumed by tRPC router
export interface WebviewEvent {
	viewId: string;
	type: "html" | "message" | "title" | "dispose";
	data: unknown;
}

const _onWebviewEvent = new EventEmitter<WebviewEvent>();
export const onWebviewEvent = _onWebviewEvent.event;

const viewProviders = new Map<string, WebviewViewProvider>();
const panelSerializers = new Map<string, WebviewPanelSerializer>();
const activeViews = new Map<string, WebviewView>();
const activePanels = new Map<string, WebviewPanel>();

export function getViewProvider(
	viewType: string,
): WebviewViewProvider | undefined {
	return viewProviders.get(viewType);
}

export function getActiveView(viewId: string): WebviewView | undefined {
	return activeViews.get(viewId);
}

export function getActivePanel(panelId: string): WebviewPanel | undefined {
	return activePanels.get(panelId);
}

export function registerWebviewViewProvider(
	viewType: string,
	provider: WebviewViewProvider,
	_options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
): Disposable {
	shimLog(`[vscode-shim] registerWebviewViewProvider: ${viewType}`);
	viewProviders.set(viewType, provider);
	return new Disposable(() => {
		viewProviders.delete(viewType);
	});
}

export function registerWebviewPanelSerializer(
	viewType: string,
	serializer: WebviewPanelSerializer,
): Disposable {
	panelSerializers.set(viewType, serializer);
	return new Disposable(() => {
		panelSerializers.delete(viewType);
	});
}

export interface WebviewInternal extends Webview {
	_onDidReceiveMessage: EventEmitter<unknown>;
	_onDidPostMessage: EventEmitter<unknown>;
}

function createWebview(
	_extensionPath: string,
	options?: WebviewOptions,
): WebviewInternal {
	const _onDidReceiveMessage = new EventEmitter<unknown>();
	const _onDidPostMessage = new EventEmitter<unknown>();
	let _html = "";

	return {
		options: options ?? {},
		get html() {
			return _html;
		},
		set html(value: string) {
			_html = value;
		},
		onDidReceiveMessage: _onDidReceiveMessage.event,
		_onDidReceiveMessage,
		_onDidPostMessage,
		async postMessage(message: unknown): Promise<boolean> {
			_onDidPostMessage.fire(message);
			return true;
		},
		asWebviewUri(localResource: Uri): Uri {
			return Uri.from({
				scheme: "vscode-webview-resource",
				path: localResource.path,
			});
		},
		cspSource: "vscode-webview-resource:",
	};
}

/** Called from renderer when a sidebar view becomes visible */
export function resolveWebviewView(
	viewType: string,
	extensionPath: string,
): { view: WebviewView; viewId: string } | undefined {
	shimLog(
		`[vscode-shim] resolveWebviewView: ${viewType}, registered providers: [${[...viewProviders.keys()].join(", ")}]`,
	);
	const provider = viewProviders.get(viewType);
	if (!provider) {
		shimWarn(`[vscode-shim] No provider found for viewType: ${viewType}`);
		return undefined;
	}

	const _onDidDispose = new EventEmitter<void>();
	const _onDidChangeVisibility = new EventEmitter<void>();
	const webview = createWebview(extensionPath, { enableScripts: true });
	const viewId = `view:${viewType}:${Date.now()}`;

	// Relay extension→webview postMessage as events (so tRPC subscription can forward to iframe)
	webview._onDidPostMessage.event((message) => {
		shimLog(
			`[webview:${viewId}] postMessage from extension to webview, type=${typeof message === "object" && message !== null && "type" in message ? (message as { type: string }).type : "unknown"}`,
		);
		_onWebviewEvent.fire({ viewId, type: "message", data: message });
	});

	// Intercept html setter to emit events
	const rawWebview = webview;
	const proxiedWebview = new Proxy(rawWebview, {
		set(target, prop, value) {
			if (prop === "html") {
				const htmlStr = typeof value === "string" ? value : String(value);
				shimLog(
					`[webview:${viewId}] HTML set, length=${htmlStr.length}, preview="${htmlStr.substring(0, 100)}..."`,
				);
				(target as { html: string }).html = value;
				_onWebviewEvent.fire({ viewId, type: "html", data: value });
				return true;
			}
			shimLog(`[webview:${viewId}] Property set: ${String(prop)}`);
			(target as unknown as Record<string | symbol, unknown>)[prop] = value;
			return true;
		},
	});

	const view: WebviewView = {
		viewType,
		webview: proxiedWebview,
		title: undefined,
		description: undefined,
		badge: undefined,
		visible: true,
		onDidDispose: _onDidDispose.event,
		onDidChangeVisibility: _onDidChangeVisibility.event,
		show(_preserveFocus?: boolean) {
			// noop for now
		},
		dispose() {
			_onDidDispose.fire();
			_onWebviewEvent.fire({ viewId, type: "dispose", data: null });
			activeViews.delete(viewId);
		},
	};

	activeViews.set(viewId, view);

	const cancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: new EventEmitter<void>().event,
	};

	shimLog(`[webview:${viewId}] Calling provider.resolveWebviewView...`);
	try {
		const result = provider.resolveWebviewView(
			view,
			{ state: undefined },
			cancellationToken,
		);
		if (result && typeof (result as Promise<void>).then === "function") {
			(result as Promise<void>)
				.then(() => {
					shimLog(
						`[webview:${viewId}] Provider resolved (async). HTML set: ${!!rawWebview.html}, len=${rawWebview.html?.length ?? 0}`,
					);
				})
				.catch((err: unknown) => {
					console.error(`[webview:${viewId}] Provider rejected:`, err);
				});
		} else {
			shimLog(
				`[webview:${viewId}] Provider resolved (sync). HTML set: ${!!rawWebview.html}, len=${rawWebview.html?.length ?? 0}`,
			);
		}
	} catch (err) {
		console.error(`[webview:${viewId}] Provider threw:`, err);
	}

	return { view, viewId };
}

export function createWebviewPanel(
	viewType: string,
	title: string,
	showOptions: number | { viewColumn: number; preserveFocus?: boolean },
	extensionPath: string,
	options?: WebviewOptions,
): WebviewPanel {
	const _onDidDispose = new EventEmitter<void>();
	const _onDidChangeViewState = new EventEmitter<{
		webviewPanel: WebviewPanel;
	}>();
	const webview = createWebview(extensionPath, options);
	const panelId = `panel:${viewType}:${Date.now()}`;
	const viewColumn =
		typeof showOptions === "number" ? showOptions : showOptions.viewColumn;

	const proxiedWebview = new Proxy(webview, {
		set(target, prop, value) {
			if (prop === "html") {
				(target as { html: string }).html = value;
				_onWebviewEvent.fire({
					panelId,
					type: "html",
					data: value,
				} as unknown as WebviewEvent);
				return true;
			}
			(target as unknown as Record<string | symbol, unknown>)[prop] = value;
			return true;
		},
	});

	const panel: WebviewPanel = {
		viewType,
		title,
		webview: proxiedWebview,
		active: true,
		visible: true,
		viewColumn,
		onDidDispose: _onDidDispose.event,
		onDidChangeViewState: _onDidChangeViewState.event,
		iconPath: undefined,
		reveal(_viewColumn?: number, _preserveFocus?: boolean) {
			// noop
		},
		dispose() {
			_onDidDispose.fire();
			activePanels.delete(panelId);
		},
	};

	activePanels.set(panelId, panel);
	return panel;
}
