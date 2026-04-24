import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useScratchTabsStore } from "renderer/screens/scratch/ScratchView";
import { useTabsStore } from "renderer/stores/tabs";

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
 * - Subscribe to two tRPC channels the main process emits from
 *   `fileIntakeEmitter` (file-intake/index.ts) when an OS drop / argv /
 *   open-file event resolves to either a registered workspace target or a
 *   scratch target. AGENTS.md requires tRPC for IPC, so we route through the
 *   trpc-electron subscription machinery rather than raw ipcRenderer.
 * - Intercept OS drag-and-drop onto the window so the user can drop files
 *   from Finder / Explorer directly into the app.
 *
 * Returns a cleanup function to tear down listeners / subscriptions (used
 * for HMR).
 */
export function installFileIntakeClient(router: NavRouter): () => void {
	const workspaceSub =
		electronTrpcClient.scratch.onOpenWorkspaceBatch.subscribe(undefined, {
			onData: (payload) => {
				if (!payload.workspaceId) return;
				const paths = payload.absolutePaths.filter(
					(v): v is string => typeof v === "string" && v.length > 0,
				);

				// Always navigate — even for an empty paths batch, which is the
				// "drag a folder that's a registered workspace" case (Q2:A with
				// no specific file). Opening the workspace is the whole
				// user-visible effect in that scenario.
				void router.navigate({
					to: "/workspace/$workspaceId",
					params: { workspaceId: payload.workspaceId },
				});

				if (paths.length === 0) return;

				const addFileViewerPane = useTabsStore.getState().addFileViewerPane;
				for (const absolutePath of paths) {
					addFileViewerPane(payload.workspaceId, {
						filePath: absolutePath,
						openInNewTab: true,
						reuseExisting: "workspace",
					});
				}
			},
			onError: (err) => {
				console.error("[file-intake] workspace batch subscription error:", err);
			},
		});

	const scratchSub = electronTrpcClient.scratch.onOpenScratchBatch.subscribe(
		undefined,
		{
			onData: (payload) => {
				const paths = payload.absolutePaths.filter(
					(v): v is string => typeof v === "string" && v.length > 0,
				);
				if (paths.length === 0) return;
				useScratchTabsStore.getState().openPaths(paths);
				void router.navigate({ to: "/scratch" });
			},
			onError: (err) => {
				console.error("[file-intake] scratch batch subscription error:", err);
			},
		},
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
		workspaceSub.unsubscribe();
		scratchSub.unsubscribe();
		document.removeEventListener("dragover", onDragOver, false);
		document.removeEventListener("drop", onDrop, false);
	};
}
