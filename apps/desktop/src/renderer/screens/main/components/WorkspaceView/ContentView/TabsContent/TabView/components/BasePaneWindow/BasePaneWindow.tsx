import { cn } from "@superset/ui/utils";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { MosaicWindow, MosaicWindowContext } from "react-mosaic-component";
import { useFileDragBehavior } from "renderer/hooks/useFileDragBehavior";
import {
	getInternalDraggedFilePath,
	hasInternalDraggedFilePath,
} from "renderer/lib/file-drag";
import { useDragPaneStore } from "renderer/stores/drag-pane-store";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { MosaicDropPosition } from "renderer/stores/tabs/types";
import type { SplitOrientation } from "../../hooks";
import { useSplitOrientation } from "../../hooks";
import { InternalFileDropOverlay } from "./components/InternalFileDropOverlay";

export interface PaneHandlers {
	onFocus: () => void;
	onClosePane: (e: React.MouseEvent) => void;
	onSplitPane: (e: React.MouseEvent) => void;
	onSplitPaneOpposite?: (e: React.MouseEvent) => void;
	onPopOut?: (e: React.MouseEvent) => void;
	splitOrientation: SplitOrientation;
}

function getInternalFileDropPosition(
	clientX: number,
	clientY: number,
	rect: DOMRect,
): MosaicDropPosition {
	const cx = rect.left + rect.width / 2;
	const cy = rect.top + rect.height / 2;
	const dx = clientX - cx;
	const dy = clientY - cy;

	if (Math.abs(dx) > Math.abs(dy)) {
		return dx > 0 ? "right" : "left";
	}

	return dy > 0 ? "bottom" : "top";
}

/**
 * Connects drag source for root panes (single pane in a tab).
 * react-mosaic-component skips drag connection for root panes (path=[]),
 * but we need it for cross-tab drag-and-drop.
 */
function RootDraggable({ children }: { children: React.ReactNode }) {
	const { mosaicWindowActions } = useContext(MosaicWindowContext);
	return mosaicWindowActions.connectDragSource(
		<div className="h-full w-full">{children}</div>,
	);
}

interface BasePaneWindowProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	splitPaneHorizontal?: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
	) => void;
	splitPaneVertical?: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	onPopOut?: () => void;
	renderToolbar: (handlers: PaneHandlers) => React.ReactElement;
	children: React.ReactNode;
	contentClassName?: string;
	draggable?: boolean;
	/** When true, the toolbar row is hidden (e.g. webview HTML fullscreen). */
	hideToolbar?: boolean;
}

