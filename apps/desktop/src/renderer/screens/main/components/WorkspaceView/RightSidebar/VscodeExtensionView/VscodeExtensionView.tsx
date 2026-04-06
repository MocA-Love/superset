import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
}

const BRIDGE_SCRIPT = `<script>
(function() {
	let _state = null;
	const vscodeApi = {
		postMessage(message) {
			window.parent.postMessage({ type: 'vscode-api', data: message }, '*');
		},
		getState() { return _state; },
		setState(state) { _state = state; return state; }
	};
	window.acquireVsCodeApi = function() { return vscodeApi; };
	window.addEventListener('message', function(event) {
		if (event.data && event.data.type === 'vscode-message') {
			window.dispatchEvent(new MessageEvent('message', { data: event.data.data }));
		}
	});
})();
</script>`;

function injectBridge(html: string): string {
	if (html.includes("</head>")) {
		return html.replace("</head>", `${BRIDGE_SCRIPT}</head>`);
	}
	return `${BRIDGE_SCRIPT}${html}`;
}

/**
 * Renders a VS Code extension's webview inside an iframe using Blob URLs.
 * Blob URLs bypass the parent page's CSP entirely.
 */
export function VscodeExtensionView({
	viewType,
	extensionId,
	isActive,
}: VscodeExtensionViewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [viewId, setViewId] = useState<string | null>(null);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();

	// Resolve the webview when first becoming active
	useEffect(() => {
		if (!isActive || viewId) return;

		resolveMutation.mutate(
			{ viewType, extensionPath: "" },
			{
				onSuccess: (result) => {
					if (result.viewId && result.html) {
						setViewId(result.viewId);
						// Create blob URL from HTML with bridge injected
						const bridgedHtml = injectBridge(result.html);
						const blob = new Blob([bridgedHtml], { type: "text/html" });
						setBlobUrl(URL.createObjectURL(blob));
					} else {
						setError(`Extension view "${viewType}" not found`);
					}
				},
				onError: (err) => {
					setError(err.message);
				},
			},
		);
	}, [isActive, viewId, viewType, resolveMutation.mutate]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	}, [blobUrl]);

	// Listen for messages from iframe -> forward to extension
	useEffect(() => {
		if (!viewId) return;

		const handler = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (event.data?.type === "vscode-api") {
				postMessageMutation.mutate({
					viewId,
					message: event.data.data,
				});
			}
		};

		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [viewId, postMessageMutation.mutate]);

	// Subscribe to webview events (extension -> webview messages, HTML updates)
	electronTrpc.vscodeExtensions.subscribeWebview.useSubscription(undefined, {
		enabled: isActive && !!viewId,
		onData: (event) => {
			if (!viewId || event.viewId !== viewId) return;
			if (event.type === "message") {
				iframeRef.current?.contentWindow?.postMessage(
					{ type: "vscode-message", data: event.data },
					"*",
				);
			}
			if (event.type === "html" && typeof event.data === "string") {
				// Update blob URL with new HTML
				if (blobUrl) URL.revokeObjectURL(blobUrl);
				const bridgedHtml = injectBridge(event.data);
				const blob = new Blob([bridgedHtml], { type: "text/html" });
				setBlobUrl(URL.createObjectURL(blob));
			}
		},
	});

	if (error) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				<p>{error}</p>
			</div>
		);
	}

	if (!blobUrl) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
				<p>Loading {extensionId}...</p>
			</div>
		);
	}

	return (
		<iframe
			ref={iframeRef}
			src={blobUrl}
			className="w-full h-full border-0"
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
			title={`${extensionId} webview`}
		/>
	);
}
