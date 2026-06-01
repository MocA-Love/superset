import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { workspaceTrpc } from "@superset/workspace-client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuChevronsDownUp, LuRefreshCw, LuX } from "react-icons/lu";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	buildSupersetOpenLink,
	type SupersetLinkProject,
} from "renderer/lib/superset-open-links";
import { useWorkspaceFileEvents } from "renderer/screens/main/components/WorkspaceView/hooks/useWorkspaceFileEvents";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { useSearchDialogStore } from "renderer/stores/search-dialog-state";
import { SearchFileGroup } from "./components/SearchFileGroup";
import { SearchToolbar } from "./components/SearchToolbar";
import { SearchTreeNode } from "./components/SearchTreeNode";
import { useContentSearch } from "./hooks/useContentSearch";
import { useWorkspaceContentSearch } from "./hooks/useWorkspaceContentSearch";
import type {
	SearchContentResult,
	SearchLineResult,
	SearchResultGroup,
	SearchTreeFolderNode,
	SearchTreeNode as SearchTreeNodeType,
} from "./types";
import { replaceSearchMatchesInLineInContent } from "./utils/searchPattern/searchPattern";

function groupSearchResults(
	results: SearchContentResult[],
): SearchResultGroup[] {
	const groups = new Map<string, SearchResultGroup>();

	for (const result of results) {
		const existing = groups.get(result.absolutePath);
		if (existing) {
			existing.matches.push(result);
			continue;
		}

		groups.set(result.absolutePath, {
			absolutePath: result.absolutePath,
			relativePath: result.relativePath,
			name: result.name,
			matches: [result],
		});
	}

	return Array.from(groups.values())
		.map((group) => ({
			...group,
			matches: [...group.matches].sort((left, right) => {
				if (left.line !== right.line) {
					return left.line - right.line;
				}
				return left.column - right.column;
			}),
		}))
		.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function buildReplaceSummary(input: {
	replacements: number;
	filesUpdated: number;
	conflictCount: number;
	failedCount: number;
}): string {
	const parts = [
		`Replaced ${input.replacements} match${input.replacements === 1 ? "" : "es"} in ${input.filesUpdated} file${input.filesUpdated === 1 ? "" : "s"}.`,
	];

	if (input.conflictCount > 0) {
		parts.push(
			`${input.conflictCount} file${input.conflictCount === 1 ? "" : "s"} changed on disk and were skipped.`,
		);
	}

	if (input.failedCount > 0) {
		parts.push(
			`${input.failedCount} file${input.failedCount === 1 ? "" : "s"} failed to update.`,
		);
	}

	return parts.join(" ");
}

function buildSearchTree(groups: SearchResultGroup[]): SearchTreeNodeType[] {
	type SearchTreeFolderNodeInternal = Omit<SearchTreeFolderNode, "children"> & {
		children: Record<string, SearchTreeNodeType | SearchTreeFolderNodeInternal>;
	};

	const root: Record<
		string,
		SearchTreeNodeType | SearchTreeFolderNodeInternal
	> = {};

	for (const group of groups) {
		const segments = group.relativePath.split(/[\\/]/);
		const fileName = segments.pop() ?? group.name;
		let current = root;
		let pathSoFar = "";

		for (const segment of segments) {
			pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
			const existing = current[segment];

			if (!existing || existing.type !== "folder") {
				current[segment] = {
					id: pathSoFar,
					type: "folder",
					path: pathSoFar,
					name: segment,
					matchCount: 0,
					children: {},
				};
			}

			const folder = current[segment] as SearchTreeFolderNodeInternal;
			folder.matchCount += group.matches.length;
			current = folder.children;
		}

		current[fileName] = {
			id: group.absolutePath,
			type: "file",
			path: group.relativePath,
			group,
		};
	}

	function toArray(
		nodes: Record<string, SearchTreeNodeType | SearchTreeFolderNodeInternal>,
	): SearchTreeNodeType[] {
		return Object.values(nodes)
			.map((node) => {
				if (node.type !== "folder") {
					return node;
				}

				const folderNode = node as SearchTreeFolderNodeInternal;
				return compressFolderNode({
					...folderNode,
					children: toArray(folderNode.children),
				});
			})
			.sort((left, right) => {
				if (left.type !== right.type) {
					return left.type === "folder" ? -1 : 1;
				}

				const leftName = left.type === "folder" ? left.name : left.group.name;
				const rightName =
					right.type === "folder" ? right.name : right.group.name;
				return leftName.localeCompare(rightName);
			});
	}

	function compressFolderNode(
		node: SearchTreeFolderNode,
	): SearchTreeFolderNode {
		let nextNode = node;

		while (
			nextNode.children.length === 1 &&
			nextNode.children[0]?.type === "folder"
		) {
			const child = nextNode.children[0];
			nextNode = {
				...nextNode,
				name: `${nextNode.name}/${child.name}`,
				path: child.path,
				id: child.id,
				matchCount: child.matchCount,
				children: child.children,
			};
		}

		return nextNode;
	}

	return toArray(root);
}

function collectFolderPaths(nodes: SearchTreeNodeType[]): string[] {
	const paths: string[] = [];

	for (const node of nodes) {
		if (node.type !== "folder") {
			continue;
		}

		paths.push(node.path);
		paths.push(...collectFolderPaths(node.children));
	}

	return paths;
}

type SearchViewBackend = "classic" | "workspace";

interface SearchViewProps {
	isActive: boolean;
	onOpenFileAtLine: (path: string, line?: number, column?: number) => void;
	backend?: SearchViewBackend;
	workspaceId?: string;
	projectId?: string;
	branch?: string | null;
}

interface SearchRuntimeParams {
	workspaceId?: string;
	projectId?: string;
	branch?: string | null;
	query: string;
	includePattern: string;
	excludePattern: string;
	isRegex: boolean;
	caseSensitive: boolean;
	wholeWord: boolean;
	multiline: boolean;
	enabled: boolean;
}

interface SearchReplaceContentInput {
	workspaceId: string;
	query: string;
	replacement: string;
	includeHidden: boolean;
	includePattern?: string;
	excludePattern?: string;
	isRegex: boolean;
	caseSensitive: boolean;
	wholeWord: boolean;
	multiline: boolean;
	paths?: string[];
}

interface SearchReplaceContentResult {
	replacements: number;
	filesUpdated: number;
	conflicts: readonly unknown[];
	failed: readonly unknown[];
}

interface SearchReadFileInput {
	workspaceId: string;
	absolutePath: string;
	encoding: string;
}

type SearchReadFileResult =
	| {
			kind: "text";
			content: string;
			revision: string;
	  }
	| {
			kind: string;
			content?: unknown;
			revision?: string;
	  };

interface SearchWriteFileInput {
	workspaceId: string;
	absolutePath: string;
	content: string;
	encoding: string;
	precondition: { ifMatch: string };
}

type SearchWriteFileResult =
	| {
			ok: true;
			revision?: string;
	  }
	| {
			ok: false;
			reason?: string;
	  };

interface SearchRuntime {
	workspaceId: string | undefined;
	branch: string | null | undefined;
	supersetLinkProject: SupersetLinkProject | null;
	searchResults: SearchContentResult[];
	isFetching: boolean;
	hasQuery: boolean;
	validationError: string | null;
	refresh: () => void;
	isReplacePending: boolean;
	isWritePending: boolean;
	usesClassicFileEvents: boolean;
	replaceContent: (
		input: SearchReplaceContentInput,
	) => Promise<SearchReplaceContentResult>;
	readFile: (input: SearchReadFileInput) => Promise<SearchReadFileResult>;
	writeFile: (input: SearchWriteFileInput) => Promise<SearchWriteFileResult>;
	invalidateSearch: () => void;
	invalidateReadFile: (input: {
		workspaceId: string;
		absolutePath: string;
	}) => void;
}

type UseSearchRuntime = (params: SearchRuntimeParams) => SearchRuntime;

export function SearchView(props: SearchViewProps) {
	if (props.backend === "workspace") {
		return <WorkspaceSearchView {...props} />;
	}

	return <ClassicSearchView {...props} />;
}

function ClassicSearchView(props: SearchViewProps) {
	return <SearchViewContent {...props} useRuntime={useClassicSearchRuntime} />;
}

function WorkspaceSearchView(props: SearchViewProps) {
	return (
		<SearchViewContent {...props} useRuntime={useWorkspaceSearchRuntime} />
	);
}

function useClassicSearchRuntime({
	query,
	includePattern,
	excludePattern,
	isRegex,
	caseSensitive,
	wholeWord,
	multiline,
	enabled,
}: SearchRuntimeParams): SearchRuntime {
	const workspaceId = useWorkspaceId();
	const utils = electronTrpc.useUtils();
	const replaceMutation = electronTrpc.filesystem.replaceContent.useMutation();
	const writeFileMutation = electronTrpc.filesystem.writeFile.useMutation();
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const projectId = workspace?.projectId ?? workspace?.project?.id;
	const { data: project } = electronTrpc.projects.get.useQuery(
		{ id: projectId ?? "" },
		{ enabled: !!projectId },
	);
	const supersetLinkProject = useMemo(
		() =>
			project
				? {
						githubOwner: project.githubOwner ?? null,
						githubRepoName: null,
						mainRepoPath: project.mainRepoPath,
					}
				: null,
		[project],
	);

	const { searchResults, isFetching, hasQuery, validationError, refresh } =
		useContentSearch({
			workspaceId,
			query,
			includePattern,
			excludePattern,
			isRegex,
			caseSensitive,
			wholeWord,
			// `multiline` only meaningfully applies to regex patterns in VSCode,
			// so we drop it entirely when the user isn't in regex mode. This
			// lets the regex toggle control visibility and avoids wasted
			// ripgrep calls with `--multiline` on fixed strings.
			multiline: isRegex && multiline,
			enabled,
		});

	return {
		workspaceId,
		branch: workspace?.branch,
		supersetLinkProject,
		searchResults,
		isFetching,
		hasQuery,
		validationError,
		refresh,
		isReplacePending: replaceMutation.isPending,
		isWritePending: writeFileMutation.isPending,
		usesClassicFileEvents: true,
		replaceContent: (input) => replaceMutation.mutateAsync(input),
		readFile: (input) => utils.filesystem.readFile.fetch(input),
		writeFile: (input) => writeFileMutation.mutateAsync(input),
		invalidateSearch: () => {
			void utils.filesystem.searchContent.invalidate();
		},
		invalidateReadFile: (input) => {
			void utils.filesystem.readFile.invalidate(input);
		},
	};
}

function useWorkspaceSearchRuntime({
	workspaceId,
	projectId,
	branch,
	query,
	includePattern,
	excludePattern,
	isRegex,
	caseSensitive,
	wholeWord,
	multiline,
	enabled,
}: SearchRuntimeParams): SearchRuntime {
	const utils = workspaceTrpc.useUtils();
	const replaceMutation = workspaceTrpc.filesystem.replaceContent.useMutation();
	const writeFileMutation = workspaceTrpc.filesystem.writeFile.useMutation();
	const { data: project } = workspaceTrpc.project.get.useQuery(
		{ projectId: projectId ?? "" },
		{ enabled: Boolean(projectId) },
	);
	const supersetLinkProject = useMemo(
		() =>
			project
				? {
						githubOwner: project.repoOwner ?? null,
						githubRepoName: project.repoName ?? null,
						mainRepoPath: project.repoPath,
					}
				: null,
		[project],
	);
	const { searchResults, isFetching, hasQuery, validationError, refresh } =
		useWorkspaceContentSearch({
			workspaceId,
			query,
			includePattern,
			excludePattern,
			isRegex,
			caseSensitive,
			wholeWord,
			multiline: isRegex && multiline,
			enabled,
		});

	return {
		workspaceId,
		branch,
		supersetLinkProject,
		searchResults,
		isFetching,
		hasQuery,
		validationError,
		refresh,
		isReplacePending: replaceMutation.isPending,
		isWritePending: writeFileMutation.isPending,
		usesClassicFileEvents: false,
		replaceContent: (input) => replaceMutation.mutateAsync(input),
		readFile: (input) => utils.filesystem.readFile.fetch(input),
		writeFile: (input) => writeFileMutation.mutateAsync(input),
		invalidateSearch: () => {
			void utils.filesystem.searchContent.invalidate();
		},
		invalidateReadFile: (input) => {
			void utils.filesystem.readFile.invalidate(input);
		},
	};
}

function SearchViewContent({
	isActive,
	onOpenFileAtLine,
	workspaceId: workspaceIdProp,
	projectId,
	branch,
	useRuntime,
}: SearchViewProps & { useRuntime: UseSearchRuntime }) {
	const { copyToClipboard } = useCopyToClipboard();
	const searchInputRef = useRef<HTMLInputElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [replacement, setReplacement] = useState("");
	const [replaceOpen, setReplaceOpen] = useState(false);
	const [isRegex, setIsRegex] = useState(false);
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [wholeWord, setWholeWord] = useState(false);
	const [multiline, setMultiline] = useState(false);
	const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
	const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
	const [ignoredMatchIds, setIgnoredMatchIds] = useState<Record<string, true>>(
		{},
	);
	const resultViewMode = useSearchDialogStore((state) => state.resultViewMode);
	const setResultViewMode = useSearchDialogStore(
		(state) => state.setResultViewMode,
	);
	const includePattern = useSearchDialogStore(
		(state) => state.byMode.keywordSearch.includePattern,
	);
	const excludePattern = useSearchDialogStore(
		(state) => state.byMode.keywordSearch.excludePattern,
	);
	const setIncludePatternByMode = useSearchDialogStore(
		(state) => state.setIncludePattern,
	);
	const setExcludePatternByMode = useSearchDialogStore(
		(state) => state.setExcludePattern,
	);
	const {
		workspaceId,
		branch: workspaceBranch,
		supersetLinkProject,
		searchResults,
		isFetching,
		hasQuery,
		validationError,
		refresh,
		isReplacePending,
		isWritePending,
		usesClassicFileEvents,
		replaceContent,
		readFile,
		writeFile,
		invalidateSearch,
		invalidateReadFile,
	} = useRuntime({
		workspaceId: workspaceIdProp,
		projectId,
		branch,
		query,
		includePattern,
		excludePattern,
		isRegex,
		caseSensitive,
		wholeWord,
		multiline,
		enabled: isActive,
	});

	const visibleResults = useMemo(
		() => searchResults.filter((result) => !ignoredMatchIds[result.id]),
		[ignoredMatchIds, searchResults],
	);
	const groupedResults = useMemo(
		() => groupSearchResults(visibleResults),
		[visibleResults],
	);
	const treeResults = useMemo(
		() => buildSearchTree(groupedResults),
		[groupedResults],
	);
	const folderPaths = useMemo(
		() => collectFolderPaths(treeResults),
		[treeResults],
	);
	const searchResultResetKey = `${query}\u0000${includePattern}\u0000${excludePattern}\u0000${isRegex}\u0000${caseSensitive}\u0000${wholeWord}\u0000${multiline}`;

	const copySupersetLink = useCallback(
		({
			filePath,
			line,
			column,
		}: {
			filePath: string;
			line?: number;
			column?: number;
		}) => {
			if (!supersetLinkProject) {
				toast.error("Superset link is unavailable", {
					description: "Project metadata is still loading.",
				});
				return;
			}

			const link = buildSupersetOpenLink({
				project: supersetLinkProject,
				branch: workspaceBranch,
				filePath,
				line,
				column,
			});

			if (!link) {
				toast.error("Failed to build Superset link", {
					description: "Repository metadata is incomplete.",
				});
				return;
			}

			void copyToClipboard(link).catch((error) => {
				console.error("[superset-link] Failed to copy link:", error);
				toast.error("Failed to copy Superset link", {
					description: error instanceof Error ? error.message : undefined,
				});
			});
		},
		[copyToClipboard, supersetLinkProject, workspaceBranch],
	);
	const handleCopyFileLink = useCallback(
		(group: SearchResultGroup) => {
			void copySupersetLink({ filePath: group.relativePath });
		},
		[copySupersetLink],
	);
	const handleCopyMatchLink = useCallback(
		(lineMatch: SearchLineResult) => {
			void copySupersetLink({
				filePath: lineMatch.relativePath,
				line: lineMatch.line,
				column: lineMatch.matches[0]?.column ?? 1,
			});
		},
		[copySupersetLink],
	);

	useEffect(() => {
		if (!isActive) {
			return;
		}

		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	}, [isActive]);

	useEffect(() => {
		if (groupedResults.length === 0) {
			return;
		}

		setOpenGroups((current) => {
			let changed = false;
			const nextGroups = { ...current };
			for (const group of groupedResults) {
				if (nextGroups[group.absolutePath] === undefined) {
					nextGroups[group.absolutePath] = true;
					changed = true;
				}
			}
			return changed ? nextGroups : current;
		});
	}, [groupedResults]);

	useEffect(() => {
		if (folderPaths.length === 0) {
			return;
		}

		setOpenFolders((current) => {
			let changed = false;
			const nextFolders = { ...current };
			for (const folderPath of folderPaths) {
				if (nextFolders[folderPath] === undefined) {
					nextFolders[folderPath] = true;
					changed = true;
				}
			}
			return changed ? nextFolders : current;
		});
	}, [folderPaths]);

	useEffect(() => {
		void searchResultResetKey;
		setIgnoredMatchIds({});
	}, [searchResultResetKey]);

	useWorkspaceFileEvents(
		workspaceId ?? "",
		() => {
			if (!query.trim()) {
				return;
			}
			invalidateSearch();
		},
		Boolean(usesClassicFileEvents && workspaceId && query.trim().length > 0),
	);

	const totalMatches = visibleResults.length;
	const totalFiles = groupedResults.length;
	const hiddenMatches = searchResults.length - visibleResults.length;
	const canReplaceAll =
		replaceOpen &&
		hasQuery &&
		validationError === null &&
		!isReplacePending &&
		!isWritePending;
	// The per-match inline replace applies the regex line by line, so a
	// multiline pattern (e.g. `foo\nbar`) that matched across newlines can
	// never be applied by that code path — it would simply report the hit
	// as out-of-date. "Replace all" still works because the backend replaces
	// against the full file content. Disable inline replace in that case so
	// users don't silently hit the stale-match error.
	const canInlineReplace =
		hasQuery && validationError === null && !(isRegex && multiline);

	const runReplace = useCallback(
		async (paths?: string[]) => {
			if (!workspaceId || !query.trim() || validationError) {
				return;
			}

			try {
				const result = await replaceContent({
					workspaceId,
					query,
					replacement,
					includeHidden: false,
					includePattern,
					excludePattern,
					isRegex,
					caseSensitive,
					wholeWord,
					multiline: isRegex && multiline,
					paths,
				});

				const summary = buildReplaceSummary({
					replacements: result.replacements,
					filesUpdated: result.filesUpdated,
					conflictCount: result.conflicts.length,
					failedCount: result.failed.length,
				});

				if (result.filesUpdated > 0) {
					if (result.conflicts.length > 0 || result.failed.length > 0) {
						toast.warning(summary);
					} else {
						toast.success(summary);
					}
				} else if (result.conflicts.length > 0 || result.failed.length > 0) {
					toast.error(summary);
				} else {
					toast.warning("No matches were replaced.");
				}

				invalidateSearch();
				refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to replace matches.",
				);
			}
		},
		[
			caseSensitive,
			excludePattern,
			includePattern,
			isRegex,
			multiline,
			query,
			refresh,
			replacement,
			replaceContent,
			invalidateSearch,
			validationError,
			wholeWord,
			workspaceId,
		],
	);
	const replaceLineMatch = useCallback(
		async (lineMatch: SearchLineResult) => {
			if (!workspaceId || !query.trim() || validationError || isWritePending) {
				return;
			}

			try {
				const currentFile = await readFile({
					workspaceId,
					absolutePath: lineMatch.absolutePath,
					encoding: "utf-8",
				});

				if (
					currentFile.kind !== "text" ||
					typeof currentFile.content !== "string" ||
					typeof currentFile.revision !== "string"
				) {
					toast.error("Only text files can be updated from search results.");
					return;
				}

				const nextContent = replaceSearchMatchesInLineInContent(
					currentFile.content,
					{
						query,
						replacement,
						line: lineMatch.line,
						isRegex,
						caseSensitive,
						wholeWord,
						multiline: isRegex && multiline,
					},
				);

				if (nextContent === null || nextContent === currentFile.content) {
					toast.warning(
						"The selected search result is out of date. Refresh search results and try again.",
					);
					return;
				}

				const writeResult = await writeFile({
					workspaceId,
					absolutePath: lineMatch.absolutePath,
					content: nextContent,
					encoding: "utf-8",
					precondition: { ifMatch: currentFile.revision },
				});

				if (!writeResult.ok) {
					if (writeResult.reason === "conflict") {
						toast.error(
							"The file changed on disk before the replacement could be applied.",
						);
						return;
					}

					toast.error("Failed to replace the selected match.");
					return;
				}

				invalidateReadFile({
					workspaceId,
					absolutePath: lineMatch.absolutePath,
				});
				invalidateSearch();
				refresh();
				toast.success(
					`Replaced ${lineMatch.matches.length} match${lineMatch.matches.length === 1 ? "" : "es"} on line ${lineMatch.line}.`,
				);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to replace the selected match.",
				);
			}
		},
		[
			caseSensitive,
			isRegex,
			multiline,
			query,
			readFile,
			refresh,
			replacement,
			invalidateReadFile,
			invalidateSearch,
			validationError,
			wholeWord,
			workspaceId,
			writeFile,
			isWritePending,
		],
	);

	const handleOpenGroupChange = useCallback(
		(absolutePath: string, nextOpen: boolean) => {
			setOpenGroups((current) => ({
				...current,
				[absolutePath]: nextOpen,
			}));
		},
		[],
	);
	const handleOpenFolderChange = useCallback(
		(path: string, nextOpen: boolean) => {
			setOpenFolders((current) => ({
				...current,
				[path]: nextOpen,
			}));
		},
		[],
	);
	const handleIgnoreLine = useCallback((lineMatch: SearchLineResult) => {
		setIgnoredMatchIds((current) => ({
			...current,
			...Object.fromEntries(lineMatch.matches.map((match) => [match.id, true])),
		}));
	}, []);
	const handleClearResults = useCallback(() => {
		setQuery("");
		setIgnoredMatchIds({});
	}, []);
	const areAllGroupsExpanded =
		(folderPaths.length > 0 || groupedResults.length > 0) &&
		folderPaths.every((folderPath) => openFolders[folderPath] ?? true) &&
		groupedResults.every((group) => openGroups[group.absolutePath] ?? true);

	const listItems = useMemo(
		() => (resultViewMode === "tree" ? treeResults : groupedResults),
		[resultViewMode, treeResults, groupedResults],
	);
	const virtualizer = useVirtualizer({
		count: listItems.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => 28,
		overscan: 10,
	});
	const handleToggleExpandAll = useCallback(() => {
		const nextOpen = !areAllGroupsExpanded;
		setOpenGroups(
			Object.fromEntries(
				groupedResults.map((group) => [group.absolutePath, nextOpen]),
			),
		);
		setOpenFolders(
			Object.fromEntries(
				folderPaths.map((folderPath) => [folderPath, nextOpen]),
			),
		);
	}, [areAllGroupsExpanded, folderPaths, groupedResults]);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<SearchToolbar
				searchInputRef={searchInputRef}
				query={query}
				replacement={replacement}
				replaceOpen={replaceOpen}
				includePattern={includePattern}
				excludePattern={excludePattern}
				isRegex={isRegex}
				caseSensitive={caseSensitive}
				wholeWord={wholeWord}
				multiline={multiline}
				canReplaceAll={canReplaceAll && totalMatches > 0}
				isReplacing={isReplacePending || isWritePending}
				onQueryChange={setQuery}
				onReplacementChange={setReplacement}
				onIncludePatternChange={(value) =>
					setIncludePatternByMode("keywordSearch", value)
				}
				onExcludePatternChange={(value) =>
					setExcludePatternByMode("keywordSearch", value)
				}
				onToggleReplace={() => setReplaceOpen((current) => !current)}
				onToggleRegex={() => setIsRegex((current) => !current)}
				onToggleCaseSensitive={() => setCaseSensitive((current) => !current)}
				onToggleWholeWord={() => setWholeWord((current) => !current)}
				onToggleMultiline={() => setMultiline((current) => !current)}
				onReplaceAll={() => {
					void runReplace();
				}}
			/>

			<div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<Badge variant="outline">{totalFiles} files</Badge>
					<Badge variant="secondary">{totalMatches} results</Badge>
					{hiddenMatches > 0 ? (
						<Badge variant="outline">{hiddenMatches} hidden</Badge>
					) : null}
				</div>
				<div className="flex items-center gap-0.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									"h-7 px-2 text-[11px]",
									resultViewMode === "tree" &&
										"bg-accent text-accent-foreground",
								)}
								aria-pressed={resultViewMode === "tree"}
								onClick={() => setResultViewMode("tree")}
							>
								Tree
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Tree view</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									"h-7 px-2 text-[11px]",
									resultViewMode === "list" &&
										"bg-accent text-accent-foreground",
								)}
								aria-pressed={resultViewMode === "list"}
								onClick={() => setResultViewMode("list")}
							>
								List
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">List view</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-7"
								disabled={groupedResults.length === 0}
								onClick={handleToggleExpandAll}
							>
								<LuChevronsDownUp className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{areAllGroupsExpanded ? "Collapse all" : "Expand all"}
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-7"
								disabled={!hasQuery && hiddenMatches === 0}
								onClick={handleClearResults}
							>
								<LuX className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Clear search results</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-7 shrink-0"
								disabled={!hasQuery || validationError !== null || isFetching}
								onClick={() => {
									invalidateSearch();
								}}
							>
								<LuRefreshCw
									className={`size-3.5 ${isFetching ? "animate-spin" : ""}`}
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Refresh results</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{validationError ? (
				<div className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
					Invalid regular expression: {validationError}
				</div>
			) : null}

			<div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto">
				<div className="p-2">
					{!hasQuery ? (
						<div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
							Enter a search query to find matches across the workspace.
						</div>
					) : null}

					{hasQuery &&
					validationError === null &&
					groupedResults.length === 0 ? (
						<div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
							{isFetching ? "Searching workspace..." : "No results found."}
						</div>
					) : null}

					{listItems.length > 0 ? (
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								position: "relative",
							}}
						>
							{virtualizer.getVirtualItems().map((virtualItem) => {
								const item = listItems[virtualItem.index];
								if (!item) return null;
								return (
									<div
										key={virtualItem.key}
										data-index={virtualItem.index}
										ref={virtualizer.measureElement}
										style={{
											position: "absolute",
											top: 0,
											left: 0,
											width: "100%",
											transform: `translateY(${virtualItem.start}px)`,
										}}
										className="pb-2"
									>
										{resultViewMode === "tree" ? (
											<SearchTreeNode
												node={item as (typeof treeResults)[number]}
												query={query}
												isRegex={isRegex}
												caseSensitive={caseSensitive}
												wholeWord={wholeWord}
												multiline={isRegex && multiline}
												replacement={replaceOpen ? replacement : undefined}
												isReplacing={isReplacePending || isWritePending}
												showReplaceAction={canInlineReplace}
												openGroups={openGroups}
												openFolders={openFolders}
												onOpenGroupChange={handleOpenGroupChange}
												onOpenFolderChange={handleOpenFolderChange}
												onOpenMatch={onOpenFileAtLine}
												onCopyFileLink={handleCopyFileLink}
												onCopyMatchLink={handleCopyMatchLink}
												onReplaceInFile={(absolutePath) => {
													void runReplace([absolutePath]);
												}}
												onReplaceMatch={(match) => {
													void replaceLineMatch(match);
												}}
												onIgnoreMatch={handleIgnoreLine}
											/>
										) : (
											<SearchFileGroup
												group={item as (typeof groupedResults)[number]}
												isOpen={
													openGroups[
														(item as (typeof groupedResults)[number])
															.absolutePath
													] ?? true
												}
												query={query}
												isRegex={isRegex}
												caseSensitive={caseSensitive}
												wholeWord={wholeWord}
												multiline={isRegex && multiline}
												replacement={replaceOpen ? replacement : undefined}
												isReplacing={isReplacePending || isWritePending}
												showReplaceAction={canInlineReplace}
												showParentPath
												variant="list"
												onOpenChange={(nextOpen) =>
													handleOpenGroupChange(
														(item as (typeof groupedResults)[number])
															.absolutePath,
														nextOpen,
													)
												}
												onOpenMatch={onOpenFileAtLine}
												onCopyFileLink={handleCopyFileLink}
												onCopyMatchLink={handleCopyMatchLink}
												onReplaceInFile={(absolutePath) => {
													void runReplace([absolutePath]);
												}}
												onReplaceMatch={(match) => {
													void replaceLineMatch(match);
												}}
												onIgnoreMatch={handleIgnoreLine}
											/>
										)}
									</div>
								);
							})}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
