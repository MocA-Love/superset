import "@sentry/electron/preload";

import { contextBridge, ipcRenderer, webUtils } from "electron";
import { exposeElectronTRPC } from "trpc-electron/main";

declare const __APP_VERSION__: string;

declare global {
	interface Window {
		App: typeof API;
		ipcRenderer: typeof ipcRendererAPI;
		webUtils: {
			getPathForFile: (file: File) => string;
		};
	}
}

// Tearoff: synchronously fetch tab data BEFORE React/Zustand initialize
const tearoffWindowId = (() => {
	const arg = process.argv.find((a) => a.startsWith("--tearoff-window-id="));
	return arg ? arg.split("=")[1] : null;
})();
// biome-ignore lint/suspicious/noExplicitAny: tearoff data is untyped at preload level
const tearoffData: any = tearoffWindowId
	? ipcRenderer.sendSync("get-tearoff-data", tearoffWindowId)
	: null;

const API = {
	sayHelloFromBridge: () => console.log("\nHello from bridgeAPI! 👋\n\n"),
	username: process.env.USER,
	appVersion: __APP_VERSION__,
	tearoffWindowId,
	tearoffData,
};

// Store mapping of user listeners to wrapped listeners for proper cleanup
type IpcListener = (...args: unknown[]) => void;
const listenerMap = new WeakMap<IpcListener, IpcListener>();

/**
 * IPC renderer API
 * Note: Primary IPC communication uses tRPC. This API is for low-level IPC needs.
 */
const ipcRendererAPI = {
	// biome-ignore lint/suspicious/noExplicitAny: IPC invoke requires any for dynamic channel types
	invoke: (channel: string, ...args: any[]) =>
		ipcRenderer.invoke(channel, ...args),

	// biome-ignore lint/suspicious/noExplicitAny: IPC send requires any for dynamic channel types
	send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),

	// biome-ignore lint/suspicious/noExplicitAny: IPC listener requires any for dynamic event types
	on: (channel: string, listener: (...args: any[]) => void) => {
		// biome-ignore lint/suspicious/noExplicitAny: IPC event wrapper requires any
		const wrappedListener = (_event: any, ...args: any[]) => {
			listener(...args);
		};
		listenerMap.set(listener, wrappedListener);
		ipcRenderer.on(channel, wrappedListener);
	},

	// biome-ignore lint/suspicious/noExplicitAny: IPC listener requires any for dynamic event types
	off: (channel: string, listener: (...args: any[]) => void) => {
		const wrappedListener = listenerMap.get(listener as IpcListener);
		if (wrappedListener) {
			// biome-ignore lint/suspicious/noExplicitAny: Electron IPC API requires this cast
			ipcRenderer.removeListener(channel, wrappedListener as any);
			listenerMap.delete(listener as IpcListener);
		}
	},
};

// Expose electron-trpc IPC channel FIRST (must be before contextBridge calls)
exposeElectronTRPC();

contextBridge.exposeInMainWorld("App", API);
contextBridge.exposeInMainWorld("ipcRenderer", ipcRendererAPI);
contextBridge.exposeInMainWorld("webUtils", {
	getPathForFile: (file: File) => webUtils.getPathForFile(file),
});
