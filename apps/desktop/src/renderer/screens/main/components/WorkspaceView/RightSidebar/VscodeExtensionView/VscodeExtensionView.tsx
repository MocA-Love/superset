import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "../../WorkspaceIdContext";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
	source?: "view" | "panel";
	sessionId?: string;
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
	source = "view",
	sessionId,
}: VscodeExtensionViewProps) {
	const workspaceId = useWorkspaceId();
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [viewId, setViewId] = useState<string | null>(null);
	const [iframeUrl, setIframeUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const attachMutation =
		electronTrpc.vscodeExtensions.attachWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();

	// Attach panel sessions directly; only sidebar views need resolveWebview.
	useEffect(() => {
		if (!isActive || viewId || !workspaceId) return;

		if (source === "panel") {
			if (!sessionId) {
				setError(`Extension panel "${viewType}" is no longer available`);
				return;
			}

			attachMutation.mutate(
				{ viewId: sessionId },
				{
					onSuccess: (result) => {
						if (result.viewId && result.url) {
							setViewId(result.viewId);
							setIframeUrl(result.url);
						} else {
							setError(`Extension panel "${viewType}" is no longer available`);
						}
					},
					onError: (err) => {
						setError(err.message);
					},
				},
			);
			return;
		}

		if (!workspace?.worktreePath) return;

		resolveMutation.mutate(
			{
				workspaceId,
				workspacePath: workspace.worktreePath,
				viewType,
				extensionPath: "",
			},
			{
				onSuccess: (result) => {
					if (result.viewId && result.url) {
						setViewId(result.viewId);
						setIframeUrl(result.url);
					} else {
						setError(`Extension view "${viewType}" not found`);
					}
				},
				onError: (err) => {
					setError(err.message);
				},
			},
		);
	}, [
		isActive,
		viewId,
		source,
		sessionId,
		viewType,
		workspaceId,
		workspace?.worktreePath,
		attachMutation.mutate,
		resolveMutation.mutate,
	]);

	// Listen for messages from iframe -> forward to extension
	useEffect(() => {
		if (!viewId || !workspaceId) return;

		const handler = (event: MessageEvent) => {
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (event.data?.type === "vscode-api") {
				postMessageMutation.mutate({
					workspaceId,
					viewId,
					message: event.data.data,
				});
			}
		};

		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [viewId, workspaceId, postMessageMutation.mutate]);

	// Subscribe to webview events (extension -> webview messages)
	electronTrpc.vscodeExtensions.subscribeWebview.useSubscription(
		{ workspaceId: workspaceId ?? undefined },
		{
			enabled: isActive && !!viewId && !!workspaceId,
			onData: (event) => {
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
		},
	);

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
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
			allow="clipboard-read; clipboard-write; microphone; camera"
			title={`${extensionId} webview`}
		/>
	);
}
