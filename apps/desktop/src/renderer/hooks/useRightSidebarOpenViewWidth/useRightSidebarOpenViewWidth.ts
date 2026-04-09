import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	clampRightSidebarOpenViewWidth,
	DEFAULT_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
} from "shared/constants";

let cachedRightSidebarOpenViewWidth = DEFAULT_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH;

/** Non-React getter, kept in sync by useRightSidebarOpenViewWidth(). */
export function getRightSidebarOpenViewWidth(): number {
	return cachedRightSidebarOpenViewWidth;
}

export function useRightSidebarOpenViewWidth(): number {
	const { data } =
		electronTrpc.settings.getRightSidebarOpenViewWidth.useQuery();
	const width = clampRightSidebarOpenViewWidth(
		data ?? DEFAULT_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
	);
	cachedRightSidebarOpenViewWidth = width;
	return width;
}
