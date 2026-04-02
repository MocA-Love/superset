const webviewRegistry = new Map<string, Electron.WebviewTag>();
const wrapperRegistry = new Map<string, HTMLDivElement>();
const registeredWebContentsIds = new Map<string, number>();
const domReadyPaneIds = new Set<string>();
const pendingNavigationUrls = new Map<string, string>();

export function getPersistentWebview(
	paneId: string,
): Electron.WebviewTag | undefined {
	return webviewRegistry.get(paneId);
}

export function setPersistentWebview(
	paneId: string,
	webview: Electron.WebviewTag,
): void {
	webviewRegistry.set(paneId, webview);
}

export function deletePersistentWebview(paneId: string): void {
	webviewRegistry.delete(paneId);
}

export function markPersistentWebviewDomReady(paneId: string): void {
	domReadyPaneIds.add(paneId);
}

export function clearPersistentWebviewDomReady(paneId: string): void {
	domReadyPaneIds.delete(paneId);
}

export function getPersistentWrapper(
	paneId: string,
): HTMLDivElement | undefined {
	return wrapperRegistry.get(paneId);
}

export function setPersistentWrapper(
	paneId: string,
	wrapper: HTMLDivElement,
): void {
	wrapperRegistry.set(paneId, wrapper);
}

export function deletePersistentWrapper(paneId: string): void {
	wrapperRegistry.delete(paneId);
}

export function getRegisteredWebContentsId(
	paneId: string,
): number | undefined {
	return registeredWebContentsIds.get(paneId);
}

export function setRegisteredWebContentsId(
	paneId: string,
	webContentsId: number,
): void {
	registeredWebContentsIds.set(paneId, webContentsId);
}

export function deleteRegisteredWebContentsId(paneId: string): void {
	registeredWebContentsIds.delete(paneId);
}

export function getPendingPersistentWebviewNavigation(
	paneId: string,
): string | undefined {
	return pendingNavigationUrls.get(paneId);
}

export function clearPendingPersistentWebviewNavigation(paneId: string): void {
	pendingNavigationUrls.delete(paneId);
}

export function forEachPersistentWebview(
	callback: (webview: Electron.WebviewTag) => void,
): void {
	for (const webview of webviewRegistry.values()) {
		callback(webview);
	}
}

export function sanitizeUrl(url: string): string {
	if (/^https?:\/\//i.test(url) || url.startsWith("about:")) {
		return url;
	}
	if (url.startsWith("localhost") || url.startsWith("127.0.0.1")) {
		return `http://${url}`;
	}
	if (url.includes(".")) {
		return `https://${url}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}

function normalizeUrlForComparison(url: string): string {
	const sanitizedUrl = sanitizeUrl(url);

	if (sanitizedUrl.startsWith("about:")) {
		return sanitizedUrl;
	}

	try {
		return new URL(sanitizedUrl).href;
	} catch {
		return sanitizedUrl;
	}
}

export function navigatePersistentWebview(
	paneId: string,
	url: string,
): boolean {
	const targetUrl = sanitizeUrl(url);
	const webview = getPersistentWebview(paneId);

	if (!webview || !webview.isConnected || !domReadyPaneIds.has(paneId)) {
		pendingNavigationUrls.set(paneId, targetUrl);
		return false;
	}

	try {
		const currentUrl = webview.getURL();
		if (
			currentUrl &&
			normalizeUrlForComparison(currentUrl) ===
				normalizeUrlForComparison(targetUrl)
		) {
			pendingNavigationUrls.delete(paneId);
			return true;
		}
	} catch {
		pendingNavigationUrls.set(paneId, targetUrl);
		return false;
	}

	try {
		webview.loadURL(targetUrl);
		pendingNavigationUrls.delete(paneId);
		return true;
	} catch {
		pendingNavigationUrls.set(paneId, targetUrl);
		return false;
	}
}
