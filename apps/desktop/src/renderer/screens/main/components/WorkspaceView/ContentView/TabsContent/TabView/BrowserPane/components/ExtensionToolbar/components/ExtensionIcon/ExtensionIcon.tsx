import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useCallback, useRef, useState } from "react";
import { HiOutlinePuzzlePiece } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ExtensionToolbarInfo } from "./types";

interface ExtensionIconProps {
	extension: ExtensionToolbarInfo;
}

export function ExtensionIcon({ extension }: ExtensionIconProps) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [imgError, setImgError] = useState(false);

	const openPopupMutation = electronTrpc.extensions.openPopup.useMutation();

	const handleClick = useCallback(() => {
		const el = buttonRef.current;
		if (!el || !extension.popupPath) return;

		// Get the bounding rect relative to the BrowserWindow content area
		const rect = el.getBoundingClientRect();

		openPopupMutation.mutate({
			// Use the Electron-assigned ID for the chrome-extension:// URL
			extensionId: extension.electronId,
			popupPath: extension.popupPath,
			anchorRect: {
				x: Math.round(rect.left),
				y: Math.round(rect.top),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			},
		});
	}, [extension, openPopupMutation]);

	// Use the Chrome Web Store ID for the icon protocol (directory name)
	const iconUrl = `superset-ext-icon://${extension.id}/32`;
	const title = extension.actionTitle ?? extension.name;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					ref={buttonRef}
					type="button"
					onClick={handleClick}
					className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground hover:bg-accent/50"
				>
					{imgError ? (
						<HiOutlinePuzzlePiece className="size-4" />
					) : (
						<img
							src={iconUrl}
							alt={title}
							className="size-4"
							onError={() => setImgError(true)}
						/>
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				{title}
			</TooltipContent>
		</Tooltip>
	);
}
