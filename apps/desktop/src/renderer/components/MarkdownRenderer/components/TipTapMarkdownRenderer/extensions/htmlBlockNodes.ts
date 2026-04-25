import { mergeAttributes, Node } from "@tiptap/core";

const COMMON_BLOCK_ATTRS = {
	align: { default: null as string | null },
	class: { default: null as string | null },
	style: { default: null as string | null },
	id: { default: null as string | null },
};

const COMMON_INLINE_ATTRS = {
	class: { default: null as string | null },
	style: { default: null as string | null },
	id: { default: null as string | null },
};

export const Details = Node.create({
	name: "details",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return {
			...COMMON_BLOCK_ATTRS,
			open: {
				default: null as "" | null,
				parseHTML: (element: HTMLElement) =>
					element.hasAttribute("open") ? "" : null,
				renderHTML: (attrs: Record<string, unknown>) =>
					attrs.open === null ? {} : { open: "" },
			},
		};
	},

	parseHTML() {
		return [{ tag: "details" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["details", mergeAttributes(HTMLAttributes), 0];
	},
});

export const Summary = Node.create({
	name: "summary",
	group: "block",
	content: "inline*",
	defining: true,

	addAttributes() {
		return COMMON_INLINE_ATTRS;
	},

	parseHTML() {
		return [{ tag: "summary" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["summary", mergeAttributes(HTMLAttributes), 0];
	},
});

export const Div = Node.create({
	name: "div",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return COMMON_BLOCK_ATTRS;
	},

	parseHTML() {
		return [{ tag: "div" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes), 0];
	},
});

export const Span = Node.create({
	name: "span",
	inline: true,
	group: "inline",
	content: "inline*",

	addAttributes() {
		return COMMON_INLINE_ATTRS;
	},

	parseHTML() {
		return [{ tag: "span" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["span", mergeAttributes(HTMLAttributes), 0];
	},
});
