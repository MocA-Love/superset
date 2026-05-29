import { BashTool } from "@superset/ui/ai-elements/bash-tool";
import { ClickableFilePath } from "@superset/ui/ai-elements/clickable-file-path";
import { ReadFileTool } from "@superset/ui/ai-elements/read-file-tool";
import { ToolCallRow } from "@superset/ui/ai-elements/tool-call-row";
import {
	CodeIcon,
	FileIcon,
	FileSearchIcon,
	FileTextIcon,
	FolderIcon,
	GlobeIcon,
	SearchIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { type ComponentType, type ReactNode, useMemo } from "react";
import { getExecuteCommandViewModel } from "renderer/components/Chat/ChatInterface/components/ToolCallBlock/utils/getExecuteCommandViewModel";
import { normalizeWorkspaceFilePath } from "renderer/components/Chat/ChatInterface/utils/file-paths";
import { normalizeToolName } from "renderer/components/Chat/ChatInterface/utils/tool-helpers";
import { detectLanguage } from "shared/detect-language";
import type { BundledLanguage } from "shiki";

interface SubagentInnerToolCallProps {
	name: string;
	isError: boolean;
	isPending?: boolean;
	args: Record<string, unknown> | null;
	result: string | null;
	workspaceCwd?: string;
	onOpenFileInPane?: (filePath: string) => void;
}

interface ToolMeta {
	label: string;
	icon: ComponentType<{ className?: string }>;
}

const TOOL_META: Record<string, ToolMeta> = {
	mastra_workspace_execute_command: {
		label: "Bash",
		icon: TerminalIcon,
	},
	mastra_workspace_write_file: { label: "Write", icon: FileIcon },
	mastra_workspace_edit_file: { label: "Edit", icon: FileTextIcon },
	mastra_workspace_read_file: { label: "Read", icon: FileIcon },
	mastra_workspace_list_files: { label: "List Files", icon: FolderIcon },
	mastra_workspace_file_stat: { label: "Check file", icon: FileSearchIcon },
	mastra_workspace_search: { label: "Search", icon: SearchIcon },
	mastra_workspace_mkdir: { label: "Create Directory", icon: FolderIcon },
	mastra_workspace_delete: { label: "Delete", icon: FileIcon },
	ast_smart_edit: { label: "Smart Edit", icon: CodeIcon },
	web_fetch: { label: "Web Fetch", icon: GlobeIcon },
	web_search: { label: "Web Search", icon: GlobeIcon },
};

const FILE_PATH_TOOLS = new Set([
	"mastra_workspace_write_file",
	"mastra_workspace_edit_file",
	"mastra_workspace_file_stat",
	"mastra_workspace_delete",
	"ast_smart_edit",
]);

function getToolMeta(toolName: string): ToolMeta {
	return (
		TOOL_META[toolName] ?? {
			label: toolName.replaceAll("_", " "),
			icon: WrenchIcon,
		}
	);
}

function getStringArg(
	args: Record<string, unknown> | null,
	keys: string[],
): string | null {
	if (!args) return null;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return null;
}

function getRawFilePath(
	toolName: string,
	args: Record<string, unknown> | null,
): string | null {
	if (toolName === "mastra_workspace_read_file") {
		return getStringArg(args, ["path", "filePath", "file_path", "file"]);
	}
	if (FILE_PATH_TOOLS.has(toolName)) {
		return getStringArg(args, ["path", "filePath", "file_path", "file"]);
	}
	return null;
}

function getDescription(
	toolName: string,
	args: Record<string, unknown> | null,
): string | undefined {
	let raw: string | null = null;

	switch (toolName) {
		case "mastra_workspace_read_file":
		case "mastra_workspace_write_file":
		case "mastra_workspace_edit_file":
		case "mastra_workspace_file_stat":
		case "mastra_workspace_delete":
		case "ast_smart_edit":
			raw = getStringArg(args, ["path", "filePath", "file_path", "file"]);
			break;
		case "mastra_workspace_list_files":
		case "mastra_workspace_mkdir":
			raw = getStringArg(args, [
				"path",
				"directory",
				"directoryPath",
				"directory_path",
				"root",
				"cwd",
			]);
			break;
		case "mastra_workspace_search":
			raw = getStringArg(args, [
				"query",
				"pattern",
				"regex",
				"substring_pattern",
				"text",
			]);
			break;
		case "web_fetch":
			raw = getStringArg(args, ["url", "uri"]);
			break;
		case "web_search":
			raw = getStringArg(args, ["query", "q"]);
			break;
		default:
			return undefined;
	}

	if (!raw) return undefined;
	if (
		raw.includes("/") &&
		toolName !== "mastra_workspace_search" &&
		toolName !== "web_fetch" &&
		toolName !== "web_search"
	) {
		return raw.split("/").pop() ?? raw;
	}
	return raw;
}

function parseReadFileResult(result: string): {
	filename: string;
	content: string;
	lineCount: number;
} | null {
	const lines = result.split("\n");
	if (lines.length < 2) return null;

	const headerMatch = lines[0].match(/^(.+?)\s*\(\d+\s*bytes?\)\s*$/i);
	if (!headerMatch) return null;

	const contentLines = lines.slice(1).map((line) => {
		const tabMatch = line.match(/^\s*\d+\t(.*)$/);
		if (tabMatch) return tabMatch[1];
		const arrowMatch = line.match(/^\s*\d+\u2192(.*)$/);
		if (arrowMatch) return arrowMatch[1];
		return line;
	});

	while (
		contentLines.length > 0 &&
		contentLines[contentLines.length - 1].trim() === ""
	) {
		contentLines.pop();
	}

	return {
		filename: headerMatch[1].trim(),
		content: contentLines.join("\n"),
		lineCount: contentLines.length,
	};
}

function resolveFilePath({
	filePath,
	workspaceCwd,
}: {
	filePath: string;
	workspaceCwd?: string;
}): string {
	return (
		normalizeWorkspaceFilePath({
			filePath,
			workspaceRoot: workspaceCwd,
		}) ?? filePath
	);
}

function getDescriptionNode({
	description,
	rawFilePath,
	workspaceCwd,
	onOpenFileInPane,
}: {
	description?: string;
	rawFilePath: string | null;
	workspaceCwd?: string;
	onOpenFileInPane?: (filePath: string) => void;
}): ReactNode {
	if (!description) return undefined;
	if (!rawFilePath || !onOpenFileInPane) return description;

	const resolvedFilePath = resolveFilePath({
		filePath: rawFilePath,
		workspaceCwd,
	});
	return (
		<ClickableFilePath
			path={resolvedFilePath}
			display={description}
			onOpen={() => onOpenFileInPane(resolvedFilePath)}
		/>
	);
}

export function SubagentInnerToolCall({
	name,
	isError,
	isPending = false,
	args,
	result,
	workspaceCwd,
	onOpenFileInPane,
}: SubagentInnerToolCallProps) {
	const normalized = normalizeToolName(name);
	const state = isPending
		? "input-available"
		: isError
			? "output-error"
			: "output-available";
	const { label, icon } = getToolMeta(normalized);
	const description = getDescription(normalized, args);
	const rawFilePath = getRawFilePath(normalized, args);
	const descriptionNode = getDescriptionNode({
		description,
		rawFilePath,
		workspaceCwd,
		onOpenFileInPane,
	});
	const hasResult = result !== null && result.trim().length > 0;

	const parsedReadFile = useMemo(() => {
		if (normalized !== "mastra_workspace_read_file") return null;
		if (!hasResult) return null;
		return parseReadFileResult(result);
	}, [hasResult, normalized, result]);

	if (normalized === "mastra_workspace_execute_command") {
		const { command, stdout, stderr, exitCode } = getExecuteCommandViewModel({
			args: args ?? {},
			result: result !== null ? { content: result } : {},
		});
		return (
			<BashTool
				command={command}
				stdout={stdout}
				stderr={stderr}
				exitCode={exitCode}
				state={state}
			/>
		);
	}

	if (parsedReadFile) {
		const filename =
			parsedReadFile.filename.split("/").pop() ?? parsedReadFile.filename;
		const resolvedPath = resolveFilePath({
			filePath: rawFilePath ?? parsedReadFile.filename,
			workspaceCwd,
		});
		return (
			<ReadFileTool
				filename={filename}
				content={parsedReadFile.content}
				lineRange={`1-${parsedReadFile.lineCount}`}
				language={detectLanguage(parsedReadFile.filename) as BundledLanguage}
				isError={isError}
				isPending={isPending}
				onOpenInPane={
					onOpenFileInPane ? () => onOpenFileInPane(resolvedPath) : undefined
				}
			/>
		);
	}

	return (
		<ToolCallRow
			description={descriptionNode}
			icon={icon}
			isError={isError}
			isPending={isPending}
			title={label}
		>
			{hasResult ? (
				<div className="py-1.5 pl-2">
					<div className="whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
						{result}
					</div>
				</div>
			) : undefined}
		</ToolCallRow>
	);
}
