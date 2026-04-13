import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ChangedFile } from "shared/changes-types";

export type MultiSelectClickResult = "multi" | "none";

export interface MultiSelectApi {
	isSelected(path: string): boolean;
	hasSelection: boolean;
	selectionCount: number;
	selectedFiles: ChangedFile[];
	handleClick(path: string, event: React.MouseEvent): MultiSelectClickResult;
	clear(): void;
	/**
	 * Bulk action handlers — VS Code style. When an action (stage /
	 * unstage / discard) is invoked from a FileItem that is part of a
	 * multi-selection, callers should apply the action to the whole
	 * selection instead of the single file. `null` means the action is
	 * not available in this section.
	 */
	onStageSelected: ((files: ChangedFile[]) => void) | null;
	onUnstageSelected: ((files: ChangedFile[]) => void) | null;
	onDiscardSelected: ((files: ChangedFile[]) => void) | null;
}

const MultiSelectCtx = createContext<MultiSelectApi | null>(null);

interface MultiSelectProviderProps {
	files: ChangedFile[];
	children: ReactNode;
	onStageSelected?: (files: ChangedFile[]) => void;
	onUnstageSelected?: (files: ChangedFile[]) => void;
	onDiscardSelected?: (files: ChangedFile[]) => void;
}

const MULTI_SELECT_PATH_ATTR = "data-multi-select-path";

/**
 * Per-section selection model enabling Shift/Cmd click multi-select.
 * Range selection order resolves DOM-first (so tree-view collapsed
 * folders are naturally skipped and any view mode's real rendered
 * ordering is the ground truth), falling back to the `files` prop
 * order for cases where the DOM doesn't contain both endpoints
 * (virtualized lists where the anchor scrolled out).
 */
export function MultiSelectProvider({
	files,
	children,
	onStageSelected,
	onUnstageSelected,
	onDiscardSelected,
}: MultiSelectProviderProps) {
	const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [anchorPath, setAnchorPath] = useState<string | null>(null);
	const filesRef = useRef(files);
	filesRef.current = files;
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const onStageSelectedRef = useRef(onStageSelected);
	const onUnstageSelectedRef = useRef(onUnstageSelected);
	const onDiscardSelectedRef = useRef(onDiscardSelected);
	onStageSelectedRef.current = onStageSelected;
	onUnstageSelectedRef.current = onUnstageSelected;
	onDiscardSelectedRef.current = onDiscardSelected;

	// Drop stale selections when files list changes (e.g., after staging).
	useEffect(() => {
		const validPaths = new Set(files.map((f) => f.path));
		setSelectedPaths((prev) => {
			let mutated = false;
			const next = new Set<string>();
			for (const path of prev) {
				if (validPaths.has(path)) {
					next.add(path);
				} else {
					mutated = true;
				}
			}
			return mutated ? next : prev;
		});
		if (anchorPath && !validPaths.has(anchorPath)) {
			setAnchorPath(null);
		}
	}, [files, anchorPath]);

	const resolveOrderedPathsForRange = useCallback(
		(anchor: string, target: string): string[] => {
			const wrapper = wrapperRef.current;
			if (wrapper) {
				const nodes = wrapper.querySelectorAll<HTMLElement>(
					`[${MULTI_SELECT_PATH_ATTR}]`,
				);
				if (nodes.length > 0) {
					const domPaths: string[] = [];
					for (const node of nodes) {
						const path = node.dataset.multiSelectPath;
						if (path) domPaths.push(path);
					}
					if (domPaths.includes(anchor) && domPaths.includes(target)) {
						return domPaths;
					}
				}
			}
			return filesRef.current.map((f) => f.path);
		},
		[],
	);

	const handleClick = useCallback<MultiSelectApi["handleClick"]>(
		(path, event) => {
			if (event.shiftKey) {
				// VS Code fallback: if the user shift-clicks without having
				// previously clicked anything, treat the first visible file
				// as the anchor so the range extends from the top of the
				// list down to the clicked item.
				const effectiveAnchor = anchorPath ?? filesRef.current[0]?.path;
				if (effectiveAnchor) {
					const paths = resolveOrderedPathsForRange(effectiveAnchor, path);
					const fromIdx = paths.indexOf(effectiveAnchor);
					const toIdx = paths.indexOf(path);
					if (fromIdx >= 0 && toIdx >= 0) {
						const [a, b] =
							fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
						setSelectedPaths(new Set(paths.slice(a, b + 1)));
						if (!anchorPath) {
							setAnchorPath(effectiveAnchor);
						}
						return "multi";
					}
				}
			}
			if (event.metaKey || event.ctrlKey) {
				setSelectedPaths((prev) => {
					const next = new Set(prev);
					if (next.has(path)) {
						next.delete(path);
					} else {
						next.add(path);
					}
					return next;
				});
				setAnchorPath(path);
				return "multi";
			}
			// Normal click: clear any prior selection and let caller navigate.
			setSelectedPaths((prev) => (prev.size > 0 ? new Set() : prev));
			setAnchorPath(path);
			return "none";
		},
		[anchorPath, resolveOrderedPathsForRange],
	);

	const selectedFiles = useMemo(
		() => files.filter((f) => selectedPaths.has(f.path)),
		[files, selectedPaths],
	);

	const api = useMemo<MultiSelectApi>(
		() => ({
			isSelected: (path: string) => selectedPaths.has(path),
			hasSelection: selectedPaths.size > 0,
			selectionCount: selectedPaths.size,
			selectedFiles,
			handleClick,
			clear: () => setSelectedPaths(new Set()),
			onStageSelected: onStageSelected ?? null,
			onUnstageSelected: onUnstageSelected ?? null,
			onDiscardSelected: onDiscardSelected ?? null,
		}),
		[
			selectedPaths,
			selectedFiles,
			handleClick,
			onStageSelected,
			onUnstageSelected,
			onDiscardSelected,
		],
	);

	return (
		<MultiSelectCtx.Provider value={api}>
			{/* display: contents keeps the wrapper layout-transparent so it
			    does not break existing flex / scroll containers while still
			    scoping DOM queries to this provider's subtree. */}
			<div ref={wrapperRef} style={{ display: "contents" }}>
				{children}
			</div>
		</MultiSelectCtx.Provider>
	);
}

export function useMultiSelect(): MultiSelectApi | null {
	return useContext(MultiSelectCtx);
}
