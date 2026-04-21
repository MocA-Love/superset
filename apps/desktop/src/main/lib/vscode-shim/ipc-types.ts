/**
 * Typed IPC message definitions for communication between
 * the main process and per-workspace extension host worker processes.
 */

/** Messages sent FROM main process TO worker */
export type MainToWorkerMessage =
	| { type: "set-active-editor"; filePath: string | null; languageId?: string }
	| { type: "set-workspace-path"; workspacePath: string }
	| {
			type: "resolve-webview";
			requestId: string;
			viewType: string;
			extensionPath: string;
	  }
	| { type: "post-message"; viewId: string; message: unknown }
	| { type: "shutdown" }
	| { type: "dialog-result"; requestId: string; selectedIndex: number }
	| {
			type: "open-dialog-result";
			requestId: string;
			filePaths: string[] | null;
	  };

/** Messages sent FROM worker TO main process */
export type WorkerToMainMessage =
	| { type: "ready" }
	| {
			type: "webview-event";
			event: {
				viewId: string;
				type: "html" | "message" | "title" | "dispose" | "panel-created";
				data: unknown;
			};
	  }
	| {
			type: "resolve-webview-result";
			requestId: string;
			viewId: string | null;
			html: string | null;
	  }
	| { type: "open-file"; filePath: string; line?: number }
	| {
			type: "open-diff";
			leftUri: string;
			rightUri: string;
			title?: string;
			leftContent?: string;
	  }
	| {
			type: "show-dialog";
			requestId: string;
			method:
				| "showInformationMessage"
				| "showWarningMessage"
				| "showErrorMessage";
			message: string;
			items: string[];
	  }
	| {
			type: "show-quickpick";
			requestId: string;
			labels: string[];
			placeHolder?: string;
	  }
	| {
			type: "show-open-dialog";
			requestId: string;
			canSelectFiles?: boolean;
			canSelectFolders?: boolean;
			canSelectMany?: boolean;
			title?: string;
			filters?: Array<{ name: string; extensions: string[] }>;
			defaultPath?: string;
	  };
