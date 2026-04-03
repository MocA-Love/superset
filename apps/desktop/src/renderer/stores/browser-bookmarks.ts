import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import {
	type BrowserBookmarkFolderIconKey,
	isBrowserBookmarkFolderIconKey,
} from "./browser-bookmark-folder-icons";

export interface BrowserBookmark {
	id: string;
	type: "bookmark";
	url: string;
	title: string;
	faviconUrl?: string;
	createdAt: number;
}

export interface BrowserBookmarkFolder {
	id: string;
	type: "folder";
	title: string;
	iconKey?: BrowserBookmarkFolderIconKey;
	color?: string | null;
	children: BrowserBookmarkTreeNode[];
	createdAt: number;
}

export type BrowserBookmarkTreeNode = BrowserBookmark | BrowserBookmarkFolder;

export interface BrowserBookmarkInput {
	url: string;
	title: string;
	faviconUrl?: string;
	folderId?: string | null;
}

export interface BrowserBookmarkFolderInput {
	title: string;
	iconKey?: BrowserBookmarkFolderIconKey;
	color?: string | null;
}

interface FolderOption {
	id: string;
	label: string;
}

interface BrowserBookmarksState {
	bookmarks: BrowserBookmarkTreeNode[];
	addBookmark: (bookmark: BrowserBookmarkInput) => BrowserBookmark | null;
	duplicateBookmark: (bookmarkId: string) => BrowserBookmark | null;
	updateBookmark: (
		bookmarkId: string,
		bookmark: BrowserBookmarkInput,
	) => BrowserBookmark | null;
	addFolder: (folder: BrowserBookmarkFolderInput) => BrowserBookmarkFolder;
	updateFolder: (
		folderId: string,
		folder: BrowserBookmarkFolderInput,
	) => BrowserBookmarkFolder | null;
	reorderFolderChildren: (
		folderId: string,
		activeId: string,
		overId: string,
	) => void;
	removeNode: (nodeId: string) => void;
	moveNode: (activeId: string, overId: string) => void;
	toggleBookmark: (bookmark: BrowserBookmarkInput) => boolean;
	importBookmarks: (nodes: BrowserBookmarkTreeNode[]) => {
		bookmarksAdded: number;
		foldersAdded: number;
		skipped: number;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isBrowserBookmark(
	node: BrowserBookmarkTreeNode,
): node is BrowserBookmark {
	return node.type === "bookmark";
}

export function isBrowserBookmarkFolder(
	node: BrowserBookmarkTreeNode,
): node is BrowserBookmarkFolder {
	return node.type === "folder";
}

export function normalizeBookmarkUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed || trimmed === "about:blank") return trimmed;

	try {
		const parsed = new URL(trimmed);
		if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
			return parsed.origin;
		}
		return parsed.toString();
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
	if (fromIndex === toIndex) return items;
	const nextItems = [...items];
	const [movedItem] = nextItems.splice(fromIndex, 1);
	if (!movedItem) return items;
	nextItems.splice(toIndex, 0, movedItem);
	return nextItems;
}

function findNodeById(
	nodes: BrowserBookmarkTreeNode[],
	nodeId: string,
): BrowserBookmarkTreeNode | undefined {
	for (const node of nodes) {
		if (node.id === nodeId) return node;
		if (isBrowserBookmarkFolder(node)) {
			const childMatch = findNodeById(node.children, nodeId);
			if (childMatch) return childMatch;
		}
	}
	return undefined;
}

export function findBookmarkByUrl(
	nodes: BrowserBookmarkTreeNode[],
	url: string,
): BrowserBookmark | undefined {
	const normalizedUrl = normalizeBookmarkUrl(url);
	for (const node of nodes) {
		if (isBrowserBookmark(node)) {
			if (normalizeBookmarkUrl(node.url) === normalizedUrl) {
				return node;
			}
			continue;
		}
		const childMatch = findBookmarkByUrl(node.children, normalizedUrl);
		if (childMatch) return childMatch;
	}
	return undefined;
}

function findBookmarkByUrlExcludingId(
	nodes: BrowserBookmarkTreeNode[],
	url: string,
	excludedId?: string,
): BrowserBookmark | undefined {
	const normalizedUrl = normalizeBookmarkUrl(url);
	for (const node of nodes) {
		if (isBrowserBookmark(node)) {
			if (
				node.id !== excludedId &&
				normalizeBookmarkUrl(node.url) === normalizedUrl
			) {
				return node;
			}
			continue;
		}
		const childMatch = findBookmarkByUrlExcludingId(
			node.children,
			normalizedUrl,
			excludedId,
		);
		if (childMatch) return childMatch;
	}
	return undefined;
}

