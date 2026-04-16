import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import { CodeBlock } from "renderer/components/MarkdownRenderer/components/CodeBlock";
import { stripHtmlComments } from "../../utils";

interface CommentBodyProps {
	body: string;
	onOpenUrl?: (url: string, e: React.MouseEvent) => void;
}

// rehype-sanitize の defaultSchema は className 属性を厳しく制限しており、
// remark-github-blockquote-alert が生成する `markdown-alert` / `markdown-alert-*`
// クラスは何もしないと剥がされて CSS（globals.css の .markdown-alert ルール）
// が当たらず、アラートが通常テキストとして表示されてしまう。markdown-alert
// 系のクラス名のみ明示的に許可するスキーマを使う。
const sanitizeSchema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		div: [
			...((defaultSchema.attributes?.div as unknown[]) ?? []),
			["className", /^markdown-alert(?:$|\s|-)/],
		],
		p: [
			...((defaultSchema.attributes?.p as unknown[]) ?? []),
			["className", /^markdown-alert-title(?:$|\s)/],
		],
		svg: [
			...((defaultSchema.attributes?.svg as unknown[]) ?? []),
			["className", /^octicon(?:$|\s|-)/],
		],
	},
};

export const CommentBody = memo(function CommentBody({
	body,
	onOpenUrl,
}: CommentBodyProps) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkAlert]}
			rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
			components={{
				a: ({ href, children }) =>
					href ? (
						<a
							href={href}
							className="text-primary underline"
							onClick={(e) => onOpenUrl?.(href, e)}
						>
							{children}
						</a>
					) : (
						<span>{children}</span>
					),
				code: ({ className, children, node }) => (
					<CodeBlock className={className} node={node}>
						{children}
					</CodeBlock>
				),
			}}
		>
			{stripHtmlComments(body)}
		</ReactMarkdown>
	);
});
