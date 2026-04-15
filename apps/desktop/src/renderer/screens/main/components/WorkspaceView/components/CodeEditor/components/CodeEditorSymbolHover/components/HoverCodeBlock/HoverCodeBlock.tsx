import { useEffect, useState } from "react";
import { highlightCode } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/ReferenceGraphPane/lib/highlighter";

interface HoverCodeBlockProps {
	code: string;
	language?: string;
	shikiTheme?: {
		name: string;
		type: string;
		colors: object;
		tokenColors: object[];
	};
}

export function HoverCodeBlock({
	code,
	language,
	shikiTheme,
}: HoverCodeBlockProps) {
	const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		if (!language) {
			setHighlightedHtml(null);
			return;
		}

		void highlightCode(code, language, shikiTheme)
			.then((html) => {
				if (!cancelled) {
					setHighlightedHtml(html);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setHighlightedHtml(null);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [code, language, shikiTheme]);

	if (highlightedHtml) {
		return (
			<div className="cm-superset-symbol-hover-code-block">
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates trusted HTML */}
				<div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
			</div>
		);
	}

	return (
		<pre className="cm-superset-symbol-hover-code-block">
			<code>{code}</code>
		</pre>
	);
}