export function findBookmarkParentFolderId(
	nodes: BrowserBookmarkTreeNode[],
	bookmarkId: string,
	parentFolderId: string | null = null,
): string | null {
	for (const node of nodes) {
		if (isBrowserBookmark(node)) {
			if (node.id === bookmarkId) return parentFolderId;
			continue;
		}
		const childMatch = findBookmarkParentFolderId(
			node.children,
			bookmarkId,
			node.id,
		);
		if (childMatch !== null) return childMatch;
	}
	return null;
}

export function getBookmarkFolderOptions(
	nodes: BrowserBookmarkTreeNode[],
	parentTitles: string[] = [],
): FolderOption[] {
	return nodes.flatMap((node) => {
		if (!isBrowserBookmarkFolder(node)) return [];
		const titles = [...parentTitles, node.title.trim() || "Untitled Folder"];
		return [
			{ id: node.id, label: titles.join(" / ") },
			...getBookmarkFolderOptions(node.children, titles),
		];
	});
}

export function folderContainsBookmarkUrl(
	folder: BrowserBookmarkFolder,
	url: string,
): boolean {
	const normalizedUrl = normalizeBookmarkUrl(url);
	return folder.children.some((node) => {
		if (isBrowserBookmark(node)) {
			return normalizeBookmarkUrl(node.url) === normalizedUrl;
		}
		return folderContainsBookmarkUrl(node, normalizedUrl);
	});
}

function removeNodeFromTree(
	nodes: BrowserBookmarkTreeNode[],
	nodeId: string,
): { nodes: BrowserBookmarkTreeNode[]; removed?: BrowserBookmarkTreeNode } {
	let removed: BrowserBookmarkTreeNode | undefined;
	const nextNodes: BrowserBookmarkTreeNode[] = [];

	for (const node of nodes) {
		if (node.id === nodeId) {
			removed = node;
			continue;
		}

		if (isBrowserBookmarkFolder(node)) {
			const childResult = removeNodeFromTree(node.children, nodeId);
			if (childResult.removed) {
				removed = childResult.removed;
				nextNodes.push({ ...node, children: childResult.nodes });
				continue;
			}
		}

		nextNodes.push(node);
	}

	return { nodes: nextNodes, removed };
}

function insertNodeIntoFolder(
	nodes: BrowserBookmarkTreeNode[],
	nodeToInsert: BrowserBookmarkTreeNode,
	folderId: string,
): { nodes: BrowserBookmarkTreeNode[]; inserted: boolean } {
	let inserted = false;
	const nextNodes = nodes.map((node) => {
		if (!isBrowserBookmarkFolder(node)) {
			return node;
		}

		if (node.id === folderId) {
			inserted = true;
			return {
				...node,
				children: [...node.children, nodeToInsert],
			};
		}

		const childResult = insertNodeIntoFolder(
			node.children,
			nodeToInsert,
			folderId,
		);
		if (childResult.inserted) {
			inserted = true;
			return {
				...node,
				children: childResult.nodes,
			};
		}

		return node;
	});

	return { nodes: nextNodes, inserted };
}

function reorderFolderChildrenInTree(
	nodes: BrowserBookmarkTreeNode[],
	folderId: string,
	activeId: string,
	overId: string,
): { nodes: BrowserBookmarkTreeNode[]; reordered: boolean } {
	let reordered = false;

	const nextNodes = nodes.map((node) => {
		if (!isBrowserBookmarkFolder(node)) {
			return node;
		}

		if (node.id === folderId) {
			const fromIndex = node.children.findIndex(
				(child) => child.id === activeId,
			);
			const toIndex = node.children.findIndex((child) => child.id === overId);
			if (fromIndex < 0 || toIndex < 0) {
				return node;
			}

			reordered = true;
			return {
				...node,
				children: moveItem(node.children, fromIndex, toIndex),
			};
		}

		const childResult = reorderFolderChildrenInTree(
			node.children,
			folderId,
			activeId,
			overId,
		);
		if (!childResult.reordered) {
			return node;
		}

		reordered = true;
		return {
			...node,
			children: childResult.nodes,
		};
	});

	return { nodes: nextNodes, reordered };
}

function sanitizeLegacyNodes(value: unknown): BrowserBookmarkTreeNode[] {
	if (!Array.isArray(value)) return [];

	return value.flatMap((entry): BrowserBookmarkTreeNode[] => {
		if (!isRecord(entry)) return [];

		const title =
			typeof entry.title === "string" && entry.title.trim()
				? entry.title.trim()
				: "Untitled";
		const createdAt =
			typeof entry.createdAt === "number" ? entry.createdAt : Date.now();
		const id =
			typeof entry.id === "string" && entry.id ? entry.id : crypto.randomUUID();

		if (entry.type === "folder") {
			return [
				{
					id,
					type: "folder" as const,
					title,
					iconKey: isBrowserBookmarkFolderIconKey(entry.iconKey)
						? entry.iconKey
						: undefined,
					color: typeof entry.color === "string" ? entry.color : null,
					createdAt,
					children: sanitizeLegacyNodes(entry.children),
				},
			];
		}

		const normalizedUrl = normalizeBookmarkUrl(
			typeof entry.url === "string" ? entry.url : "",
		);
		if (!normalizedUrl || normalizedUrl === "about:blank") {
			return [];
		}

		return [
			{
				id,
				type: "bookmark" as const,
				url: normalizedUrl,
				title: title === "Untitled" ? normalizedUrl : title,
				faviconUrl:
					typeof entry.faviconUrl === "string" ? entry.faviconUrl : undefined,
				createdAt,
			},
		];
	});
}

