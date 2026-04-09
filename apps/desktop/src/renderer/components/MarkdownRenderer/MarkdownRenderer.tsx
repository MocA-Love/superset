import { cn } from "@superset/ui/utils";
import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useMarkdownStyle } from "renderer/stores";
import { SelectionContextMenu } from "./components";
import { TrustedImageProvider } from "./components/SafeImage";
import { defaultConfig } from "./styles/default/config";
import { tufteConfig } from "./styles/tufte/config";

const styleConfigs = {
	default: defaultConfig,
	tufte: tufteConfig,
} as const;

interface MarkdownRendererProps {
	content: string;
	style?: keyof typeof styleConfigs;
	className?: string;
	scrollable?: boolean;
	workspaceId?: string;
	trustedImageRootPath?: string | null;
}

export function MarkdownRenderer({
	content,
	style: styleProp,
	className,
	scrollable = true,
	workspaceId,
	trustedImageRootPath,
}: MarkdownRendererProps) {
	const globalStyle = useMarkdownStyle();
	const style = styleProp ?? globalStyle;
	const config = styleConfigs[style];
	const articleRef = useRef<HTMLElement | null>(null);

	return (
		<SelectionContextMenu selectAllContainerRef={articleRef}>
			<TrustedImageProvider
				workspaceId={workspaceId}
				trustedImageRootPath={trustedImageRootPath}
			>
				<div
					className={cn(
						"markdown-renderer select-text",
						scrollable && "h-full overflow-y-auto",
						config.wrapperClass,
						className,
					)}
				>
					<article ref={articleRef} className={config.articleClass}>
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							rehypePlugins={[rehypeRaw, rehypeSanitize]}
							components={config.components}
						>
							{content}
						</ReactMarkdown>
					</article>
				</div>
			</TrustedImageProvider>
		</SelectionContextMenu>
	);
}
