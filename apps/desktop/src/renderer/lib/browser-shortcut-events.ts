import type { BrowserShortcutAction } from "shared/browser-shortcuts";

const BROWSER_SHORTCUT_EVENT = "superset:browser-shortcut";

interface BrowserShortcutEventDetail {
	action: BrowserShortcutAction;
}

export function dispatchBrowserShortcutEvent(
	action: BrowserShortcutAction,
): void {
	if (typeof window === "undefined") return;

	window.dispatchEvent(
		new CustomEvent<BrowserShortcutEventDetail>(BROWSER_SHORTCUT_EVENT, {
			detail: { action },
		}),
	);
}

export function addBrowserShortcutListener(
	listener: (action: BrowserShortcutAction) => void,
): () => void {
	if (
		typeof window === "undefined" ||
		typeof window.addEventListener !== "function"
	) {
		return () => {};
	}

	const handleEvent = (event: Event) => {
		const detail = (event as CustomEvent<BrowserShortcutEventDetail>).detail;
		if (!detail) return;
		listener(detail.action);
	};

	window.addEventListener(BROWSER_SHORTCUT_EVENT, handleEvent);

	return () => {
		window.removeEventListener(BROWSER_SHORTCUT_EVENT, handleEvent);
	};
}
