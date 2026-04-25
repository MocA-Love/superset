import { Extension } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { BulletList } from "@tiptap/extension-bullet-list";
import { Code } from "@tiptap/extension-code";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { History } from "@tiptap/extension-history";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import Image from "@tiptap/extension-image";
import { Italic } from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import { ListItem } from "@tiptap/extension-list-item";
import { OrderedList } from "@tiptap/extension-ordered-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Text } from "@tiptap/extension-text";
import { Underline } from "@tiptap/extension-underline";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { common, createLowlight } from "lowlight";
import type { MutableRefObject } from "react";
import { Markdown } from "tiptap-markdown";
import { EditableCodeBlockView } from "./components/EditableCodeBlockView";
import { ReadOnlyCodeBlockView } from "./components/ReadOnlyCodeBlockView";
import { ReadOnlySafeImageView } from "./components/ReadOnlySafeImageView";
import { Details, Div, Span, Summary } from "./extensions/htmlBlockNodes";
import { sanitizeUrl } from "./extensions/safeUrl";

const lowlight = createLowlight(common);
// Raw HTML in markdown is rendered through ProseMirror **only in read-only
// mode** (file preview, comment rendering, etc.). Editable mode keeps html:false
// to avoid silently dropping unknown tags (e.g. <iframe>, <video>) on save:
// in editable mode the editor parses → user edits → serializer writes back, so
// any tag the schema doesn't know would be permanently stripped from the
// underlying markdown file. With html:false, tiptap-markdown's parser leaves
// such tags as literal text and the serializer round-trips them unchanged.
//
// XSS in read-only mode is mitigated by:
//  1) ProseMirror schema — tags without an Extension (script/iframe/style/...)
//     and attributes without addAttributes (on*, srcset, ...) are dropped on parse.
//  2) SafeImage / SafeLink strip javascript:, vbscript:, and data:text/html
//     schemes from src/href.
const ENABLE_RAW_MARKDOWN_HTML = true;

const SafeImage = Image.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ReadOnlySafeImageView);
	},
	addAttributes() {
		return {
			...this.parent?.(),
			src: {
				default: null,
				parseHTML: (element) => sanitizeUrl(element.getAttribute("src")),
				renderHTML: (attributes) => {
					const src = attributes.src as string | null | undefined;
					return src ? { src } : {};
				},
			},
		};
	},
});

const SafeLink = Link.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			href: {
				default: null,
				parseHTML: (element) => sanitizeUrl(element.getAttribute("href")),
				renderHTML: (attributes) => {
					const href = attributes.href as string | null | undefined;
					return href ? { href } : {};
				},
			},
		};
	},
});

const ReadOnlyCodeBlock = CodeBlockLowlight.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ReadOnlyCodeBlockView);
	},
});

const EditableCodeBlock = CodeBlockLowlight.extend({
	addNodeView() {
		return ReactNodeViewRenderer(EditableCodeBlockView);
	},
});

const EditorHotkeys = Extension.create<{
	onSaveRef: MutableRefObject<(() => void) | undefined>;
}>({
	name: "editorHotkeys",

	addKeyboardShortcuts() {
		return {
			"Mod-s": () => {
				if (!this.editor.isEditable) {
					return false;
				}

				this.options.onSaveRef.current?.();
				return true;
			},
			Tab: ({ editor }) => {
				if (!editor.isEditable) {
					return false;
				}

				if (editor.commands.sinkListItem("listItem")) {
					return true;
				}

				if (editor.commands.sinkListItem("taskItem")) {
					return true;
				}

				return false;
			},
			"Shift-Tab": ({ editor }) => {
				if (!editor.isEditable) {
					return false;
				}

				if (editor.commands.liftListItem("listItem")) {
					return true;
				}

				if (editor.commands.liftListItem("taskItem")) {
					return true;
				}

				return false;
			},
		};
	},
});

interface CreateMarkdownExtensionsOptions {
	editable: boolean;
	onSaveRef: MutableRefObject<(() => void) | undefined>;
}

export function createMarkdownExtensions({
	editable,
	onSaveRef,
}: CreateMarkdownExtensionsOptions) {
	return [
		Document,
		Text,
		Paragraph,
		Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
		Bold,
		Italic,
		Strike,
		Underline,
		Code.configure({
			HTMLAttributes: {
				class: "rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
			},
		}),
		(editable ? EditableCodeBlock : ReadOnlyCodeBlock).configure({
			lowlight,
			HTMLAttributes: editable
				? {
						class:
							"my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm",
					}
				: undefined,
		}),
		BulletList,
		OrderedList,
		ListItem,
		TaskList.configure({
			HTMLAttributes: { class: "list-none pl-0" },
		}),
		TaskItem.configure({
			nested: true,
			HTMLAttributes: { class: "list-none flex items-start gap-2" },
		}),
		Blockquote,
		HorizontalRule,
		HardBreak,
		History,
		SafeLink.configure({
			openOnClick: !editable,
			HTMLAttributes: {
				class:
					"text-primary underline underline-offset-2 hover:text-primary/80",
				target: "_blank",
				rel: "noopener noreferrer",
			},
		}),
		SafeImage,
		Details,
		Summary,
		Div,
		Span,
		TableKit.configure({
			table: {
				resizable: false,
				cellMinWidth: 192,
				HTMLAttributes: {
					class: "markdown-table my-4 min-w-full border-collapse",
				},
			},
			tableHeader: {
				HTMLAttributes: {
					class: "bg-muted px-4 py-2 text-left text-sm font-semibold align-top",
				},
			},
			tableCell: {
				HTMLAttributes: {
					class: "border-t border-border px-4 py-2 text-sm align-top",
				},
			},
		}),
		Markdown.configure({
			html: !editable && ENABLE_RAW_MARKDOWN_HTML,
			transformPastedText: true,
			transformCopiedText: true,
		}),
		EditorHotkeys.configure({
			onSaveRef,
		}),
	];
}
