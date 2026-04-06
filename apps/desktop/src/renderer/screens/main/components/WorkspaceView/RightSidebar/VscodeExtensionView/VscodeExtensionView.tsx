import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
}

/**
 * Renders a VS Code extension's webview inside an iframe.
 * Uses a local HTTP server to serve the HTML (bypasses all CSP/protocol issues).
 * The server also rewrites vscode-webview-resource:// URLs to HTTP.
 */
export function VscodeExtensionView({
	viewType,
	extensionId,
	isActive,
}: VscodeExtensionViewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [viewId, setViewId] = useState<string | null>(null);
	const [iframeUrl, setIframeUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();

	// Resolve the webview when first becoming active
	useEffect(() => {
		if (!isActive || viewId) return;

		console.log(`[VscodeExtensionView] Resolving webview: ${viewType}`);
		resolveMutation.mutate(
			{ viewType, extensionPath: "" },
			{
				onSuccess: (result) => {
					console.log(
						`[VscodeExtensionView] Resolve result:`,
						JSON.stringify(result),
					);
					if (result.viewId && result.url) {
						setViewId(result.viewId);
						setIframeUrl(result.url);
						console.log(
							`[VscodeExtensionView] iframe URL set to: ${result.url}`,
						);
					} else {
						console.warn(`[VscodeExtensionView] No viewId/url in result`);
						setError(`Extension view "${viewType}" not found`);
					}
				},
				onError: (err) => {
					console.error(`[VscodeExtensionView] Resolve error:`, err);
					setError(err.message);
				},
			},
		);
	}, [isActive, viewId, viewType, resolveMutation.mutate]);

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

	// Subscribe to webview events (extension -> webview messages)
	electronTrpc.vscodeExtensions.subscribeWebview.useSubscription(undefined, {
		enabled: isActive && !!viewId,
		onData: (event) => {
			console.log(
				`[VscodeExtensionView] Subscription event: type=${event.type}, eventViewId=${event.viewId}, myViewId=${viewId}`,
			);
			if (!viewId || event.viewId !== viewId) return;
			if (event.type === "message") {
				iframeRef.current?.contentWindow?.postMessage(
					{ type: "vscode-message", data: event.data },
					"*",
				);
			}
			// Don't reload iframe on HTML updates - the initial load already has
			// the correct content, and reloading would reset extension state
		},
	});

	if (error) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				<p>{error}</p>
			</div>
		);
	}

	if (!iframeUrl) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
				<p>Loading {extensionId}...</p>
			</div>
		);
	}

	return (
		<iframe
			ref={iframeRef}
			src={iframeUrl}
			className="w-full h-full border-0"
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
			onLoad={() =>
				console.log(`[VscodeExtensionView] iframe loaded: ${iframeUrl}`)
			}
			onError={(e) => console.error(`[VscodeExtensionView] iframe error:`, e)}
			title={`${extensionId} webview`}
		/>
	);
}
