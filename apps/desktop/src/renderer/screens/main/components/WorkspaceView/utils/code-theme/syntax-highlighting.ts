import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { getEditorTheme, type Theme } from "shared/themes";

export function getCodeSyntaxHighlighting(theme: Theme): Extension {
	const editorTheme = getEditorTheme(theme);

	return syntaxHighlighting(
		HighlightStyle.define([
			// ── Keywords ──────────────────────────────────────────────
			{
				tag: [
					tags.keyword,
					tags.operatorKeyword,
					tags.modifier,
					tags.controlKeyword,
					tags.definitionKeyword,
					tags.moduleKeyword,
					tags.self,
					tags.unit,
				],
				color: editorTheme.syntax.keyword,
			},

			// ── Comments ──────────────────────────────────────────────
			{
				tag: [tags.comment, tags.lineComment, tags.blockComment],
				color: editorTheme.syntax.comment,
				fontStyle: "italic",
			},
			{
				tag: [tags.docComment, tags.docString],
				color: editorTheme.syntax.comment,
				fontStyle: "italic",
			},

			// ── Strings & character literals ──────────────────────────
			{
				tag: [
					tags.string,
					tags.special(tags.string),
					tags.character,
					tags.attributeValue,
				],
				color: editorTheme.syntax.string,
			},

			// ── Numbers & atoms ───────────────────────────────────────
			{
				tag: [
					tags.number,
					tags.integer,
					tags.float,
					tags.bool,
					tags.null,
					tags.atom,
					tags.color,
				],
				color: editorTheme.syntax.number,
			},

			// ── Literals (generic fallback) ───────────────────────────
			{
				tag: [tags.literal],
				color: editorTheme.syntax.number,
			},

			// ── Functions & macros ────────────────────────────────────
			{
				tag: [
					tags.function(tags.variableName),
					tags.function(tags.propertyName),
					tags.labelName,
					tags.macroName,
				],
				color: editorTheme.syntax.functionCall,
			},

			// ── Variables & properties ────────────────────────────────
			{
				tag: [tags.variableName, tags.name, tags.propertyName],
				color: editorTheme.syntax.variableName,
			},

			// ── Types & namespaces ────────────────────────────────────
			{
				tag: [tags.typeName, tags.definition(tags.typeName), tags.namespace],
				color: editorTheme.syntax.typeName,
			},
			{
				tag: [tags.className],
				color: editorTheme.syntax.className,
			},

			// ── Constants ─────────────────────────────────────────────
			{
				tag: [tags.constant(tags.name), tags.standard(tags.name)],
				color: editorTheme.syntax.constant,
			},

			// ── Regex & escape ────────────────────────────────────────
			{
				tag: [tags.regexp, tags.escape, tags.special(tags.regexp)],
				color: editorTheme.syntax.regexp,
			},

			// ── Tags & attributes (HTML/XML/JSX) ──────────────────────
			{
				tag: [tags.tagName, tags.angleBracket],
				color: editorTheme.syntax.tagName,
			},
			{
				tag: [tags.attributeName],
				color: editorTheme.syntax.attributeName,
			},

			// ── Operators ─────────────────────────────────────────────
			{
				tag: [
					tags.operator,
					tags.derefOperator,
					tags.arithmeticOperator,
					tags.logicOperator,
					tags.bitwiseOperator,
					tags.compareOperator,
					tags.updateOperator,
					tags.definitionOperator,
					tags.typeOperator,
					tags.controlOperator,
				],
				color: editorTheme.syntax.operator,
			},

			// ── Punctuation & brackets ────────────────────────────────
			{
				tag: [
					tags.punctuation,
					tags.separator,
					tags.bracket,
					tags.squareBracket,
					tags.paren,
					tags.brace,
				],
				color: editorTheme.syntax.punctuation,
			},

			// ── Meta & annotations ────────────────────────────────────
			{
				tag: [
					tags.meta,
					tags.documentMeta,
					tags.annotation,
					tags.processingInstruction,
				],
				color: editorTheme.syntax.markdownMeta,
			},

			// ── Diff ──────────────────────────────────────────────────
			{
				tag: [tags.inserted],
				color: editorTheme.syntax.string,
			},
			{
				tag: [tags.deleted],
				color: editorTheme.syntax.invalid,
			},
			{
				tag: [tags.changed],
				color: editorTheme.syntax.keyword,
			},

			// ── Invalid ───────────────────────────────────────────────
			{
				tag: [tags.invalid],
				color: editorTheme.syntax.invalid,
			},

			// ── Markdown ──────────────────────────────────────────────
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
		]),
	);
}
