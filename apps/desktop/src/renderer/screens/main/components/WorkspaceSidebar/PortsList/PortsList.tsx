import { COMPANY } from "@superset/shared/constants";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useCallback, useRef } from "react";
import {
	LuChevronRight,
	LuCircleHelp,
	LuFilter,
	LuRadioTower,
} from "react-icons/lu";
import { usePortsStore } from "renderer/stores";
import { MIN_LIST_HEIGHT, MAX_LIST_HEIGHT } from "renderer/stores/ports/store";
import { STROKE_WIDTH } from "../constants";
import { WorkspacePortGroup } from "./components/WorkspacePortGroup";
import { usePortsData } from "./hooks/usePortsData";

const PORTS_DOCS_URL = `${COMPANY.DOCS_URL}/ports`;

export function PortsList() {
	const isCollapsed = usePortsStore((s) => s.isListCollapsed);
	const toggleCollapsed = usePortsStore((s) => s.toggleListCollapsed);
	const listHeight = usePortsStore((s) => s.listHeight);
	const setListHeight = usePortsStore((s) => s.setListHeight);
	const showConfiguredOnly = usePortsStore((s) => s.showConfiguredOnly);
	const setShowConfiguredOnly = usePortsStore((s) => s.setShowConfiguredOnly);

	const { workspacePortGroups, totalPortCount } = usePortsData();

	// --- Drag-to-resize handle ---
	const isDragging = useRef(false);
	const startY = useRef(0);
	const startHeight = useRef(0);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			isDragging.current = true;
			startY.current = e.clientY;
			startHeight.current = listHeight;

			const handleMouseMove = (ev: MouseEvent) => {
				if (!isDragging.current) return;
				// Dragging UP increases height (handle is at top of list)
				const delta = startY.current - ev.clientY;
				setListHeight(startHeight.current + delta);
			};
			const handleMouseUp = () => {
				isDragging.current = false;
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
			};
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		},
		[listHeight, setListHeight],
	);

	if (totalPortCount === 0 && !showConfiguredOnly) {
		return null;
	}

	const handleOpenPortsDocs = (e: React.MouseEvent) => {
		e.stopPropagation();
		window.open(PORTS_DOCS_URL, "_blank");
	};

	return (
		<div className="shrink-0 border-t border-border">
			{/* Resize handle */}
			{!isCollapsed && (
				<div
					className="h-1.5 cursor-ns-resize hover:bg-primary/20 active:bg-primary/40 transition-colors flex items-center justify-center"
					onMouseDown={handleMouseDown}
				>
					<div className="w-8 h-px bg-muted-foreground/30" />
				</div>
			)}
			<div className="group text-[11px] uppercase tracking-wider text-muted-foreground/70 px-3 pb-2 font-medium flex items-center gap-1.5 w-full hover:text-muted-foreground transition-colors">
				<button
					type="button"
					aria-expanded={!isCollapsed}
					onClick={toggleCollapsed}
					className="flex items-center gap-1.5 focus-visible:text-muted-foreground focus-visible:outline-none"
				>
					<LuChevronRight
						className={`size-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
						strokeWidth={STROKE_WIDTH}
					/>
					<LuRadioTower className="size-3" strokeWidth={STROKE_WIDTH} />
					Ports
				</button>

				<Tooltip delayDuration={300}>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => setShowConfiguredOnly(!showConfiguredOnly)}
							className={`p-0.5 rounded transition-colors ${
								showConfiguredOnly
									? "text-primary bg-primary/10"
									: "hover:bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity"
							}`}
						>
							<LuFilter
								className="size-3"
								strokeWidth={STROKE_WIDTH}
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent side="top" sideOffset={4}>
						<p className="text-xs">
							{showConfiguredOnly
								? "Show all ports"
								: "Show only ports.json ports"}
						</p>
					</TooltipContent>
				</Tooltip>

				<Tooltip delayDuration={300}>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={handleOpenPortsDocs}
							className="p-0.5 rounded hover:bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity"
						>
							<LuCircleHelp
								className="size-3"
								strokeWidth={STROKE_WIDTH}
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent side="top" sideOffset={4}>
						<p className="text-xs">
							Learn about static port configuration
						</p>
					</TooltipContent>
				</Tooltip>
				<span className="ml-auto text-[10px] font-normal">
					{totalPortCount}
				</span>
			</div>
			{!isCollapsed && (
				<div
					className="space-y-2 overflow-y-auto pb-1 hide-scrollbar"
					style={{
						height: listHeight,
					}}
				>
					{workspacePortGroups.length > 0 ? (
						workspacePortGroups.map((group) => (
							<WorkspacePortGroup key={group.workspaceId} group={group} />
						))
					) : showConfiguredOnly ? (
						<p className="px-3 py-2 text-[10px] text-muted-foreground/50">
							No ports defined in ports.json
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}
