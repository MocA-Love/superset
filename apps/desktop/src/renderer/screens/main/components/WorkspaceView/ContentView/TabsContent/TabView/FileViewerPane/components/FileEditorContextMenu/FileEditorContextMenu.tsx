import { type MutableRefObject, type ReactNode, useCallback } from "react";
import type { SupersetLinkProject } from "renderer/lib/superset-open-links";
import type { Tab } from "renderer/stores/tabs/types";
import {
	type CodeEditorAdapter,
	EditorContextMenu,
	useEditorActions,
} from "../../../../../components";

interface FileEditorContextMenuProps {
	children: ReactNode;
	editorRef: MutableRefObject<CodeEditorAdapter | null>;
	filePath: string;
	branch?: string | null;
	worktreePath?: string | null;
	supersetLinkProject?: SupersetLinkProject | null;
	onSplitHorizontal: () => void;
	onSplitVertical: () => void;
	onSplitWithNewChat?: () => void;
	onSplitWithNewBrowser?: () => void;
	onEqualizePaneSplits?: () => void;
	onClosePane: () => void;
	currentTabId: string;
	availableTabs: Tab[];
	onMoveToTab: (tabId: string) => void;
	onMoveToNewTab: () => void;
	onGoToDefinition?: () => void;
	onGoToTypeDefinition?: () => void;
	onGoToImplementation?: () => void;
	onFindAllReferences?: () => void;
	onRenameSymbol?: () => void;
	onShowCodeActions?: () => void;
	onShowReferenceGraph?: () => void;
}

export function FileEditorContextMenu({
	children,
	editorRef,
	filePath,
	branch,
	worktreePath,
	supersetLinkProject,
	onSplitHorizontal,
	onSplitVertical,
	onSplitWithNewChat,
	onSplitWithNewBrowser,
	onEqualizePaneSplits,
	onClosePane,
	currentTabId,
	availableTabs,
	onMoveToTab,
	onMoveToNewTab,
	onGoToDefinition,
	onGoToTypeDefinition,
	onGoToImplementation,
	onFindAllReferences,
	onRenameSymbol,
	onShowCodeActions,
	onShowReferenceGraph,
}: FileEditorContextMenuProps) {
	const getEditor = useCallback(() => editorRef.current, [editorRef]);

	const editorActions = useEditorActions({
		getEditor,
		filePath,
		branch,
		worktreePath,
		supersetLinkProject,
		editable: true,
		onGoToDefinition,
		onGoToTypeDefinition,
		onGoToImplementation,
		onFindAllReferences,
		onRenameSymbol,
		onShowCodeActions,
		onShowReferenceGraph,
	});

	return (
		<EditorContextMenu
			editorActions={editorActions}
			paneActions={{
				onSplitHorizontal,
				onSplitVertical,
				onSplitWithNewChat,
				onSplitWithNewBrowser,
				onEqualizePaneSplits,
				onClosePane,
				currentTabId,
				availableTabs,
				onMoveToTab,
				onMoveToNewTab,
			}}
		>
			{children}
		</EditorContextMenu>
	);
}
