import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import { CodeBlock } from "renderer/components/MarkdownRenderer/components/CodeBlock";
import { stripHtmlComments } from "../../utils";

interface CommentBodyProps {
	body: string;
	onOpenUrl?: (url: string, e: React.MouseEvent) => void;
}

export const CommentBody = memo(function CommentBody({
	body,
	onOpenUrl,
}: CommentBodyProps) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkAlert]}
			rehypePlugins={[rehypeRaw, rehypeSanitize]}
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
