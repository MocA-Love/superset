import { webFrame } from "electron";

// react-dropzone (via file-selector) prefers DataTransferItem.getAsFileSystemHandle()
// on drop and then calls FileSystemFileHandle.getFile(), which raises NotAllowedError
// inside Electron guest web contents. Returning null from getAsFileSystemHandle()
// triggers the legacy DataTransferItem.getAsFile() / webkitGetAsEntry() fallback.
webFrame.executeJavaScript(
	`(() => {
		const proto = typeof DataTransferItem !== "undefined" ? DataTransferItem.prototype : null;
		if (proto && typeof proto.getAsFileSystemHandle === "function") {
			proto.getAsFileSystemHandle = async function() { return null; };
		}
	})();`,
);
