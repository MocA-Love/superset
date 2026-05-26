import {
	type HighlightedCode,
	highlightCode,
	renderHighlightedCode,
} from "@superset/ui/ai-elements/code-block";
import { useEffect, useMemo, useState } from "react";
import { createShikiTheme } from "renderer/screens/main/components/WorkspaceView/utils/code-theme/shiki-theme";
import { useResolvedTheme } from "renderer/stores/theme";

interface InspectCodeBlockProps {
	code: string;
	language: "json";
}

export function InspectCodeBlock({ code, language }: InspectCodeBlockProps) {
	const activeTheme = useResolvedTheme();
	const theme = useMemo(
		() => (activeTheme ? createShikiTheme(activeTheme) : undefined),
		[activeTheme],
	);
	const [highlightedCode, setHighlightedCode] =
		useState<HighlightedCode | null>(null);

	useEffect(() => {
		let cancelled = false;

		void highlightCode(code, language, false, {
			lightTheme: theme,
			darkTheme: theme,
		}).then(([nextHighlightedCode]) => {
			if (!cancelled) {
				setHighlightedCode(nextHighlightedCode);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [code, language, theme]);

	return (
		<div className="inline-block min-w-full align-top [&>pre]:m-0 [&>pre]:max-w-none [&>pre]:bg-transparent! [&>pre]:p-4 [&>pre]:text-sm [&>pre]:whitespace-pre [&>pre]:w-max [&_code]:font-mono [&_code]:text-sm">
			{highlightedCode ? renderHighlightedCode(highlightedCode) : null}
		</div>
	);
}
