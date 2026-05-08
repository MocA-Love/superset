import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useCallback } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { SafeImage } from "renderer/components/MarkdownRenderer/components";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { CommentCodeBlock } from "./components/CommentCodeBlock";

type ReactMarkdownComponents = ComponentProps<
	typeof ReactMarkdown
>["components"];

const baseComponents = {
	code: ({
		className,
		children,
	}: {
		className?: string;
		children?: ReactNode;
	}) => <CommentCodeBlock className={className}>{children}</CommentCodeBlock>,
	img: ({ src, alt }: { src?: string; alt?: string }) => (
		<SafeImage src={src} alt={alt} className="comment-md-img" />
	),
	a: CommentLink,
} satisfies ReactMarkdownComponents;

function CommentLink({
	href,
	children,
}: {
	href?: string;
	children?: ReactNode;
}) {
	const onClick = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => {
			event.preventDefault();
			if (!href) return;
			electronTrpcClient.external.openUrl.mutate(href).catch((err) => {
				console.warn("Failed to open external URL", err);
			});
		},
		[href],
	);
	return (
		<a
			href={href}
			onClick={onClick}
			rel="noopener noreferrer"
			className="comment-md-link"
		>
			{children}
		</a>
	);
}

interface CommentMarkdownProps {
	body: string;
	/** Per-surface overrides merged on top of the base map (e.g. CommentPane's CopyableTable). */
	components?: ReactMarkdownComponents;
}

/**
 * Shared markdown renderer for PR comment bodies. Sizing/spacing is owned
 * by the wrapper-class CSS at each call site (`.diff-comment-body`,
 * `.comment-pane-markdown`); this only dictates *what* renders.
 */
export function CommentMarkdown({ body, components }: CommentMarkdownProps) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[rehypeRaw, rehypeSanitize]}
			components={{ ...baseComponents, ...(components ?? {}) }}
		>
			{body}
		</ReactMarkdown>
	);
}