function cloneImportedNodes(nodes: BrowserBookmarkTreeNode[]): {
	nodes: BrowserBookmarkTreeNode[];
	bookmarksAdded: number;
	foldersAdded: number;
	skipped: number;
} {
	let bookmarksAdded = 0;
	let foldersAdded = 0;
	let skipped = 0;

	const clonedNodes: BrowserBookmarkTreeNode[] = nodes.flatMap(
		(node): BrowserBookmarkTreeNode[] => {
			if (isBrowserBookmark(node)) {
				const normalizedUrl = normalizeBookmarkUrl(node.url);
				if (!normalizedUrl || normalizedUrl === "about:blank") {
					skipped += 1;
					return [];
				}

				bookmarksAdded += 1;
				return [
					{
						id: crypto.randomUUID(),
						type: "bookmark" as const,
						url: normalizedUrl,
						title: node.title.trim() || normalizedUrl,
						faviconUrl: node.faviconUrl,
						createdAt: node.createdAt || Date.now(),
					},
				];
			}

			const nestedResult = cloneImportedNodes(node.children);
			bookmarksAdded += nestedResult.bookmarksAdded;
			foldersAdded += nestedResult.foldersAdded + 1;
			skipped += nestedResult.skipped;

			return [
				{
					id: crypto.randomUUID(),
					type: "folder" as const,
					title: node.title.trim() || "Untitled Folder",
					iconKey: node.iconKey,
					color: node.color ?? null,
					createdAt: node.createdAt || Date.now(),
					children: nestedResult.nodes,
				},
			];
		},
	);

	return { nodes: clonedNodes, bookmarksAdded, foldersAdded, skipped };
}

