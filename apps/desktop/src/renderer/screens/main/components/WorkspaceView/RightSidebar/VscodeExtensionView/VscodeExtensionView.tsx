import { useEffect, useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "../../WorkspaceIdContext";
import {
	getPersistentVscodeExtensionHost,
	parkPersistentVscodeExtensionHost,
	setPersistentVscodeExtensionHost,
} from "./runtime";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
	persistenceId: string;
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
	persistenceId,
}: VscodeExtensionViewProps) {
	const workspaceId = useWorkspaceId();
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const persistentHostId = useMemo(
		() => `${workspaceId ?? "no-workspace"}:${persistenceId}`,
		[workspaceId, persistenceId],
	);
	const [viewId, setViewId] = useState<string | null>(() => {
		const host = getPersistentVscodeExtensionHost(persistentHostId);
		return host?.viewId ?? null;
	});
	const [iframeAttached, setIframeAttached] = useState<boolean>(() =>
		Boolean(getPersistentVscodeExtensionHost(persistentHostId)),
	);
	const [error, setError] = useState<string | null>(null);

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();
	const resolveWebviewRef = useRef(resolveMutation.mutate);
	resolveWebviewRef.current = resolveMutation.mutate;

	useEffect(() => {
		const existingHost = getPersistentVscodeExtensionHost(persistentHostId);
		iframeRef.current = existingHost?.iframe ?? null;
		setViewId(existingHost?.viewId ?? null);
		setIframeAttached(Boolean(existingHost));
		setError(null);
	}, [persistentHostId]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let cancelled = false;
		const existingHost = getPersistentVscodeExtensionHost(persistentHostId);
		if (existingHost) {
			iframeRef.current = existingHost.iframe;
			container.appendChild(existingHost.wrapper);
			setViewId(existingHost.viewId);
			setIframeAttached(true);
			setError(null);

			return () => {
				parkPersistentVscodeExtensionHost(persistentHostId);
			};
		}

		if (!isActive || !workspaceId || !workspace?.worktreePath) {
			setIframeAttached(false);
			return;
		}

		setIframeAttached(false);
		setError(null);

		resolveWebviewRef.current(
			{
				workspaceId,
				workspacePath: workspace.worktreePath,
				viewType,
				extensionPath: "",
			},
			{
				onSuccess: (result) => {
					if (cancelled) return;
					if (!result.viewId || !result.url) {
						setError(`Extension view "${viewType}" not found`);
						return;
					}

					const wrapper = document.createElement("div");
					wrapper.style.display = "flex";
					wrapper.style.flex = "1";
					wrapper.style.width = "100%";
					wrapper.style.height = "100%";
					wrapper.style.minHeight = "0";

					const iframe = document.createElement("iframe");
					iframe.src = result.url;
					iframe.className = "w-full h-full border-0";
					iframe.sandbox.add(
						"allow-scripts",
						"allow-same-origin",
						"allow-forms",
						"allow-popups",
						"allow-modals",
						"allow-downloads",
					);
					iframe.allow = "clipboard-read; clipboard-write; microphone; camera";
					iframe.title = `${extensionId} webview`;

					wrapper.appendChild(iframe);
					container.appendChild(wrapper);
					iframeRef.current = iframe;
					setPersistentVscodeExtensionHost(persistentHostId, {
						wrapper,
						iframe,
						viewId: result.viewId,
					});
					setViewId(result.viewId);
					setIframeAttached(true);
				},
				onError: (err) => {
					if (cancelled) return;
					setError(err.message);
				},
			},
		);

		return () => {
			cancelled = true;
			parkPersistentVscodeExtensionHost(persistentHostId);
		};
	}, [
		isActive,
		viewType,
		workspaceId,
		workspace?.worktreePath,
		extensionId,
		persistentHostId,
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
			enabled: !!viewId && !!workspaceId,
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

	if (!iframeAttached) {
		return (
			<div className="flex-1 flex min-h-0 flex-col overflow-hidden">
				<div ref={containerRef} className="hidden" />
				{isActive ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
						<p>Loading {extensionId}...</p>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex-1 flex min-h-0 flex-col overflow-hidden">
			<div ref={containerRef} className="flex-1 min-h-0" />
		</div>
	);
}
