"use client";

import { FileIcon } from "lucide-react";
import type { BundledLanguage } from "shiki";
import { ClickableFilePath } from "./clickable-file-path";
import { ShowCode } from "./show-code";
import { ToolCallRow } from "./tool-call-row";

export type ReadFileToolProps = {
	filename: string;
	content: string;
	lineRange?: string;
	language?: BundledLanguage;
	isError?: boolean;
	isPending?: boolean;
	onOpenInPane?: () => void;
	className?: string;
};

export function ReadFileTool({
	filename,
	content,
	lineRange,
	language = "text" as BundledLanguage,
	isError = false,
	isPending = false,
	onOpenInPane,
	className,
}: ReadFileToolProps) {
	return (
		<ToolCallRow
			className={className}
			description={<ClickableFilePath path={filename} onOpen={onOpenInPane} />}
			icon={FileIcon}
			isError={isError}
			isPending={isPending}
			title="Read"
		>
			<div className="py-1.5 pl-2">
				<ShowCode
					code={content}
					colorize={false}
					filename={filename}
					language={language}
					lineRange={lineRange}
					onOpen={onOpenInPane}
					showLineNumbers
				/>
			</div>
		</ToolCallRow>
	);
}