export function BasePaneWindow({
	paneId,
	path,
	tabId,
	splitPaneAuto,
	splitPaneHorizontal,
	splitPaneVertical,
	removePane,
	setFocusedPane,
	onPopOut,
	renderToolbar,
	children,
	contentClassName = "w-full h-full overflow-hidden",
	draggable = true,
	hideToolbar = false,
}: BasePaneWindowProps) {
	const isActive = useTabsStore((s) => s.focusedPaneIds[tabId] === paneId);
	const workspaceId = useTabsStore(
		(s) => s.tabs.find((tab) => tab.id === tabId)?.workspaceId ?? null,
	);
	const workspaceRunState = useTabsStore(
		(s) => s.panes[paneId]?.workspaceRun?.state,
	);
	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const containerRef = useRef<HTMLDivElement>(null);
	const splitOrientation = useSplitOrientation(containerRef);
	const isDragging = useDragPaneStore((s) => s.draggingPaneId !== null);
	const isTabDragging = useDragPaneStore((s) => s.isTabDragging);
	const isResizing = useDragPaneStore((s) => s.isResizing);
	const setDragging = useDragPaneStore((s) => s.setDragging);
	const clearDragging = useDragPaneStore((s) => s.clearDragging);
	const fileDragBehavior = useFileDragBehavior();
	const internalFileDragDepthRef = useRef(0);
	const internalFileDropPositionRef = useRef<MosaicDropPosition | null>(null);
	const [internalFileDropPosition, setInternalFileDropPosition] =
		useState<MosaicDropPosition | null>(null);

	const handleFocus = () => {
		setFocusedPane(tabId, paneId);
	};

	const handleClosePane = (e: React.MouseEvent) => {
		e.stopPropagation();
		removePane(paneId);
	};

	const handleSplitPane = (e: React.MouseEvent) => {
		e.stopPropagation();
		const container = containerRef.current;
		if (!container) return;

		const { width, height } = container.getBoundingClientRect();
		splitPaneAuto(tabId, paneId, { width, height }, path);
	};

	const handleSplitPaneOpposite =
		splitPaneHorizontal && splitPaneVertical
			? (e: React.MouseEvent) => {
					e.stopPropagation();
					if (splitOrientation === "vertical") {
						splitPaneHorizontal(tabId, paneId, path);
					} else {
						splitPaneVertical(tabId, paneId, path);
					}
				}
			: undefined;

	const handlePopOut = onPopOut
		? (e: React.MouseEvent) => {
				e.stopPropagation();
				onPopOut();
			}
		: undefined;

	const handlers: PaneHandlers = {
		onFocus: handleFocus,
		onClosePane: handleClosePane,
		onSplitPane: handleSplitPane,
		onSplitPaneOpposite: handleSplitPaneOpposite,
		onPopOut: handlePopOut,
		splitOrientation,
	};

	const isRoot = path.length === 0;

	const resetInternalFileDragState = useCallback(() => {
		internalFileDragDepthRef.current = 0;
		internalFileDropPositionRef.current = null;
		setInternalFileDropPosition(null);
	}, []);

	const isInternalFileViewerDropEnabled =
		fileDragBehavior === "open-file-viewer" && workspaceId !== null;

	const updateInternalFileDropPosition = useCallback(
		(event: React.DragEvent<HTMLDivElement>): MosaicDropPosition => {
			const nextPosition = getInternalFileDropPosition(
				event.clientX,
				event.clientY,
				event.currentTarget.getBoundingClientRect(),
			);

			if (nextPosition !== internalFileDropPositionRef.current) {
				internalFileDropPositionRef.current = nextPosition;
				setInternalFileDropPosition(nextPosition);
			}

			return nextPosition;
		},
		[],
	);

	useEffect(() => {
		if (!isInternalFileViewerDropEnabled) {
			resetInternalFileDragState();
		}
	}, [isInternalFileViewerDropEnabled, resetInternalFileDragState]);

	const handleInternalFileDragEnterCapture = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (
				!isInternalFileViewerDropEnabled ||
				!hasInternalDraggedFilePath(event.dataTransfer)
			) {
				return;
			}

			internalFileDragDepthRef.current += 1;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "copy";
			updateInternalFileDropPosition(event);
		},
		[isInternalFileViewerDropEnabled, updateInternalFileDropPosition],
	);

	const handleInternalFileDragOverCapture = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (
				!isInternalFileViewerDropEnabled ||
				!hasInternalDraggedFilePath(event.dataTransfer)
			) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "copy";
			updateInternalFileDropPosition(event);
		},
		[isInternalFileViewerDropEnabled, updateInternalFileDropPosition],
	);

	const handleInternalFileDragLeaveCapture = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (
				!isInternalFileViewerDropEnabled ||
				!hasInternalDraggedFilePath(event.dataTransfer)
			) {
				return;
			}

			event.stopPropagation();
			internalFileDragDepthRef.current = Math.max(
				0,
				internalFileDragDepthRef.current - 1,
			);

			if (internalFileDragDepthRef.current === 0) {
				resetInternalFileDragState();
			}
		},
		[isInternalFileViewerDropEnabled, resetInternalFileDragState],
	);

	const handleInternalFileDropCapture = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (
				!isInternalFileViewerDropEnabled ||
				!workspaceId ||
				!hasInternalDraggedFilePath(event.dataTransfer)
			) {
				return;
			}

			const filePath = getInternalDraggedFilePath(event.dataTransfer);
			if (!filePath) {
				resetInternalFileDragState();
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			const dropPosition =
				internalFileDropPositionRef.current ??
				updateInternalFileDropPosition(event);

			addFileViewerPane(workspaceId, {
				filePath,
				isPinned: true,
				openInNewTab: false,
				reuseExisting: "none",
				relativeToPaneId: paneId,
				relativeToTabId: tabId,
				relativeSplitPosition: dropPosition,
				useRightSidebarOpenViewWidth: true,
			});
			resetInternalFileDragState();
		},
		[
			addFileViewerPane,
			isInternalFileViewerDropEnabled,
			paneId,
			resetInternalFileDragState,
			tabId,
			updateInternalFileDropPosition,
			workspaceId,
		],
	);

	return (
		<MosaicWindow<string>
			path={path}
			title=""
			draggable={draggable && !hideToolbar}
			renderToolbar={() =>
				hideToolbar ? null : isRoot && draggable ? (
					<RootDraggable>{renderToolbar(handlers)}</RootDraggable>
				) : (
					renderToolbar(handlers)
				)
			}
			className={cn(
				isActive && "mosaic-window-focused",
				workspaceRunState && `workspace-run-pane-${workspaceRunState}`,
			)}
			onDragStart={() => setDragging(paneId, tabId)}
			onDragEnd={() => clearDragging()}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Focus handler for pane */}
			<div
				ref={containerRef}
				className={cn("relative", contentClassName)}
				style={
					isDragging || isTabDragging || isResizing
						? { pointerEvents: "none" }
						: undefined
				}
				onDragEnterCapture={handleInternalFileDragEnterCapture}
				onDragOverCapture={handleInternalFileDragOverCapture}
				onDragLeaveCapture={handleInternalFileDragLeaveCapture}
				onDropCapture={handleInternalFileDropCapture}
				onClick={handleFocus}
			>
				<InternalFileDropOverlay position={internalFileDropPosition} />
				{children}
			</div>
		</MosaicWindow>
	);
}
