"use client";

export type ClickableFilePathProps = {
	path: string;
	display?: string;
	onOpen?: () => void;
	className?: string;
};

export function ClickableFilePath({
	path,
	display,
	onOpen,
	className,
}: ClickableFilePathProps) {
	const label =
		display ?? (path.includes("/") ? path.split("/").pop() || path : path);

	if (!onOpen) {
		return <span className={className}>{label}</span>;
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: this must nest safely inside tool row trigger buttons.
		<span
			role="button"
			tabIndex={0}
			aria-label={`Open ${path} in file pane`}
			className={`cursor-pointer underline-offset-2 transition-colors hover:text-foreground hover:underline ${className ?? ""}`}
			onClick={(event) => {
				event.stopPropagation();
				onOpen();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					event.stopPropagation();
					onOpen();
				}
			}}
		>
			{label}
		</span>
	);
}
