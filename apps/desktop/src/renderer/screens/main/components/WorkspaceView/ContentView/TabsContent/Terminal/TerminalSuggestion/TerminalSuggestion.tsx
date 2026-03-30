import type { Terminal as XTerm } from "@xterm/xterm";

interface TerminalSuggestionProps {
	xterm: XTerm;
	/** [currentInput, ...historySuggestions] */
	suggestions: string[];
	selectedIndex: number;
	prefix: string;
	ghostText: string | null;
}

const TERMINAL_PADDING = 8; // p-2

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
	ghostText,
}: TerminalSuggestionProps) {
	const dims = getCellDimensions(xterm);
	if (!dims) return null;

	const cursorX = xterm.buffer.active.cursorX;
	const cursorY = xterm.buffer.active.cursorY;

	const fgColor = xterm.options.theme?.foreground || "#e0e0e0";

	// Ghost text overlay at cursor position (only when history item selected)
	const truncatedGhost = ghostText
		? ghostText.length > xterm.cols - cursorX
			? ghostText.slice(0, xterm.cols - cursorX)
			: ghostText
		: null;

	const ghostLeft = TERMINAL_PADDING + cursorX * dims.width;
	const ghostTop = TERMINAL_PADDING + cursorY * dims.height;

	// Terminal content width
	const terminalWidth = xterm.cols * dims.width;

	// Dropdown position
	const rawDropdownLeft =
		TERMINAL_PADDING + Math.max(0, cursorX - prefix.length) * dims.width;
	const dropdownMaxWidth = Math.min(500, terminalWidth);
	const dropdownLeft = Math.min(
		rawDropdownLeft,
		TERMINAL_PADDING + terminalWidth - dropdownMaxWidth,
	);
	const dropdownTop = TERMINAL_PADDING + (cursorY + 1) * dims.height;

	return (
		<>
			{/* Ghost text */}
			{truncatedGhost && (
				<span
					style={{
						position: "absolute",
						left: ghostLeft,
						top: ghostTop,
						height: dims.height,
						color: fgColor,
						opacity: 0.35,
						fontFamily: xterm.options.fontFamily,
						fontSize: `${xterm.options.fontSize}px`,
						lineHeight: `${dims.height}px`,
						pointerEvents: "none",
						whiteSpace: "pre",
						zIndex: 1,
						userSelect: "none",
					}}
				>
					{truncatedGhost}
				</span>
			)}

			{/* Dropdown list */}
			{suggestions.length > 1 && (
				<div
					style={{
						position: "absolute",
						left: dropdownLeft,
						top: dropdownTop,
						zIndex: 20,
						minWidth: Math.min(200, terminalWidth),
						maxWidth: dropdownMaxWidth,
						overflowY: "hidden",
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
			)}
		</>
	);
}
