import { HiMiniPaperClip } from "react-icons/hi2";
import type { AttachmentRef } from "../../utils/attachmentRefs";

interface AttachmentChipsProps {
	attachments: AttachmentRef[];
	onSelect: (attachment: AttachmentRef) => void;
}

/**
 * Read-only chip strip used by the SessionDetail panel to surface
 * attachments referenced by `![](path)` tokens in description / goal
 * text. Mirrors the chip styling used by the composer's
 * `ImagePasteTextarea` so the create and read views feel consistent,
 * but omits the remove (X) button — read-only context.
 */
export function AttachmentChips({
	attachments,
	onSelect,
}: AttachmentChipsProps) {
	if (attachments.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1 mt-1.5">
			{attachments.map((a) => (
				<button
					key={a.path}
					type="button"
					onClick={() => onSelect(a)}
					title={`${a.name} · クリックでプレビュー`}
					className="inline-flex items-center gap-1 text-[10px] rounded-md border border-border/60 bg-muted/50 hover:bg-muted px-1.5 py-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
				>
					<HiMiniPaperClip className="size-3 text-muted-foreground/80" />
					<span className="truncate max-w-[200px]">{a.name}</span>
				</button>
			))}
		</div>
	);
}
