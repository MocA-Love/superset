import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createShikiTheme } from "renderer/screens/main/components/WorkspaceView/utils/code-theme/shiki-theme";
import { useResolvedTheme } from "renderer/stores/theme";
import type { SymbolMarkupContent } from "../../symbolInteractions.types";
import { HoverCodeBlock } from "./components/HoverCodeBlock";

interface CodeEditorSymbolHoverProps {
	contents: SymbolMarkupContent[];
	canGoToDefinition: boolean;
	onGoToDefinition?: (() => void) | undefined;
}

function extractCodeFenceLanguage(className?: string): string | undefined {
	if (!className) {
		return undefined;
	}

	const match = /language-([\w-]+)/.exec(className);
	return match?.[1];
}

export function CodeEditorSymbolHover({
	contents,
	canGoToDefinition,
	onGoToDefinition,
}: CodeEditorSymbolHoverProps) {
	const activeTheme = useResolvedTheme();
	const shikiTheme = useMemo(
		() => (activeTheme ? createShikiTheme(activeTheme) : undefined),
		[activeTheme],
	);

	return (
		<div className="cm-superset-symbol-hover select-text">
			<div className="cm-superset-symbol-hover-body">
				{contents.map((content, index) => {
					const key = `${content.kind}:${index}:${content.value.slice(0, 24)}`;
					const sectionClassName =
						index === 0
							? "cm-superset-symbol-hover-section"
							: "cm-superset-symbol-hover-section cm-superset-symbol-hover-section-bordered";

					if (content.kind === "markdown") {
						return (
							<div key={key} className={sectionClassName}>
								<ReactMarkdown
									remarkPlugins={[remarkGfm]}
									components={{
										a: ({ href, children }) => (
											<a
												href={href}
												target="_blank"
												rel="noreferrer"
												className="cm-superset-symbol-hover-link"
											>
												{children}
											</a>
										),
										code: (props) => {
											const { className, children } = props;
											const text = String(children).replace(/\n$/, "");
											const language = extractCodeFenceLanguage(className);
											const inline =
												"inline" in props
													? Boolean(
															(
																props as {
																	inline?: boolean;
																}
															).inline,
														)
													: false;

											if (inline) {
												return (
													<code className="cm-superset-symbol-hover-inline-code">
														{text}
													</code>
												);
											}

											return (
												<HoverCodeBlock
													code={text}
													language={language}
													shikiTheme={shikiTheme}
												/>
											);
										},
										p: ({ children }) => (
											<p className="cm-superset-symbol-hover-paragraph">
												{children}
											</p>
										),
										ul: ({ children }) => (
											<ul className="cm-superset-symbol-hover-list">
												{children}
											</ul>
										),
										ol: ({ children }) => (
											<ol className="cm-superset-symbol-hover-list cm-superset-symbol-hover-list-ordered">
												{children}
											</ol>
										),
										li: ({ children }) => (
											<li className="cm-superset-symbol-hover-list-item">
												{children}
											</li>
										),
										blockquote: ({ children }) => (
											<blockquote className="cm-superset-symbol-hover-blockquote">
												{children}
											</blockquote>
										),
										h1: ({ children }) => (
											<h1 className="cm-superset-symbol-hover-heading">
												{children}
											</h1>
										),
										h2: ({ children }) => (
											<h2 className="cm-superset-symbol-hover-heading">
												{children}
											</h2>
										),
										h3: ({ children }) => (
											<h3 className="cm-superset-symbol-hover-heading">
												{children}
											</h3>
										),
										table: ({ children }) => (
											<div className="cm-superset-symbol-hover-table-wrap">
												<table className="cm-superset-symbol-hover-table">
													{children}
												</table>
											</div>
										),
									}}
								>
									{content.value}
								</ReactMarkdown>
							</div>
						);
					}

					return (
						<div key={key} className={sectionClassName}>
							<pre className="cm-superset-symbol-hover-plaintext">
								{content.value}
							</pre>
						</div>
					);
				})}
			</div>
			{canGoToDefinition ? (
				<div className="cm-superset-symbol-hover-footer">
					<button
						type="button"
						className="cm-superset-symbol-hover-action"
						onMouseDown={(event) => {
							event.preventDefault();
						}}
						onClick={() => {
							onGoToDefinition?.();
						}}
					>
						Go to definition
					</button>
					<span className="cm-superset-symbol-hover-shortcut">
						F12 / Cmd or Ctrl + Click
					</span>
				</div>
			) : null}
		</div>
	);
}
