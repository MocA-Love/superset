import { app, BrowserWindow, shell } from "electron";
import { loadReactDevToolsExtension } from "main/lib/extensions";
import { PLATFORM } from "shared/constants";
import { makeAppId } from "shared/utils";
import { ignoreConsoleWarnings } from "../../utils/ignore-console-warnings";

ignoreConsoleWarnings(["Manifest version 2 is deprecated"]);

export async function makeAppSetup(
	createWindow: () => Promise<BrowserWindow>,
	restoreWindows?: () => Promise<void>,
) {
	await loadReactDevToolsExtension();

	// Restore windows from previous session if available
	if (restoreWindows) {
		await restoreWindows();
	}

	// If no windows were restored, create a new one
	const existingWindows = BrowserWindow.getAllWindows();
	let window: BrowserWindow;
	if (existingWindows.length > 0) {
		window = existingWindows[0];
	} else {
		window = await createWindow();
	}

	app.on("activate", async () => {
		const windows = BrowserWindow.getAllWindows();

		if (!windows.length) {
			window = await createWindow();
		} else {
			// Show hidden windows (macOS hide-to-tray) or restore minimized ones
			for (window of windows.reverse()) {
				window.show();
				window.focus();
			}
		}
	});

	app.on("web-contents-created", (_, contents) => {
		if (contents.getType() === "webview") return;
		contents.on("will-navigate", (event, url) => {
			// Always prevent in-app navigation for external URLs
			if (url.startsWith("http://") || url.startsWith("https://")) {
				event.preventDefault();
				shell.openExternal(url);
			}
		});
	});

	// macOS: keep the app alive (standard behavior) — tray/dock provide re-entry.
	// Windows/Linux: quit the app UI. Host-services survive via releaseAll()
	// and will be re-adopted on next launch.
	app.on("window-all-closed", () => !PLATFORM.IS_MAC && app.quit());

	return window;
}

PLATFORM.IS_LINUX && app.disableHardwareAcceleration();

// macOS Sequoia+: occluded window throttling can corrupt GPU compositor layers
if (PLATFORM.IS_MAC) {
	app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

PLATFORM.IS_WINDOWS &&
	app.setAppUserModelId(
		process.env.NODE_ENV === "development" ? process.execPath : makeAppId(),
	);

app.commandLine.appendSwitch("force-color-profile", "srgb");

// Always expose CDP on a loopback port so the browser-mcp bridge can
// hand external browser automation MCPs (chrome-devtools-mcp,
// browser-use, playwright-mcp, …) a filtered per-pane CDP endpoint.
// DESKTOP_AUTOMATION_PORT overrides the random-port default for the
// existing desktop-automation integration. `*` here is safe because
// the actual gate is at the browser-mcp-bridge proxy level
// (token-authenticated, loopback-only).
const cdpPort = process.env.DESKTOP_AUTOMATION_PORT ?? "0";
app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
app.commandLine.appendSwitch("remote-allow-origins", "*");
