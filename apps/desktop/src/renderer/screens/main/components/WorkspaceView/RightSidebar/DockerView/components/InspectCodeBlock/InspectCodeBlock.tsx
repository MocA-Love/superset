import { highlightCode } from "@superset/ui/ai-elements/code-block";
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
	const [html, setHtml] = useState("");

	useEffect(() => {
		let cancelled = false;

		void highlightCode(code, language, false, {
			lightTheme: theme,
			darkTheme: theme,
		}).then(([nextHtml]) => {
			if (!cancelled) {
				setHtml(nextHtml);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [code, language, theme]);

	return (
		<div
			className="inline-block min-w-full align-top [&>pre]:m-0 [&>pre]:max-w-none [&>pre]:bg-transparent! [&>pre]:p-4 [&>pre]:text-sm [&>pre]:whitespace-pre [&>pre]:w-max [&_code]:font-mono [&_code]:text-sm"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki HTML rendering is required here.
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
