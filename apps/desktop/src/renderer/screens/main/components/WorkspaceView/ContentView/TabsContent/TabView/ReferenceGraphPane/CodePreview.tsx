import { memo, useEffect, useState } from "react";
import { highlightCode } from "./lib/highlighter";

interface CodePreviewProps {
	code: string;
	language: string;
	startLine: number;
	shikiTheme?: {
		name: string;
		type: string;
		colors: object;
		tokenColors: object[];
	};
}

export const CodePreview = memo(function CodePreview({
	code,
	language,
	startLine,
	shikiTheme,
}: CodePreviewProps) {
	const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		async function highlight() {
			try {
				const html = await highlightCode(
					code,
					language || "typescript",
					shikiTheme,
				);
				if (!cancelled) {
					setHighlightedHtml(html);
				}
			} catch {
				if (!cancelled) {
					setHighlightedHtml(null);
				}
			}
		}

		highlight();

		return () => {
			cancelled = true;
		};
	}, [code, language, shikiTheme]);

	const lines = code.split("\n");

	if (highlightedHtml) {
		return (
			<div className="ref-graph-code-preview">
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output */}
				<div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
			</div>
		);
	}

	// Fallback: plain text with line numbers
	return (
		<div className="ref-graph-code-preview">
			<pre>
				<code>
					{lines.map((line, index) => {
						const lineNum = startLine + index;
						return (
							<div key={`${lineNum}:${line}`} className="ref-graph-code-line">
								<span className="ref-graph-code-line-number">{lineNum}</span>
								<span className="ref-graph-code-line-content">
									{line || " "}
								</span>
							</div>
						);
					})}
				</code>
			</pre>
		</div>
	);
});
