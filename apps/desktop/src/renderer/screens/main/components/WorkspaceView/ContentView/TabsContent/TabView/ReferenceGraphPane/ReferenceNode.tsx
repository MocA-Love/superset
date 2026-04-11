import { Handle, Position } from "@xyflow/react";
import { memo, useCallback } from "react";
import { CodePreview } from "./CodePreview";

interface ReferenceNodeData {
	name: string;
	kind: string;
	relativePath: string | null;
	absolutePath: string;
	line: number;
	codeSnippet: string;
	languageId: string;
	snippetStartLine: number;
	isRoot: boolean;
	depth: number;
	onDoubleClick: (absolutePath: string, line: number) => void;
	shikiTheme?: {
		name: string;
		type: string;
		colors: object;
		tokenColors: object[];
	};
}

const SYMBOL_ICONS: Record<string, string> = {
	function: "\u{0192}",
	method: "\u{1F527}",
	constructor: "\u{1F3D7}",
	class: "\u{1F3DB}",
	interface: "\u{26A1}",
	enum: "\u{1F522}",
	variable: "\u{1F3B2}",
	property: "\u{1F4DD}",
	module: "\u{1F4E6}",
	namespace: "\u{1F4E6}",
	type: "\u{1F4D0}",
	constant: "\u{1F511}",
	reference: "\u{1F517}",
	unknown: "\u{1F4D6}",
	// tsserver symbol kinds (string numbers)
	"12": "\u{0192}", // function
	"11": "\u{1F527}", // method
	"5": "\u{1F3DB}", // class
	"8": "\u{26A1}", // interface
	"10": "\u{1F522}", // enum
	"6": "\u{1F4E6}", // module
	"13": "\u{1F3B2}", // variable
};

function ReferenceNodeComponent({ data }: { data: ReferenceNodeData }) {
	const handleClick = useCallback(() => {
		data.onDoubleClick(data.absolutePath, data.line);
	}, [data]);

	const icon =
		SYMBOL_ICONS[data.kind.toLowerCase()] ??
		SYMBOL_ICONS[data.kind] ??
		"\u{1F4D6}";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: ReactFlow node wrapper
		// biome-ignore lint/a11y/useKeyWithClickEvents: ReactFlow handles keyboard nav
		<div
			className={`ref-graph-node ${data.isRoot ? "root" : ""}`}
			onClick={handleClick}
		>
			<Handle type="target" position={Position.Top} isConnectable={false} />

			<div className="ref-graph-node-header">
				<span className="ref-graph-node-icon">{icon}</span>
				<span className="ref-graph-node-name">{data.name}</span>
			</div>

			<div className="ref-graph-node-location">
				{data.relativePath ?? data.absolutePath}:{data.line}
			</div>

			<CodePreview
				code={data.codeSnippet}
				language={data.languageId}
				startLine={data.snippetStartLine}
				shikiTheme={data.shikiTheme}
			/>

			<Handle type="source" position={Position.Bottom} isConnectable={false} />
		</div>
	);
}

export const ReferenceNode = memo(ReferenceNodeComponent);
