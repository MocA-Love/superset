import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { getEditorTheme, type Theme } from "shared/themes";

export function getCodeSyntaxHighlighting(theme: Theme): Extension {
	const editorTheme = getEditorTheme(theme);

	return syntaxHighlighting(
		HighlightStyle.define([
			{
				tag: [tags.keyword, tags.operatorKeyword, tags.modifier],
				color: editorTheme.syntax.keyword,
			},
			{
				tag: [tags.comment, tags.lineComment, tags.blockComment],
				color: editorTheme.syntax.comment,
				fontStyle: "italic",
			},
			{
				tag: [tags.string, tags.special(tags.string)],
				color: editorTheme.syntax.string,
			},
			{
				tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null],
				color: editorTheme.syntax.number,
			},
			{
				tag: [
					tags.function(tags.variableName),
					tags.function(tags.propertyName),
					tags.labelName,
				],
				color: editorTheme.syntax.functionCall,
			},
			{
				tag: [tags.variableName, tags.name, tags.propertyName],
				color: editorTheme.syntax.variableName,
			},
			{
				tag: [tags.typeName, tags.definition(tags.typeName)],
				color: editorTheme.syntax.typeName,
			},
			{
				tag: [tags.className],
				color: editorTheme.syntax.className,
			},
			{
				tag: [tags.constant(tags.name), tags.standard(tags.name)],
				color: editorTheme.syntax.constant,
			},
			{
				tag: [tags.regexp, tags.escape, tags.special(tags.regexp)],
				color: editorTheme.syntax.regexp,
			},
			{
				tag: [tags.tagName, tags.angleBracket],
				color: editorTheme.syntax.tagName,
			},
			{
				tag: [tags.attributeName],
				color: editorTheme.syntax.attributeName,
			},
			{
				tag: [tags.invalid],
				color: editorTheme.syntax.invalid,
			},

			// Markdown
			{
				tag: [tags.heading],
				color: editorTheme.syntax.markdownHeading,
				fontWeight: "bold",
			},
			{
				tag: [tags.heading1],
				color: editorTheme.syntax.markdownHeading,
				fontWeight: "bold",
				fontSize: "1.4em",
			},
			{
				tag: [tags.heading2],
				color: editorTheme.syntax.markdownHeading,
				fontWeight: "bold",
				fontSize: "1.2em",
			},
			{
				tag: [tags.heading3],
				color: editorTheme.syntax.markdownHeading,
				fontWeight: "bold",
				fontSize: "1.1em",
			},
			{
				tag: [tags.emphasis],
				color: editorTheme.syntax.markdownEmphasis,
				fontStyle: "italic",
			},
			{
				tag: [tags.strong],
				color: editorTheme.syntax.markdownStrong,
				fontWeight: "bold",
			},
			{
				tag: [tags.strikethrough],
				color: editorTheme.syntax.markdownStrikethrough,
				textDecoration: "line-through",
			},
			{
				tag: [tags.link],
				color: editorTheme.syntax.markdownLink,
				textDecoration: "underline",
			},
			{
				tag: [tags.url],
				color: editorTheme.syntax.markdownUrl,
			},
			{
				tag: [tags.monospace],
				color: editorTheme.syntax.markdownCode,
			},
			{
				tag: [tags.quote],
				color: editorTheme.syntax.markdownQuote,
				fontStyle: "italic",
			},
			{
				tag: [tags.list],
				color: editorTheme.syntax.markdownList,
			},
			{
				tag: [tags.contentSeparator],
				color: editorTheme.syntax.markdownSeparator,
			},
			{
				tag: [tags.processingInstruction],
				color: editorTheme.syntax.markdownMeta,
			},
			{
				tag: [tags.meta],
				color: editorTheme.syntax.markdownMeta,
			},
		]),
	);
}
