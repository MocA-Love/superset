import type { ReactNode } from "react";
import { isTearoffWindow } from "renderer/hooks/useTearoffInit";

interface ContentHeaderProps {
	/** Optional leading action */
	leadingAction?: ReactNode;
	/** Mode-specific header content (e.g., GroupStrip or file info) */
	children: ReactNode;
	/** Optional trailing action (e.g., SidebarControl) */
	trailingAction?: ReactNode;
}

const dragBarStyle: React.CSSProperties = {
	WebkitAppRegion: "drag",
} as React.CSSProperties;

export function ContentHeader({
	leadingAction,
	children,
	trailingAction,
}: ContentHeaderProps) {
	const isTearoff = isTearoffWindow();

	return (
		<>
			{isTearoff && (
				<div
					className="shrink-0 bg-background"
					style={{ height: 36, ...dragBarStyle }}
				/>
			)}
			<div className="flex items-end bg-background shrink-0 h-10 border-b">
				{leadingAction && (
					<div className="flex items-center h-10 pl-2">{leadingAction}</div>
				)}
				<div className="flex-1 min-w-0">{children}</div>
				{trailingAction && (
					<div className="flex items-center h-10 pr-2">{trailingAction}</div>
				)}
			</div>
		</>
	);
}
