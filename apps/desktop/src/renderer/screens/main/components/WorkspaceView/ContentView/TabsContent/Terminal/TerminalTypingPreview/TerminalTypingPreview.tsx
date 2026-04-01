import type { Terminal as XTerm } from "@xterm/xterm";

interface TerminalTypingPreviewProps {
	xterm: XTerm;
	text: string;
}

const TERMINAL_PADDING = 8;

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

export function TerminalTypingPreview({
	xterm,
	text,
}: TerminalTypingPreviewProps) {
	if (!text || xterm.buffer.active.type === "alternate") return null;

	const dims = getCellDimensions(xterm);
	if (!dims) return null;

	const cursorX = xterm.buffer.active.cursorX;
	const cursorY = xterm.buffer.active.cursorY;
	const terminalWidth = xterm.cols * dims.width;
	const terminalHeight = xterm.rows * dims.height;
	const left = TERMINAL_PADDING + cursorX * dims.width;
	const top = TERMINAL_PADDING + cursorY * dims.height;
	const foreground = xterm.options.theme?.foreground ?? "#cdd6f4";

	return (
		<div
			aria-hidden="true"
			style={{
				position: "absolute",
				left,
				top,
				maxWidth: Math.max(0, terminalWidth - left),
				maxHeight: Math.max(0, terminalHeight - top),
				color: foreground,
				fontSize: `${xterm.options.fontSize ?? 14}px`,
				fontFamily: xterm.options.fontFamily,
				lineHeight: `${dims.height}px`,
				pointerEvents: "none",
				whiteSpace: "pre",
				overflow: "hidden",
				textShadow: "0 0 0.35px currentColor",
				zIndex: 15,
			}}
		>
			{text}
		</div>
	);
}