export const useBrowserBookmarksStore = create<BrowserBookmarksState>()(
	devtools(
		persist(
			(set, get) => ({
				bookmarks: [],

				addBookmark: (bookmark) => {
					const normalizedUrl = normalizeBookmarkUrl(bookmark.url);
					if (!normalizedUrl || normalizedUrl === "about:blank") {
						return null;
					}

					const existingBookmark = findBookmarkByUrl(
						get().bookmarks,
						normalizedUrl,
					);
					if (existingBookmark) {
						return existingBookmark;
					}

					const nextBookmark: BrowserBookmark = {
						id: crypto.randomUUID(),
						type: "bookmark",
						url: normalizedUrl,
						title: bookmark.title.trim() || normalizedUrl,
						faviconUrl: bookmark.faviconUrl,
						createdAt: Date.now(),
					};

					set((state) => {
						if (!bookmark.folderId) {
							return { bookmarks: [...state.bookmarks, nextBookmark] };
						}

						const inserted = insertNodeIntoFolder(
							state.bookmarks,
							nextBookmark,
							bookmark.folderId,
						);

						return {
							bookmarks: inserted.inserted
								? inserted.nodes
								: [...state.bookmarks, nextBookmark],
						};
					});

					return nextBookmark;
				},

				duplicateBookmark: (bookmarkId) => {
					const targetBookmark = findNodeById(get().bookmarks, bookmarkId);
					if (!targetBookmark || !isBrowserBookmark(targetBookmark)) {
						return null;
					}

					const duplicatedBookmark: BrowserBookmark = {
						...targetBookmark,
						id: crypto.randomUUID(),
						title: `${targetBookmark.title.trim() || targetBookmark.url} (Copy)`,
						createdAt: Date.now(),
					};
					const folderId = findBookmarkParentFolderId(
						get().bookmarks,
						bookmarkId,
					);

					set((state) => {
						if (!folderId) {
							return {
								bookmarks: [...state.bookmarks, duplicatedBookmark],
							};
						}

						const inserted = insertNodeIntoFolder(
							state.bookmarks,
							duplicatedBookmark,
							folderId,
						);

						return {
							bookmarks: inserted.inserted
								? inserted.nodes
								: [...state.bookmarks, duplicatedBookmark],
						};
					});

					return duplicatedBookmark;
				},

				updateBookmark: (bookmarkId, bookmark) => {
					const normalizedUrl = normalizeBookmarkUrl(bookmark.url);
					if (!normalizedUrl || normalizedUrl === "about:blank") {
						return null;
					}

					const targetBookmark = findNodeById(get().bookmarks, bookmarkId);
					if (!targetBookmark || !isBrowserBookmark(targetBookmark)) {
						return null;
					}

					if (
						normalizeBookmarkUrl(targetBookmark.url) !== normalizedUrl &&
						findBookmarkByUrlExcludingId(
							get().bookmarks,
							normalizedUrl,
							bookmarkId,
						)
					) {
						return null;
					}

					const updatedBookmark: BrowserBookmark = {
						...targetBookmark,
						url: normalizedUrl,
						title: bookmark.title.trim() || normalizedUrl,
						faviconUrl: bookmark.faviconUrl ?? targetBookmark.faviconUrl,
					};

					set((state) => {
						const removed = removeNodeFromTree(state.bookmarks, bookmarkId);
						let nextNodes = removed.nodes;

						if (bookmark.folderId) {
							const inserted = insertNodeIntoFolder(
								nextNodes,
								updatedBookmark,
								bookmark.folderId,
							);
							nextNodes = inserted.inserted
								? inserted.nodes
								: [...nextNodes, updatedBookmark];
						} else {
							nextNodes = [...nextNodes, updatedBookmark];
						}

						return { bookmarks: nextNodes };
					});

					return updatedBookmark;
				},

				addFolder: (folder) => {
					const nextFolder: BrowserBookmarkFolder = {
						id: crypto.randomUUID(),
						type: "folder",
						title: folder.title.trim() || "Untitled Folder",
						iconKey: folder.iconKey,
						color: folder.color ?? null,
						children: [],
						createdAt: Date.now(),
					};

					set((state) => ({
						bookmarks: [...state.bookmarks, nextFolder],
					}));

					return nextFolder;
				},

				updateFolder: (folderId, folder) => {
					const targetNode = findNodeById(get().bookmarks, folderId);
					if (!targetNode || !isBrowserBookmarkFolder(targetNode)) {
						return null;
					}

					const updatedFolder: BrowserBookmarkFolder = {
						...targetNode,
						title: folder.title.trim() || "Untitled Folder",
						iconKey: folder.iconKey,
						color: folder.color ?? null,
					};

					const replaceFolder = (
						nodes: BrowserBookmarkTreeNode[],
					): BrowserBookmarkTreeNode[] =>
						nodes.map((node) => {
							if (node.id === folderId && isBrowserBookmarkFolder(node)) {
								return updatedFolder;
							}
							if (isBrowserBookmarkFolder(node)) {
								return {
									...node,
									children: replaceFolder(node.children),
								};
							}
							return node;
						});

					set((state) => ({
						bookmarks: replaceFolder(state.bookmarks),
					}));

					return updatedFolder;
				},

				reorderFolderChildren: (folderId, activeId, overId) => {
					if (activeId === overId) return;
					set((state) => {
						const reordered = reorderFolderChildrenInTree(
							state.bookmarks,
							folderId,
							activeId,
							overId,
						);
						if (!reordered.reordered) {
							return state;
						}
						return { bookmarks: reordered.nodes };
					});
				},

				removeNode: (nodeId) => {
					set((state) => ({
						bookmarks: removeNodeFromTree(state.bookmarks, nodeId).nodes,
					}));
				},

				moveNode: (activeId, overId) => {
					if (activeId === overId) return;
					set((state) => {
						const fromIndex = state.bookmarks.findIndex(
							(node) => node.id === activeId,
						);
						const toIndex = state.bookmarks.findIndex(
							(node) => node.id === overId,
						);
						if (fromIndex < 0 || toIndex < 0) return state;
						return {
							bookmarks: moveItem(state.bookmarks, fromIndex, toIndex),
						};
					});
				},

				toggleBookmark: (bookmark) => {
					const existingBookmark = findBookmarkByUrl(
						get().bookmarks,
						bookmark.url,
					);
					if (existingBookmark) {
						get().removeNode(existingBookmark.id);
						return false;
					}

					return get().addBookmark(bookmark) !== null;
				},

				importBookmarks: (nodes) => {
					const result = cloneImportedNodes(nodes);
					set((state) => ({
						bookmarks: [...state.bookmarks, ...result.nodes],
					}));
					return {
						bookmarksAdded: result.bookmarksAdded,
						foldersAdded: result.foldersAdded,
						skipped: result.skipped,
					};
				},
			}),
			{
				name: "browser-bookmarks-store",
				version: 3,
				migrate: (persistedState) => {
					if (!isRecord(persistedState)) return { bookmarks: [] };
					return {
						...persistedState,
						bookmarks: sanitizeLegacyNodes(persistedState.bookmarks),
					};
				},
			},
		),
		{ name: "BrowserBookmarksStore" },
	),
);
