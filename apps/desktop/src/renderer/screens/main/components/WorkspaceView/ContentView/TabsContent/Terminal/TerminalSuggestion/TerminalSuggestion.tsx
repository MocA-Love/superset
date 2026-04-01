import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { TerminalHistorySuggestion } from "../hooks/useTerminalSuggestion";

interface TerminalSuggestionProps {
	xterm: XTerm;
	suggestions: TerminalHistorySuggestion[];
	selectedIndex: number;
	prefix: string;
	onDelete?: (cmd: string) => void;
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

function formatLastRunAgo(lastRunAt: number | null): string {
	if (!lastRunAt) return "";

	const diffMs = Date.now() - lastRunAt;
	const minuteMs = 60_000;
	const hourMs = 60 * minuteMs;
	const dayMs = 24 * hourMs;
	const weekMs = 7 * dayMs;
	const monthMs = 30 * dayMs;
	const yearMs = 365 * dayMs;

	if (diffMs < minuteMs) {
		return `${Math.max(1, Math.floor(diffMs / 1000))}s ago`;
	}

	if (diffMs < hourMs) {
		return `${Math.floor(diffMs / minuteMs)}m ago`;
	}

	if (diffMs < dayMs) {
		return `${Math.floor(diffMs / hourMs)}h ago`;
	}

	if (diffMs < weekMs) {
		return `${Math.floor(diffMs / dayMs)}d ago`;
	}

	if (diffMs < monthMs) {
		return `${Math.floor(diffMs / weekMs)}w ago`;
	}

	if (diffMs < yearMs) {
		return `${Math.floor(diffMs / monthMs)}mo ago`;
	}

	return `${Math.floor(diffMs / yearMs)}y ago`;
}

export function TerminalSuggestion({
	xterm,
	suggestions,
	selectedIndex,
	prefix,
	onDelete,
}: TerminalSuggestionProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const itemTextRefs = useRef<Array<HTMLSpanElement | null>>([]);
	const [isSelectedTruncated, setIsSelectedTruncated] = useState(false);

	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[selectedIndex] as HTMLElement | undefined;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [selectedIndex]);

	useEffect(() => {
		const selectedText = itemTextRefs.current[selectedIndex];
		if (!selectedText) {
			setIsSelectedTruncated(false);
			return;
		}

		setIsSelectedTruncated(
			selectedText.scrollWidth > selectedText.clientWidth + 1,
		);
	}, [prefix, selectedIndex, suggestions]);

	// Don't render in alternate screen (TUI apps like Claude Code)
	if (xterm.buffer.active.type === "alternate") return null;

	const dims = getCellDimensions(xterm);
	if (!dims) return null;

	const cursorX = xterm.buffer.active.cursorX;
	const cursorY = xterm.buffer.active.cursorY;
	const terminalWidth = xterm.cols * dims.width;
	const terminalHeight = xterm.rows * dims.height;

	const rawDropdownLeft =
		TERMINAL_PADDING + Math.max(0, cursorX - prefix.length) * dims.width;
	const dropdownMinWidth = Math.min(320, terminalWidth);
	const dropdownMaxWidth = Math.min(680, terminalWidth);
	const dropdownLeft = Math.min(
		rawDropdownLeft,
		TERMINAL_PADDING + terminalWidth - dropdownMaxWidth,
	);

	const listMaxHeight = MAX_VISIBLE_ITEMS * ITEM_HEIGHT;
	const FOOTER_HEIGHT = 24;
	const dropdownHeight =
		Math.min(suggestions.length, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT + FOOTER_HEIGHT;

	const belowCursorTop = TERMINAL_PADDING + (cursorY + 1) * dims.height;
	const spaceBelow = terminalHeight + TERMINAL_PADDING * 2 - belowCursorTop;

	// If not enough space below, show above the cursor
	const dropdownTop =
		spaceBelow >= dropdownHeight
			? belowCursorTop
			: Math.max(0, TERMINAL_PADDING + cursorY * dims.height - dropdownHeight);
	const selected = suggestions[selectedIndex]?.command ?? "";
	const suffix = selected.startsWith(prefix)
		? selected.slice(prefix.length)
		: "";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: terminal overlay, not interactive
		<div
			style={{
				position: "absolute",
				left: dropdownLeft,
				top: dropdownTop,
				zIndex: 20,
				minWidth: dropdownMinWidth,
				maxWidth: dropdownMaxWidth,
				borderRadius: 6,
				border: "1px solid rgba(255,255,255,0.1)",
				boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
				fontSize: `${(xterm.options.fontSize ?? 14) - 1}px`,
				fontFamily: xterm.options.fontFamily,
				userSelect: "none",
				backdropFilter: "blur(12px)",
				backgroundColor: "rgba(30, 30, 46, 0.92)",
			}}
			onMouseDown={(e) => e.preventDefault()}
		>
			{isSelectedTruncated && selected && (
				<div
					style={{
						position: "absolute",
						left: 8,
						right: 8,
						top: "calc(100% + 6px)",
						padding: "6px 8px",
						borderRadius: 6,
						border: "1px solid rgba(255,255,255,0.12)",
						backgroundColor: "rgba(17, 17, 27, 0.96)",
						color: "#cdd6f4",
						boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						lineHeight: 1.35,
						pointerEvents: "none",
						zIndex: 21,
					}}
				>
					{selected}
				</div>
			)}
			{/* Scrollable item list */}
			<div
				ref={listRef}
				className="hide-scrollbar"
				style={{
					maxHeight: listMaxHeight,
					overflowY: "auto",
				}}
			>
				{suggestions.map((suggestion, i) => (
					<div
						key={`${suggestion.command}:${suggestion.lastRunAt ?? "none"}`}
						className="group/item"
						style={{
							padding: "4px 6px 4px 10px",
							display: "flex",
							alignItems: "center",
							gap: 6,
							color:
								i === selectedIndex
									? "#cdd6f4"
									: "#a6adc8",
							backgroundColor:
								i === selectedIndex
									? "rgba(137, 180, 250, 0.15)"
									: "transparent",
							borderLeft:
								i === selectedIndex
									? "2px solid #89b4fa"
									: "2px solid transparent",
						}}
					>
						<span
							ref={(element) => {
								itemTextRefs.current[i] = element;
							}}
							style={{
								flex: 1,
								minWidth: 0,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							<span style={{ color: "#89b4fa" }}>{prefix}</span>
							{suggestion.command.slice(prefix.length)}
						</span>
						<span
							style={{
								flexShrink: 0,
								minWidth: 48,
								color: i === selectedIndex ? "#9399b2" : "#6c7086",
								fontSize: "0.85em",
								textAlign: "right",
								whiteSpace: "nowrap",
							}}
						>
							{formatLastRunAgo(suggestion.lastRunAt)}
						</span>
						{onDelete && (
							<button
								type="button"
								onClick={() => onDelete(suggestion.command)}
								aria-label="Delete from history"
								className="opacity-0 group-hover/item:opacity-100"
								style={{
									background: "none",
									border: "none",
									color: "#585b70",
									cursor: "pointer",
									padding: "0 2px",
									fontSize: "0.9em",
									lineHeight: 1,
									flexShrink: 0,
									transition: "color 0.15s",
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.color = "#f38ba8";
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.color = "#585b70";
								}}
							>
								✕
							</button>
						)}
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
				<span style={{ color: "#6c7086" }}>enter</span> run{" "}
				<span style={{ color: "#6c7086" }}>→</span> fill{" "}
				<span style={{ color: "#6c7086" }}>esc</span> dismiss
			</div>
		</div>
	);
}
