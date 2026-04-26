export interface FilePaneData {
	filePath: string;
	mode: "editor" | "diff" | "preview";
	/** FORK NOTE: carried for memo tabs so the tab title shows the
	 * memo-derived displayName instead of the random filename. */
	displayName?: string;
	line?: number;
	column?: number;
	cursorRequestId?: string;
	language?: string;
	viewId?: string;
	forceViewId?: string;
}

export interface TerminalPaneData {
	terminalId: string;
	workspaceId?: string;
}

export interface ChatPaneData {
	sessionId: string | null;
	/**
	 * Transient initial launch config for a freshly-opened chat pane.
	 * Cleared by the chat pane on first consume. Set by the V2 workspace
	 * page's useConsumePendingLaunch when a pending chat launch exists.
	 */
	launchConfig?: {
		initialPrompt?: string;
		initialFiles?: Array<{
			data: string;
			mediaType: string;
			filename?: string;
		}>;
		model?: string;
		taskSlug?: string;
	} | null;
}

export interface BrowserPaneData {
	url: string;
	mode: "docs" | "preview" | "generic";
	reloadToken?: string;
	/** FORK NOTE: Set on hard reload to force cache-busting via query param */
	hardReloadToken?: string;
	pageTitle?: string;
	faviconUrl?: string | null;
}

export interface DevtoolsPaneData {
	targetPaneId: string;
	targetTitle: string;
}

export interface DiffPaneData {
	path: string;
	collapsedFiles: string[];
}

export interface CommentPaneData {
	commentId: string;
	authorLogin: string;
	avatarUrl?: string;
	body: string;
	url?: string;
	path?: string;
	line?: number;
}

export type PaneViewerData =
	| FilePaneData
	| TerminalPaneData
	| ChatPaneData
	| BrowserPaneData
	| DevtoolsPaneData
	| DiffPaneData
	| CommentPaneData;
