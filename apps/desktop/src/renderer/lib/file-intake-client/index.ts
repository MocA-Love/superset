import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useScratchTabsStore } from "renderer/screens/scratch/ScratchView";
import { useTabsStore } from "renderer/stores/tabs";

type WorkspaceBatchPayload = {
	workspaceId: string;
	absolutePaths: string[];
};

type ScratchBatchPayload = {
	absolutePaths: string[];
};

interface IpcRendererAPI {
	on?: (channel: string, listener: (...args: unknown[]) => void) => void;
	off?: (channel: string, listener: (...args: unknown[]) => void) => void;
}

/** Minimal router surface we need here. Avoids a hard coupling to the full
 *  TanStack router generic, which is awkward to type in an app context. */
interface NavRouter {
	navigate: (opts: {
		to: string;
		params?: Record<string, string>;
	}) => void | Promise<void>;
}

/**
 * Wire the renderer side of the file-intake pipeline:
 *
 * - Listen for main-process follow-up IPC events so a multi-file drop that
 *   navigates to a workspace can still open additional tabs afterwards.
 * - Intercept OS drag-and-drop onto the window so the user can drop files
 *   from Finder / Explorer directly into the app.
 *
 * Returns a cleanup function to tear down all listeners (used for HMR).
 */
export function installFileIntakeClient(router: NavRouter): () => void {
	const ipcRenderer = (
		window as unknown as {
			ipcRenderer?: IpcRendererAPI;
		}
	).ipcRenderer;

	const handleWorkspaceBatch = (payload: unknown) => {
		const p = payload as WorkspaceBatchPayload | undefined;
		if (!p || !p.workspaceId || !Array.isArray(p.absolutePaths)) return;
		const paths = p.absolutePaths.filter(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (paths.length === 0) return;

		// Navigate first so KeepAliveWorkspaces mounts the target workspace page.
		// addFileViewerPane writes into the tabs store directly; the page picks
		// the state up as soon as it renders, so we don't need the
		// DeepLinkNavigation intent dance here (which only supports one file
		// and overwrites on the second call — Q5:A would break).
		void router.navigate({
			to: "/workspace/$workspaceId",
			params: { workspaceId: p.workspaceId },
		});

		const addFileViewerPane = useTabsStore.getState().addFileViewerPane;
		for (const absolutePath of paths) {
			addFileViewerPane(p.workspaceId, {
				filePath: absolutePath,
				openInNewTab: true,
				reuseExisting: "workspace",
			});
		}
	};

	const handleScratchBatch = (payload: unknown) => {
		const p = payload as ScratchBatchPayload | undefined;
		if (!p || !Array.isArray(p.absolutePaths)) return;
		const paths = p.absolutePaths.filter(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (paths.length === 0) return;
		useScratchTabsStore.getState().openPaths(paths);
		void router.navigate({ to: "/scratch" });
	};

	ipcRenderer?.on?.(
		"file-intake:open-workspace-batch",
		handleWorkspaceBatch as (...args: unknown[]) => void,
	);
	ipcRenderer?.on?.(
		"file-intake:open-scratch-batch",
		handleScratchBatch as (...args: unknown[]) => void,
	);

	const extractDroppedPaths = (event: DragEvent): string[] => {
		const webUtils = window.webUtils;
		if (!webUtils?.getPathForFile) return [];
		const files = event.dataTransfer?.files;
		if (!files || files.length === 0) return [];
		const paths: string[] = [];
		for (const file of Array.from(files)) {
			try {
				const p = webUtils.getPathForFile(file);
				if (p) paths.push(p);
			} catch {
				// Web-originated drops (e.g., dragging from a browser tab inside a
				// BrowserPane) have no OS path. Ignore — v1 is OS drops only.
			}
		}
		return paths;
	};

	const hasFilePayload = (event: DragEvent): boolean => {
		const types = event.dataTransfer?.types;
		if (!types) return false;
		return Array.from(types).includes("Files");
	};

	const onDragOver = (event: DragEvent) => {
		// Bubble-phase fallback: existing drop zones (Chat attachments, Terminal
		// paths, Sidebar project drops, TODO image drops, etc.) run in bubble
		// phase and call preventDefault when they handle the drop. We only
		// engage for OS file drags that nobody else claimed.
		if (event.defaultPrevented) return;
		if (!hasFilePayload(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	};

	const onDrop = (event: DragEvent) => {
		if (event.defaultPrevented) return;
		if (!hasFilePayload(event)) return;
		event.preventDefault();
		const paths = extractDroppedPaths(event);
		if (paths.length === 0) return;
		electronTrpcClient.scratch.ingestDroppedPaths
			.mutate({ absolutePaths: paths })
			.catch((err) => {
				console.error("[file-intake] ingestDroppedPaths failed:", err);
			});
	};

	// Bubble phase + defaultPrevented guard: existing drop zones (prompt-input,
	// Terminal, SidebarDropZone, StartView, ScriptsEditor, etc.) get first
	// refusal. Only the uncaught drops — empty editor gutters, scratch view,
	// workspace tab background — fall through to us.
	document.addEventListener("dragover", onDragOver, false);
	document.addEventListener("drop", onDrop, false);

	return () => {
		ipcRenderer?.off?.(
			"file-intake:open-workspace-batch",
			handleWorkspaceBatch as (...args: unknown[]) => void,
		);
		ipcRenderer?.off?.(
			"file-intake:open-scratch-batch",
			handleScratchBatch as (...args: unknown[]) => void,
		);
		document.removeEventListener("dragover", onDragOver, false);
		document.removeEventListener("drop", onDrop, false);
	};
}
