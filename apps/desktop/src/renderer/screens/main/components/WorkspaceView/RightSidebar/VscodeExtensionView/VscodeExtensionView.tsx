import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
}

/**
 * Renders a VS Code extension's webview inside an iframe.
 * Uses vscode-webview:// protocol to serve HTML with its own CSP.
 * Bridges postMessage between the iframe and the extension host via tRPC.
 */
export function VscodeExtensionView({
	viewType,
	extensionId,
	isActive,
}: VscodeExtensionViewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [viewId, setViewId] = useState<string | null>(null);
	const [webviewUrl, setWebviewUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();

	// Resolve the webview when first becoming active
	useEffect(() => {
		if (!isActive || viewId) return;

		resolveMutation.mutate(
			{
				viewType,
				extensionPath: "",
			},
			{
				onSuccess: (result) => {
					if (result.viewId && result.url) {
						setViewId(result.viewId);
						setWebviewUrl(result.url);
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

	// Listen for messages from iframe -> forward to extension
	useEffect(() => {
		if (!viewId) return;

		const handler = (event: MessageEvent) => {
			// Verify message source is our iframe
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

	// Subscribe to webview events for message forwarding (extension -> webview)
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
			// HTML updates trigger protocol store update on main process side
			// iframe will get fresh content on next load
		},
	});

	if (error) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				<p>{error}</p>
			</div>
		);
	}

	if (!webviewUrl) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
				<p>Loading {extensionId}...</p>
			</div>
		);
	}

	return (
		<iframe
			ref={iframeRef}
			src={webviewUrl}
			className="w-full h-full border-0"
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
			title={`${extensionId} webview`}
		/>
	);
}
