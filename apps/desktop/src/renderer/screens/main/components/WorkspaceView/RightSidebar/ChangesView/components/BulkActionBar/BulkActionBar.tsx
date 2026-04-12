import { VscAdd, VscClose, VscDiscard, VscRemove } from "react-icons/vsc";
import type { ChangedFile } from "shared/changes-types";
import { useMultiSelect } from "../MultiSelectContext";

interface BulkActionBarProps {
	onStageSelected?: (files: ChangedFile[]) => void;
	onUnstageSelected?: (files: ChangedFile[]) => void;
	onDiscardSelected?: (files: ChangedFile[]) => void;
	isActioning?: boolean;
}

/**
 * Inline action bar rendered at the top of a file list when one or more files
 * have been multi-selected. Consumes the enclosing MultiSelectContext.
 */
export function BulkActionBar({
	onStageSelected,
	onUnstageSelected,
	onDiscardSelected,
	isActioning,
}: BulkActionBarProps) {
	const ctx = useMultiSelect();
	if (!ctx || !ctx.hasSelection) return null;

	const count = ctx.selectionCount;
	const files = ctx.selectedFiles;

	return (
		<div className="mx-0.5 mb-1 flex items-center gap-1 rounded-sm border border-border bg-accent/40 px-1.5 py-1 text-xs">
			<span className="font-medium">{count} selected</span>
			<div className="ml-auto flex items-center gap-0.5">
				{onStageSelected ? (
					<button
						type="button"
						onClick={() => {
							onStageSelected(files);
							ctx.clear();
						}}
						disabled={isActioning}
						title="Stage selected"
						className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
					>
						<VscAdd className="size-3" />
						Stage
					</button>
				) : null}
				{onUnstageSelected ? (
					<button
						type="button"
						onClick={() => {
							onUnstageSelected(files);
							ctx.clear();
						}}
						disabled={isActioning}
						title="Unstage selected"
						className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
					>
						<VscRemove className="size-3" />
						Unstage
					</button>
				) : null}
				{onDiscardSelected ? (
					<button
						type="button"
						onClick={() => {
							onDiscardSelected(files);
							ctx.clear();
						}}
						disabled={isActioning}
						title="Discard selected"
						className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
					>
						<VscDiscard className="size-3" />
						Discard
					</button>
				) : null}
				<button
					type="button"
					onClick={() => ctx.clear()}
					title="Clear selection"
					className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					aria-label="Clear selection"
				>
					<VscClose className="size-3" />
				</button>
			</div>
		</div>
	);
}
