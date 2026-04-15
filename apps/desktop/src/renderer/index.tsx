import { initSentry } from "./lib/sentry";

initSentry();

import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDom from "react-dom/client";
import { BootErrorBoundary } from "./components/BootErrorBoundary";
import {
	cleanupBootErrorHandling,
	initBootErrorHandling,
	isBootErrorReported,
	markBootMounted,
	reportBootError,
} from "./lib/boot-errors";
import { persistentHistory } from "./lib/persistent-hash-history";
import { posthog } from "./lib/posthog";
import { electronQueryClient } from "./providers/ElectronTRPCProvider";
import { routeTree } from "./routeTree.gen";
import { useDeepLinkNavigationStore } from "./stores/deep-link-navigation";
import { useVibrancyStore } from "./stores/vibrancy";

import "./globals.css";
import "./styles/bundled-fonts.css";

const rootElement = document.querySelector("app");
initBootErrorHandling(rootElement);

// Hydrate vibrancy store early so the window chrome doesn't flash opaque when
// the user has vibrancy enabled. Fire-and-forget; failures degrade gracefully.
void useVibrancyStore.getState().hydrate();

const router = createRouter({
	routeTree,
	history: persistentHistory,
	defaultPreload: "intent",
	context: {
		queryClient: electronQueryClient,
	},
});

const unsubscribe = router.subscribe("onResolved", (event) => {
	posthog.capture("$pageview", {
		$current_url: event.toLocation.pathname,
	});
	useDeepLinkNavigationStore.getState().prunePendingWorkspaceIntent();
});

function persistDeepLinkedWorkspace(path: string): void {
	const match = /^\/workspace\/([^/?#]+)/.exec(path);
	if (!match?.[1]) {
		return;
	}

	localStorage.setItem("lastViewedWorkspaceId", decodeURIComponent(match[1]));
}

function parsePositiveInteger(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function consumeWorkspaceDeepLink(path: string): string | null {
	try {
		const url = new URL(path, "https://superset.invalid");
		const workspaceMatch = /^\/workspace\/([^/]+)\/?$/.exec(url.pathname);
		if (!workspaceMatch?.[1]) {
			return null;
		}

		const tabId = url.searchParams.get("tabId")?.trim() || undefined;
		const paneId = url.searchParams.get("paneId")?.trim() || undefined;
		const file = url.searchParams.get("file")?.trim() || undefined;
		const line = parsePositiveInteger(url.searchParams.get("line"));
		const column = parsePositiveInteger(url.searchParams.get("column"));
		if (
			!tabId &&
			!paneId &&
			!file &&
			line === undefined &&
			column === undefined
		) {
			return null;
		}

		const workspaceId = decodeURIComponent(workspaceMatch[1]);
		useDeepLinkNavigationStore.getState().replacePendingWorkspaceIntent({
			workspaceId,
			tabId,
			paneId,
			file,
			line,
			column,
			source: "deep-link",
		});
		return `/workspace/${encodeURIComponent(workspaceId)}`;
	} catch {
		return null;
	}
}

const handleDeepLink = (path: string) => {
	console.log("[deep-link] Navigating to:", path);
	persistDeepLinkedWorkspace(path);
	const resolvedPath = consumeWorkspaceDeepLink(path) ?? path;
	router.navigate({ to: resolvedPath });
};
const ipcRenderer = window.ipcRenderer as typeof window.ipcRenderer | undefined;
if (ipcRenderer) {
	ipcRenderer.on("deep-link-navigate", handleDeepLink);
} else {
	reportBootError(
		"Renderer preload not available (window.ipcRenderer missing)",
	);
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		unsubscribe();
		if (ipcRenderer) {
			ipcRenderer.off("deep-link-navigate", handleDeepLink);
		}
		cleanupBootErrorHandling();
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

if (!rootElement) {
	reportBootError("Missing <app> root element");
} else if (!isBootErrorReported()) {
	ReactDom.createRoot(rootElement).render(
		<BootErrorBoundary
			onError={(error) => reportBootError("Render failed", error)}
		>
			<RouterProvider router={router} />
		</BootErrorBoundary>,
	);
	markBootMounted();
}
