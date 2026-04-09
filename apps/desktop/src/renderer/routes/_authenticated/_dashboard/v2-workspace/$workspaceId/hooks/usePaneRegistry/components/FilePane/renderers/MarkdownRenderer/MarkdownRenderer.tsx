import { useCallback, useEffect, useRef, useState } from "react";
import { TipTapMarkdownRenderer } from "renderer/components/MarkdownRenderer/components/TipTapMarkdownRenderer";
import {
	deriveMemoDisplayName,
	getTrustedMemoRootPath,
} from "renderer/lib/workspace-memos";
import { CodeEditor } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor";
import { ExternalChangeBar } from "../../components/ExternalChangeBar";

export type MarkdownViewMode = "rendered" | "raw";
const MEMO_AUTOSAVE_DELAY_MS = 1000;

interface MarkdownRendererProps {
	content: string;
	displayName?: string;
	filePath: string;
	hasExternalChange: boolean;
	isMemo: boolean;
	onDirtyChange: (dirty: boolean) => void;
	onDisplayNameChange: (displayName: string) => void;
	onReload: () => Promise<void>;
	onSave: (content: string) => Promise<unknown>;
	workspaceId: string;
}

export function MarkdownRenderer({
	content,
	displayName,
	filePath,
	hasExternalChange,
	isMemo,
	onDirtyChange,
	onDisplayNameChange,
	onReload,
	onSave,
	workspaceId,
}: MarkdownRendererProps) {
	const [viewMode, _setViewMode] = useState<MarkdownViewMode>("rendered");
	const currentContentRef = useRef(content);
	const [draftContent, setDraftContent] = useState(content);
	const [savedContent, setSavedContent] = useState(content);
	const isSavingRef = useRef(false);
	const trustedImageRootPath = getTrustedMemoRootPath(filePath);

	useEffect(() => {
		currentContentRef.current = content;
		setDraftContent(content);
		setSavedContent(content);
		onDirtyChange(false);
	}, [content, onDirtyChange]);

	const handleChange = useCallback(
		(value: string) => {
			currentContentRef.current = value;
			setDraftContent(value);
			if (isMemo) {
				onDisplayNameChange(deriveMemoDisplayName(value));
			}
			onDirtyChange(value !== savedContent);
		},
		[isMemo, onDirtyChange, onDisplayNameChange, savedContent],
	);

	const handleSave = useCallback(async () => {
		if (isSavingRef.current) {
			return;
		}

		isSavingRef.current = true;
		try {
			await onSave(currentContentRef.current);
			setSavedContent(currentContentRef.current);
			onDirtyChange(false);
		} finally {
			isSavingRef.current = false;
		}
	}, [onDirtyChange, onSave]);

	useEffect(() => {
		if (
			!isMemo ||
			hasExternalChange ||
			draftContent === savedContent ||
			isSavingRef.current
		) {
			return;
		}

		const timeoutId = window.setTimeout(() => {
			void handleSave();
		}, MEMO_AUTOSAVE_DELAY_MS);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [draftContent, handleSave, hasExternalChange, isMemo, savedContent]);

	useEffect(() => {
		if (!isMemo) {
			return;
		}

		const nextDisplayName = deriveMemoDisplayName(draftContent);
		if (nextDisplayName !== displayName) {
			onDisplayNameChange(nextDisplayName);
		}
	}, [displayName, draftContent, isMemo, onDisplayNameChange]);

	return (
		<div className="flex h-full flex-col">
			{hasExternalChange && <ExternalChangeBar onReload={onReload} />}
			<div className="min-h-0 flex-1">
				{viewMode === "rendered" ? (
					<div className="h-full overflow-y-auto p-4">
						<TipTapMarkdownRenderer
							value={draftContent}
							editable
							onChange={handleChange}
							onSave={handleSave}
							workspaceId={workspaceId}
							filePath={filePath}
							trustedImageRootPath={trustedImageRootPath}
						/>
					</div>
				) : (
					<CodeEditor
						value={draftContent}
						language="markdown"
						onChange={handleChange}
						onSave={handleSave}
						fillHeight
					/>
				)}
			</div>
		</div>
	);
}

// Exported for use in renderHeaderExtras
export type { MarkdownViewMode as ViewMode };

interface ViewModeToggleProps {
	viewMode: MarkdownViewMode;
	onViewModeChange: (mode: MarkdownViewMode) => void;
}

export function MarkdownViewModeToggle({
	viewMode,
	onViewModeChange,
}: ViewModeToggleProps) {
	return (
		<div className="flex items-center gap-0.5 text-xs">
			<button
				type="button"
				className={`rounded px-1.5 py-0.5 ${viewMode === "rendered" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
				onClick={() => onViewModeChange("rendered")}
			>
				Rendered
			</button>
			<button
				type="button"
				className={`rounded px-1.5 py-0.5 ${viewMode === "raw" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
				onClick={() => onViewModeChange("raw")}
			>
				Raw
			</button>
		</div>
	);
}
