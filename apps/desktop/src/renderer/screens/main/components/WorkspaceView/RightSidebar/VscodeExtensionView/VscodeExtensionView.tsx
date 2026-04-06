import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
}

/**
 * Renders a VS Code extension's webview inside an iframe.
 * Bridges postMessage between the iframe and the extension host via tRPC.
 */
export function VscodeExtensionView({
	viewType,
	extensionId,
	isActive,
}: VscodeExtensionViewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [viewId, setViewId] = useState<string | null>(null);
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();

	// Subscribe to webview events
	electronTrpc.vscodeExtensions.subscribeWebview.useSubscription(undefined, {
		enabled: isActive && !!viewId,
		onData: (event) => {
			if (!viewId) return;
			if (event.viewId !== viewId) return;

			if (event.type === "html") {
				setHtml(event.data as string);
			} else if (event.type === "message") {
				// Forward message from extension to iframe
				iframeRef.current?.contentWindow?.postMessage(
					{ type: "vscode-message", data: event.data },
					"*",
				);
			}
		},
	});

	// Resolve the webview when first becoming active
	useEffect(() => {
		if (!isActive || viewId) return;

		resolveMutation.mutate(
			{
				viewType,
				extensionPath: "", // Extension path is looked up by the host
			},
			{
				onSuccess: (result) => {
					if (result.viewId) {
						setViewId(result.viewId);
						setHtml(result.html);
					} else {
						setError(`Extension view "${viewType}" not found`);
					}
				},
				onError: (err) => {
					setError(err.message);
				},
			},
		);
	}, [isActive, viewId, viewType]);

	// Listen for messages from iframe -> forward to extension
	useEffect(() => {
		if (!viewId) return;

		const handler = (event: MessageEvent) => {
			if (event.data?.type === "vscode-api") {
				postMessageMutation.mutate({
					viewId,
					message: event.data.data,
				});
			}
		};

		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [viewId]);

	if (error) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				<p>{error}</p>
			</div>
		);
	}

	if (!html) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
				<p>Loading {extensionId}...</p>
			</div>
		);
	}

	// Inject acquireVsCodeApi bridge into the HTML
	const bridgedHtml = injectVscodeApiBridge(html);

	return (
		<iframe
			ref={iframeRef}
			srcDoc={bridgedHtml}
			className="w-full h-full border-0"
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
			title={`${extensionId} webview`}
		/>
	);
}

/**
 * Injects the acquireVsCodeApi() bridge script into extension webview HTML.
 * This allows the extension's webview JS to communicate with the extension host.
 */
function injectVscodeApiBridge(html: string): string {
	const bridgeScript = `
<script>
(function() {
	const vscodeApi = {
		postMessage(message) {
			window.parent.postMessage({ type: 'vscode-api', data: message }, '*');
		},
		getState() {
			try {
				return JSON.parse(sessionStorage.getItem('vscodeState') || 'null');
			} catch { return null; }
		},
		setState(state) {
			sessionStorage.setItem('vscodeState', JSON.stringify(state));
			return state;
		}
	};

	window.acquireVsCodeApi = function() { return vscodeApi; };

	// Listen for messages from the extension host (via parent)
	window.addEventListener('message', function(event) {
		if (event.data && event.data.type === 'vscode-message') {
			// Re-dispatch as a regular message event for the webview
			window.dispatchEvent(new MessageEvent('message', { data: event.data.data }));
		}
	});
})();
</script>`;

	// Insert before </head> or at the start of <body>
	if (html.includes("</head>")) {
		return html.replace("</head>", `${bridgeScript}</head>`);
	}
	if (html.includes("<body")) {
		return html.replace(/<body([^>]*)>/, `<body$1>${bridgeScript}`);
	}
	return `${bridgeScript}${html}`;
}
