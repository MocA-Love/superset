import type { FileDragBehavior } from "@superset/local-db";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DEFAULT_FILE_DRAG_BEHAVIOR } from "shared/constants";

let cachedFileDragBehavior: FileDragBehavior = DEFAULT_FILE_DRAG_BEHAVIOR;

/** Non-React getter, kept in sync by useFileDragBehavior(). */
export function getFileDragBehavior(): FileDragBehavior {
	return cachedFileDragBehavior;
}

export function useFileDragBehavior(): FileDragBehavior {
	const { data } = electronTrpc.settings.getFileDragBehavior.useQuery();
	const behavior = data ?? DEFAULT_FILE_DRAG_BEHAVIOR;
	cachedFileDragBehavior = behavior;
	return behavior;
}
