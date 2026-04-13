import type { ChangedFile } from "shared/changes-types";
import type { ChangesViewMode } from "../../types";
import { sortFilesForCompactView } from "./compact-view";

/**
 * Return the flat visual order of files as rendered by each FileList view
 * mode. This MUST match the per-variant sort logic:
 *
 *  - compact → {@link sortFilesForCompactView} (filename A-Z)
 *  - grouped → folder A-Z, files within a folder A-Z (mirrors
 *    `groupFilesByFolder` in FileListGrouped)
 *  - tree    → DFS, folders before files at each level, name A-Z
 *    (mirrors `buildFileTree` in FileListTree)
 *
 * Used by the multi-select range selection so that shift-clicking
 * produces a contiguous selection that matches what the user sees.
 * The tree mode order assumes all folders are expanded — collapsed
 * folders will still contribute their files, which is an acceptable
 * approximation until we thread the expand/collapse state here.
 */
export function orderFilesForViewMode(
	files: ChangedFile[],
	viewMode: ChangesViewMode,
): ChangedFile[] {
	if (viewMode === "compact") {
		return sortFilesForCompactView(files);
	}
	if (viewMode === "grouped") {
		return groupedFlatOrder(files);
	}
	if (viewMode === "tree") {
		return treeFlatOrder(files);
	}
	return files;
}

function groupedFlatOrder(files: ChangedFile[]): ChangedFile[] {
	const folderMap = new Map<string, ChangedFile[]>();
	for (const file of files) {
		const parts = file.path.split("/");
		const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
		const list = folderMap.get(folderPath);
		if (list) {
			list.push(file);
		} else {
			folderMap.set(folderPath, [file]);
		}
	}
	const groups = Array.from(folderMap.entries())
		.map(([folderPath, groupFiles]) => ({
			folderPath,
			files: [...groupFiles].sort((a, b) => {
				const aName = a.path.split("/").pop() ?? "";
				const bName = b.path.split("/").pop() ?? "";
				return aName.localeCompare(bName);
			}),
		}))
		.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
	return groups.flatMap((g) => g.files);
}

interface TreeOrderingNode {
	name: string;
	type: "file" | "folder";
	file?: ChangedFile;
	children?: Map<string, TreeOrderingNode>;
}

function treeFlatOrder(files: ChangedFile[]): ChangedFile[] {
	const root = new Map<string, TreeOrderingNode>();
	for (const file of files) {
		const parts = file.path.split("/");
		let current = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (part === undefined) continue;
			const isLast = i === parts.length - 1;
			let node = current.get(part);
			if (!node) {
				node = {
					name: part,
					type: isLast ? "file" : "folder",
					file: isLast ? file : undefined,
					children: isLast ? undefined : new Map(),
				};
				current.set(part, node);
			}
			if (!isLast && node.children) {
				current = node.children;
			}
		}
	}
	const result: ChangedFile[] = [];
	const walk = (nodes: Map<string, TreeOrderingNode>) => {
		const sorted = [...nodes.values()].sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === "folder" ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
		for (const node of sorted) {
			if (node.type === "file" && node.file) {
				result.push(node.file);
			} else if (node.children) {
				walk(node.children);
			}
		}
	};
	walk(root);
	return result;
}
