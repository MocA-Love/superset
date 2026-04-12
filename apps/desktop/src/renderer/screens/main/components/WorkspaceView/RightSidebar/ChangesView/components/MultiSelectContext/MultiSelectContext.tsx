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
}

const MultiSelectCtx = createContext<MultiSelectApi | null>(null);

interface MultiSelectProviderProps {
	files: ChangedFile[];
	children: ReactNode;
}

/**
 * Per-section selection model enabling Shift/Cmd click multi-select.
 * Range selection uses the file list order provided via `files`.
 */
export function MultiSelectProvider({
	files,
	children,
}: MultiSelectProviderProps) {
	const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [anchorPath, setAnchorPath] = useState<string | null>(null);
	const filesRef = useRef(files);
	filesRef.current = files;

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

	const handleClick = useCallback<MultiSelectApi["handleClick"]>(
		(path, event) => {
			if (event.shiftKey && anchorPath) {
				const paths = filesRef.current.map((f) => f.path);
				const fromIdx = paths.indexOf(anchorPath);
				const toIdx = paths.indexOf(path);
				if (fromIdx >= 0 && toIdx >= 0) {
					const [a, b] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
					setSelectedPaths(new Set(paths.slice(a, b + 1)));
					return "multi";
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
		[anchorPath],
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
		}),
		[selectedPaths, selectedFiles, handleClick],
	);

	return (
		<MultiSelectCtx.Provider value={api}>{children}</MultiSelectCtx.Provider>
	);
}

export function useMultiSelect(): MultiSelectApi | null {
	return useContext(MultiSelectCtx);
}
