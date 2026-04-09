import "highlight.js/styles/github-dark.css";

import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { type MutableRefObject, useEffect, useRef } from "react";
import {
	getWorkspaceMemoContextFromFilePath,
	saveMemoImageFile,
} from "renderer/lib/workspace-memos";
import { useMarkdownStyle } from "renderer/stores";
import { defaultConfig } from "../../styles/default/config";
import { tufteConfig } from "../../styles/tufte/config";
import { TrustedImageProvider } from "../SafeImage";
import { SelectionContextMenu } from "../SelectionContextMenu";
import { BubbleMenuToolbar } from "./components/BubbleMenuToolbar";
import { createMarkdownExtensions } from "./createMarkdownExtensions";

const styleConfigs = {
	default: defaultConfig,
	tufte: tufteConfig,
} as const;

export interface MarkdownEditorAdapter {
	focus(): void;
	getValue(): string;
	setValue(value: string): void;
	dispose(): void;
}

interface TipTapMarkdownRendererProps {
	value: string;
	style?: keyof typeof styleConfigs;
	className?: string;
	editable?: boolean;
	editorRef?: MutableRefObject<MarkdownEditorAdapter | null>;
	onChange?: (value: string) => void;
	onSave?: () => void;
	workspaceId?: string;
	filePath?: string;
	trustedImageRootPath?: string | null;
}

function getEditorMarkdown(editor: Editor): string {
	const storage = editor.storage as unknown as Record<
		string,
		{ getMarkdown?: () => string }
	>;

	return storage.markdown?.getMarkdown?.() ?? "";
}

function createMarkdownEditorAdapter(editor: Editor): MarkdownEditorAdapter {
	let disposed = false;

	return {
		focus() {
			editor.commands.focus();
		},
		getValue() {
			return getEditorMarkdown(editor);
		},
		setValue(value) {
			editor.commands.setContent(value, { emitUpdate: false });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
		},
	};
}

export function TipTapMarkdownRenderer({
	value,
	style: styleProp,
	className,
	editable = false,
	editorRef,
	onChange,
	onSave,
	workspaceId,
	filePath,
	trustedImageRootPath,
}: TipTapMarkdownRendererProps) {
	const globalStyle = useMarkdownStyle();
	const style = styleProp ?? globalStyle;
	const config = styleConfigs[style];
	const articleRef = useRef<HTMLElement | null>(null);
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	const workspaceIdRef = useRef(workspaceId);
	const filePathRef = useRef(filePath);

	onChangeRef.current = onChange;
	onSaveRef.current = onSave;
	workspaceIdRef.current = workspaceId;
	filePathRef.current = filePath;

	const editor = useEditor({
		immediatelyRender: false,
		editable,
		extensions: createMarkdownExtensions({
			editable,
			onSaveRef,
		}),
		content: value,
		editorProps: {
			attributes: {
				class: cn("focus:outline-none", editable && "min-h-[100px]"),
			},
			handlePaste: (view, event) => {
				if (!editable) {
					return false;
				}

				const activeWorkspaceId = workspaceIdRef.current;
				const activeFilePath = filePathRef.current;
				if (
					!activeWorkspaceId ||
					!activeFilePath ||
					!getWorkspaceMemoContextFromFilePath(activeFilePath)
				) {
					return false;
				}

				const imageFile = Array.from(event.clipboardData?.items ?? [])
					.find((item) => item.type.startsWith("image/"))
					?.getAsFile();
				if (!imageFile) {
					return false;
				}

				event.preventDefault();
				void saveMemoImageFile({
					workspaceId: activeWorkspaceId,
					memoFilePath: activeFilePath,
					file: imageFile,
				})
					.then(({ relativePath }) => {
						const imageNodeType = view.state.schema.nodes.image;
						if (imageNodeType) {
							const transaction = view.state.tr.replaceSelectionWith(
								imageNodeType.create({
									src: relativePath,
									alt: imageFile.name || "pasted image",
								}),
							);
							view.dispatch(transaction.scrollIntoView());
							return;
						}

						view.dispatch(
							view.state.tr
								.insertText(
									`![${imageFile.name || "pasted image"}](${relativePath})`,
								)
								.scrollIntoView(),
						);
					})
					.catch((error: Error) => {
						toast.error(`Failed to paste image: ${error.message}`);
					});

				return true;
			},
		},
		onUpdate: ({ editor: currentEditor }) => {
			onChangeRef.current?.(getEditorMarkdown(currentEditor));
		},
	});

	useEffect(() => {
		if (!editor) {
			return;
		}

		const currentValue = getEditorMarkdown(editor);
		if (currentValue === value) {
			return;
		}

		editor.commands.setContent(value, { emitUpdate: false });
	}, [editor, value]);

	useEffect(() => {
		if (!editor) {
			return;
		}

		editor.setEditable(editable, false);
	}, [editable, editor]);

	useEffect(() => {
		if (!editorRef || !editor) {
			return;
		}

		const adapter = createMarkdownEditorAdapter(editor);
		editorRef.current = adapter;

		return () => {
			if (editorRef.current === adapter) {
				editorRef.current = null;
			}
			adapter.dispose();
		};
	}, [editor, editorRef]);

	const content = (
		<TrustedImageProvider
			workspaceId={workspaceId}
			trustedImageRootPath={trustedImageRootPath}
		>
			<div
				className={cn(
					"markdown-renderer h-full overflow-y-auto select-text",
					config.wrapperClass,
					className,
				)}
			>
				{editable && editor && (
					<BubbleMenu
						editor={editor}
						options={{
							placement: "top",
							offset: { mainAxis: 8 },
						}}
						shouldShow={({ editor: e, from, to }) => {
							if (from === to) return false;
							if (e.isActive("codeBlock")) return false;
							return true;
						}}
					>
						<BubbleMenuToolbar editor={editor} />
					</BubbleMenu>
				)}
				<article ref={articleRef} className={config.articleClass}>
					<EditorContent editor={editor} />
				</article>
			</div>
		</TrustedImageProvider>
	);

	if (editable) {
		return content;
	}

	return (
		<SelectionContextMenu selectAllContainerRef={articleRef}>
			{content}
		</SelectionContextMenu>
	);
}
