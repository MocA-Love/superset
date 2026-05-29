"use client";

import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	ExternalLinkIcon,
} from "lucide-react";
import { useState } from "react";
import type { BundledLanguage } from "shiki";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../ui/tooltip";
import { ClickableFilePath } from "./clickable-file-path";
import { CodeBlock } from "./code-block";

const DEFAULT_MAX_LINES = 15;

export type ShowCodeProps = {
	code: string;
	language?: BundledLanguage;
	filename?: string;
	lineRange?: string;
	showLineNumbers?: boolean;
	startLine?: number;
	colorize?: boolean;
	maxLines?: number;
	onOpen?: () => void;
	className?: string;
};

export function ShowCode({
	code,
	language = "text" as BundledLanguage,
	filename,
	lineRange,
	showLineNumbers = true,
	startLine,
	colorize = true,
	maxLines = DEFAULT_MAX_LINES,
	onOpen,
	className,
}: ShowCodeProps) {
	const [isCopied, setIsCopied] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);

	const lineCount = code.trimEnd().split("\n").length;
	const isOverflowing = lineCount > maxLines;

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
		} catch {
			// Clipboard may be unavailable in restricted webviews.
		}
	};

	return (
		<div
			className={cn(
				"overflow-hidden rounded-md border border-border",
				className,
			)}
		>
			<div className="flex items-center justify-between border-border border-b bg-muted/50 px-3 py-1.5">
				<div className="flex min-w-0 items-center gap-2 font-mono text-xs">
					{filename ? (
						<>
							<ClickableFilePath
								path={filename}
								onOpen={onOpen}
								className="text-foreground"
							/>
							{lineRange ? (
								<span className="shrink-0 text-muted-foreground">
									{lineRange}
								</span>
							) : null}
						</>
					) : (
						<span className="text-muted-foreground">{language}</span>
					)}
				</div>
				<div className="ml-2 flex shrink-0 items-center gap-0.5">
					{isOverflowing ? (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										aria-label={isExpanded ? "Collapse" : "Expand"}
										className="h-6 w-6"
										onClick={() => setIsExpanded((previous) => !previous)}
										size="icon"
										variant="ghost"
									>
										{isExpanded ? (
											<ChevronUpIcon className="h-3.5 w-3.5" />
										) : (
											<ChevronDownIcon className="h-3.5 w-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{isExpanded ? "Collapse" : "Expand"}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					) : null}
					{onOpen && filename ? (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										aria-label="Open"
										className="h-6 w-6"
										onClick={(event) => {
											event.stopPropagation();
											onOpen();
										}}
										size="icon"
										variant="ghost"
									>
										<ExternalLinkIcon className="h-3.5 w-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Open</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					) : null}
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									aria-label={isCopied ? "Copied" : "Copy"}
									className="h-6 w-6"
									onClick={handleCopy}
									size="icon"
									variant="ghost"
								>
									<div className="relative h-3.5 w-3.5">
										<CopyIcon
											className={cn(
												"absolute inset-0 h-3.5 w-3.5 transition-[opacity,transform] duration-200 ease-out",
												isCopied
													? "scale-50 opacity-0"
													: "scale-100 opacity-100",
											)}
										/>
										<CheckIcon
											className={cn(
												"absolute inset-0 h-3.5 w-3.5 transition-[opacity,transform] duration-200 ease-out",
												isCopied
													? "scale-100 opacity-100"
													: "scale-50 opacity-0",
											)}
										/>
									</div>
								</Button>
							</TooltipTrigger>
							<TooltipContent>Copy</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			</div>

			<div className="relative">
				<CodeBlock
					className={cn(
						"rounded-none border-0 [&_pre]:!p-2",
						!isExpanded && "[&>div>div]:max-h-[300px]",
					)}
					code={code}
					colorize={colorize}
					language={language}
					showLineNumbers={showLineNumbers}
					startLine={startLine}
				/>

				{isOverflowing && !isExpanded ? (
					<div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background pb-1.5 pt-8">
						<button
							className="pointer-events-auto text-muted-foreground text-xs underline transition-colors hover:text-foreground"
							onClick={() => setIsExpanded(true)}
							type="button"
						>
							Show more
						</button>
					</div>
				) : null}

				{isOverflowing && isExpanded ? (
					<div className="flex justify-center pb-1.5 pt-1">
						<button
							className="text-muted-foreground text-xs underline transition-colors hover:text-foreground"
							onClick={() => setIsExpanded(false)}
							type="button"
						>
							Show less
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}
