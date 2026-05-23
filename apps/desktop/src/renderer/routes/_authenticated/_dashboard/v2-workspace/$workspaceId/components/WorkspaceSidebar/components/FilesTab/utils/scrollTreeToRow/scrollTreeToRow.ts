import { type FileTree, prepareFileTreeInput } from "@pierre/trees";
import { asDirectoryHandle } from "../treePath";

/**
 * Center a file-tree row in the viewport.
 *
 * Pierre auto-scrolls focused rows only when DOM focus lives inside the tree,
 * so programmatic reveals need to replicate Pierre's sorted visible-row math.
 */
export function scrollTreeToRow(
	model: FileTree,
	knownPaths: ReadonlySet<string>,
	targetKey: string,
	itemHeight: number,
): boolean {
	const scrollEl = model
		.getFileTreeContainer()
		?.shadowRoot?.querySelector('[data-file-tree-virtualized-scroll="true"]');
	if (!(scrollEl instanceof HTMLElement)) return false;

	const visibleIndex = computeVisibleRowIndex(targetKey, knownPaths, model);
	if (visibleIndex < 0) return false;

	const viewportHeight = scrollEl.clientHeight;
	const targetTop = visibleIndex * itemHeight;
	const targetBottom = targetTop + itemHeight;
	const currentTop = scrollEl.scrollTop;
	const currentBottom = currentTop + viewportHeight;

	if (targetTop >= currentTop && targetBottom <= currentBottom) return true;
	scrollEl.scrollTop = Math.max(
		0,
		targetTop - (viewportHeight - itemHeight) / 2,
	);
	return true;
}

function computeVisibleRowIndex(
	targetKey: string,
	knownPaths: ReadonlySet<string>,
	model: FileTree,
): number {
	const prepared = prepareFileTreeInput(Array.from(knownPaths));
	let index = 0;
	for (const path of prepared.paths) {
		if (path === targetKey) {
			return isPathVisible(path, model) ? index : -1;
		}
		if (isPathVisible(path, model)) index++;
	}
	return -1;
}

function isPathVisible(path: string, model: FileTree): boolean {
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	let lastSlash = trimmed.lastIndexOf("/");
	if (lastSlash < 0) return true;
	let parent = trimmed.slice(0, lastSlash);
	while (parent) {
		const handle = asDirectoryHandle(model.getItem(`${parent}/`));
		if (!handle?.isExpanded()) return false;
		lastSlash = parent.lastIndexOf("/");
		if (lastSlash < 0) break;
		parent = parent.slice(0, lastSlash);
	}
	return true;
}
