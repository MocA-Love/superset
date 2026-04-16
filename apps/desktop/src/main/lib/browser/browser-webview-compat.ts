import { join } from "node:path";
import { session } from "electron";

const APP_BROWSER_PARTITION = "persist:superset";

// Register a session-level preload for the embedded browser partition.
// It neutralizes File System Access API entrypoints that Electron cannot
// satisfy inside guest web contents: react-dropzone (via file-selector)
// prefers DataTransferItem.getAsFileSystemHandle() on drop and then calls
// FileSystemFileHandle.getFile(), which raises
//   NotAllowedError: Failed to execute 'getFile' on 'FileSystemFileHandle':
//   The request is not allowed by the user agent or the platform in the
//   current context.
// Returning null from getAsFileSystemHandle() makes the library fall back
// to the legacy DataTransferItem.getAsFile() / webkitGetAsEntry() path.

let initialized = false;

export function initializeBrowserWebviewCompat(): void {
	if (initialized) {
		return;
	}

	const preloadPath = join(__dirname, "../preload/webview-compat.js");
	const browserSession = session.fromPartition(APP_BROWSER_PARTITION);
	const existing = browserSession.getPreloads();
	if (!existing.includes(preloadPath)) {
		browserSession.setPreloads([...existing, preloadPath]);
	}
	initialized = true;
}
