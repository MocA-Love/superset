import { useEffect } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { generateVscodeThemeCss } from "../RightSidebar/VscodeExtensionView/vscode-theme-bridge";

/**
 * When enabled, syncs Superset's current theme to the VS Code extension
 * webview server as CSS variables. The server injects these into every
 * webview page instead of the default VS Code Dark+ theme.
 */
export function useVscodeThemeSync(enabled: boolean) {
	const setThemeCssMutation =
		electronTrpc.vscodeExtensions.setThemeCss.useMutation();

	useEffect(() => {
		if (!enabled) {
			// Reset to default dark theme
			setThemeCssMutation.mutate({ css: null });
			return;
		}

		const sendTheme = () => {
			const css = generateVscodeThemeCss();
			setThemeCssMutation.mutate({ css: `<style>${css}</style>` });
		};

		// Send initial theme
		sendTheme();

		// Watch for theme changes via class/style mutations on <html>
		const observer = new MutationObserver(() => {
			sendTheme();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "style"],
		});

		return () => {
			observer.disconnect();
			setThemeCssMutation.mutate({ css: null });
		};
	}, [
		enabled, // Reset to default dark theme
		setThemeCssMutation.mutate,
	]); // eslint-disable-line react-hooks/exhaustive-deps
}
