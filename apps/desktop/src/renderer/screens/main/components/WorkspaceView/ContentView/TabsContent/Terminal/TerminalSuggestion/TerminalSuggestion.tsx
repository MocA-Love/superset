import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";

interface TerminalSuggestionProps {
	xterm: XTerm;
	suggestions: string[];
	selectedIndex: number;
	prefix: string;
}

const TERMINAL_PADDING = 8; // p-2
const MAX_VISIBLE_ITEMS = 8;
const ITEM_HEIGHT = 26;

function getCellDimensions(
	xterm: XTerm,
): { width: number; height: number } | null {
	const dimensions = (
		xterm as unknown as {
			_core?: {
				_renderService?: {
					dimensions?: { css: { cell: { width: number; height: number } } };
				};
			};
		}
	)._core?._renderService?.dimensions;

	if (!dimensions?.css?.cell) return null;
	const { width, height } = dimensions.css.cell;
	if (width <= 0 || height <= 0) return null;
	return { width, height };
}

export function TerminalSuggestion({
	xterm,
	suggestions,
	selectedIndex,
	prefix,
}: TerminalSuggestionProps) {
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[selectedIndex] as HTMLElement | undefined;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [selectedIndex]);

	const dims = getCellDimensions(xterm);
	if (!dims) return null;

	const cursorX = xterm.buffer.active.cursorX;
	const cursorY = xterm.buffer.active.cursorY;
	const terminalWidth = xterm.cols * dims.width;

	const rawDropdownLeft =
		TERMINAL_PADDING + Math.max(0, cursorX - prefix.length) * dims.width;
	const dropdownMaxWidth = Math.min(500, terminalWidth);
	const dropdownLeft = Math.min(
		rawDropdownLeft,
		TERMINAL_PADDING + terminalWidth - dropdownMaxWidth,
	);
	const dropdownTop = TERMINAL_PADDING + (cursorY + 1) * dims.height;

	const listMaxHeight = MAX_VISIBLE_ITEMS * ITEM_HEIGHT;
	const selected = suggestions[selectedIndex] ?? "";
	const suffix = selected.startsWith(prefix) ? selected.slice(prefix.length) : "";

	return (
		<div
			style={{
				position: "absolute",
				left: dropdownLeft,
				top: dropdownTop,
				zIndex: 20,
				minWidth: Math.min(200, terminalWidth),
				maxWidth: dropdownMaxWidth,
				borderRadius: 6,
				border: "1px solid rgba(255,255,255,0.1)",
				boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
				fontSize: `${(xterm.options.fontSize ?? 14) - 1}px`,
				fontFamily: xterm.options.fontFamily,
				pointerEvents: "none",
				userSelect: "none",
				backdropFilter: "blur(12px)",
				backgroundColor: "rgba(30, 30, 46, 0.92)",
			}}
		>
			{/* Full command preview */}
			<div
				style={{
					padding: "5px 10px",
					color: "#cdd6f4",
					borderBottom: "1px solid rgba(255,255,255,0.06)",
					whiteSpace: "pre-wrap",
					wordBreak: "break-all",
					lineHeight: 1.4,
				}}
			>
				<span style={{ color: "#89b4fa" }}>{prefix}</span>
				<span style={{ color: "#a6e3a1" }}>{suffix}</span>
			</div>

			{/* Scrollable item list */}
			<div
				ref={listRef}
				style={{
					maxHeight: listMaxHeight,
					overflowY: "auto",
				}}
			>
				{suggestions.map((cmd, i) => (
					<div
						key={cmd}
						style={{
							padding: "4px 10px",
							color: i === selectedIndex ? "#cdd6f4" : "#a6adc8",
							backgroundColor:
								i === selectedIndex
									? "rgba(137, 180, 250, 0.15)"
									: "transparent",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							borderLeft:
								i === selectedIndex
									? "2px solid #89b4fa"
									: "2px solid transparent",
						}}
					>
						<span style={{ color: "#89b4fa" }}>{prefix}</span>
						{cmd.slice(prefix.length)}
					</div>
				))}
			</div>

			{/* Footer */}
			<div
				style={{
					padding: "4px 10px 2px",
					fontSize: "0.85em",
					color: "#585b70",
					borderTop: "1px solid rgba(255,255,255,0.06)",
				}}
			>
				<span style={{ color: "#6c7086" }}>↑↓</span> navigate{" "}
				<span style={{ color: "#6c7086" }}>→</span> accept{" "}
				<span style={{ color: "#6c7086" }}>esc</span> dismiss
			</div>
		</div>
	);
}
