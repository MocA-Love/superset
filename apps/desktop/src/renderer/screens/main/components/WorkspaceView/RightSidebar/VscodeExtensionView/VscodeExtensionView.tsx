import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	generateVscodeThemeCss,
	getVscodeBodyClass,
} from "./vscode-theme-bridge";

interface VscodeExtensionViewProps {
	viewType: string;
	extensionId: string;
	isActive: boolean;
}

/**
 * Renders a VS Code extension's webview inside an iframe.
 * Bridges postMessage between the iframe and the extension host via tRPC.
 * Injects Superset theme as VS Code CSS variables.
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
	const [themeCss, setThemeCss] = useState("");
	const [bodyClass, setBodyClass] = useState("vscode-dark");

	const resolveMutation =
		electronTrpc.vscodeExtensions.resolveWebview.useMutation();
	const postMessageMutation =
		electronTrpc.vscodeExtensions.postMessageToExtension.useMutation();

	// Generate theme CSS on mount and when theme changes
	useEffect(() => {
		const updateTheme = () => {
			setThemeCss(generateVscodeThemeCss());
			setBodyClass(getVscodeBodyClass());
		};
		updateTheme();

		// Watch for theme changes via class mutations on <html>
		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (
					m.type === "attributes" &&
					(m.attributeName === "class" || m.attributeName === "style")
				) {
					updateTheme();
					break;
				}
			}
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "style"],
		});

		return () => observer.disconnect();
	}, []);

	// Subscribe to webview events
	electronTrpc.vscodeExtensions.subscribeWebview.useSubscription(undefined, {
		enabled: isActive && !!viewId,
		onData: (event) => {
			if (!viewId) return;
			if (event.viewId !== viewId) return;

			if (event.type === "html") {
				setHtml(event.data as string);
			} else if (event.type === "message") {
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
				extensionPath: "",
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
	}, [isActive, viewId, viewType, resolveMutation.mutate]);

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
	}, [viewId, postMessageMutation.mutate]);

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

	const bridgedHtml = injectVscodeApiBridge(html, themeCss, bodyClass);

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
 * Injects acquireVsCodeApi() bridge + theme CSS into extension webview HTML.
 */
function injectVscodeApiBridge(
	html: string,
	themeCss: string,
	bodyClass: string,
): string {
	const bridgeScript = `
<style>${themeCss}</style>
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

	window.addEventListener('message', function(event) {
		if (event.data && event.data.type === 'vscode-message') {
			window.dispatchEvent(new MessageEvent('message', { data: event.data.data }));
		}
	});
})();
</script>`;

	// Replace body class for theme detection
	const themedHtml = html.replace(
		/<body([^>]*)>/,
		`<body$1 class="${bodyClass}">`,
	);

	if (themedHtml.includes("</head>")) {
		return themedHtml.replace("</head>", `${bridgeScript}</head>`);
	}
	if (themedHtml.includes("<body")) {
		return themedHtml.replace(
			/<body([^>]*)>/,
			`<body$1 class="${bodyClass}">${bridgeScript}`,
		);
	}
	return `${bridgeScript}${themedHtml}`;
}
