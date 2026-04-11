import { Handle, Position } from "@xyflow/react";
import { memo, useCallback } from "react";

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
}

const SYMBOL_ICONS: Record<string, string> = {
	function: "ƒ",
	method: "m",
	constructor: "C",
	class: "◆",
	interface: "I",
	enum: "E",
	variable: "v",
	property: "p",
	module: "M",
	namespace: "N",
	type: "T",
	constant: "c",
	reference: "→",
	unknown: "?",
	// tsserver symbol kinds (numeric)
	"12": "ƒ", // function
	"11": "m", // method
	"5": "◆", // class
	"8": "I", // interface
	"10": "E", // enum
	"13": "v", // variable
	"6": "M", // module
};

function ReferenceNodeComponent({ data }: { data: ReferenceNodeData }) {
	const handleDoubleClick = useCallback(() => {
		data.onDoubleClick(data.absolutePath, data.line);
	}, [data]);

	const icon =
		SYMBOL_ICONS[data.kind.toLowerCase()] ?? SYMBOL_ICONS[data.kind] ?? "·";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: ReactFlow node wrapper
		<div
			className={`rounded-lg border shadow-sm overflow-hidden w-[350px] ${
				data.isRoot ? "border-primary/50 bg-primary/5" : "border-border bg-card"
			}`}
			onDoubleClick={handleDoubleClick}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!bg-muted-foreground !w-2 !h-2"
			/>
			<div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/30">
				<span className="text-xs font-mono text-muted-foreground">{icon}</span>
				<span className="text-xs font-semibold text-foreground truncate">
					{data.name}
				</span>
				{data.isRoot && (
					<span className="ml-auto text-[10px] text-primary font-medium">
						ROOT
					</span>
				)}
			</div>
			<div className="px-3 py-1 border-b border-border">
				<span className="text-[10px] text-muted-foreground truncate block">
					{data.relativePath ?? data.absolutePath}:{data.line}
				</span>
			</div>
			<div className="max-h-[140px] overflow-hidden">
				<pre className="text-[11px] leading-[1.4] p-2 overflow-x-auto font-mono text-foreground/80 whitespace-pre">
					{data.codeSnippet
						.split("\n")
						.slice(0, 8)
						.map((codeLine, i) => {
							const lineNum = data.snippetStartLine + i;
							return (
								<div key={`${lineNum}:${codeLine}`} className="flex">
									<span className="text-muted-foreground/40 select-none w-8 text-right mr-2 shrink-0">
										{lineNum}
									</span>
									<span>{codeLine}</span>
								</div>
							);
						})}
				</pre>
			</div>
			<Handle
				type="source"
				position={Position.Bottom}
				className="!bg-muted-foreground !w-2 !h-2"
			/>
		</div>
	);
}

export const ReferenceNode = memo(ReferenceNodeComponent);
