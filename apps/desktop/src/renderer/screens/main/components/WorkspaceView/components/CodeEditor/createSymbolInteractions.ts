import type { Extension, Text } from "@codemirror/state";
import {
	EditorView,
	hoverTooltip,
	keymap,
	type Tooltip,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { CodeEditorSymbolHover } from "./components/CodeEditorSymbolHover";
import type {
	SymbolHoverResult,
	SymbolPosition,
} from "./symbolInteractions.types";

/**
 * Symbol-action callback. Returns `true` when a handler was actually
 * dispatched (so the caller should consume the corresponding key /
 * mouse event), `false` when no handler is currently bound (so the
 * caller should let the event fall through to default behavior).
 *
 * Wrappers passed from `CodeEditor` always return `false` when their
 * underlying ref has not been set yet, so keybindings registered by
 * `createSymbolInteractions` are never consumed prematurely.
 */
type SymbolAction = (position: SymbolPosition) => boolean;

interface CreateSymbolInteractionsOptions {
	resolveHover?: (
		position: SymbolPosition,
	) => Promise<SymbolHoverResult | null> | SymbolHoverResult | null;
	onGoToDefinition?: SymbolAction;
	onGoToTypeDefinition?: SymbolAction;
	onGoToImplementation?: SymbolAction;
	onFindAllReferences?: SymbolAction;
	onRenameSymbol?: SymbolAction;
	onShowCodeActions?: SymbolAction;
	onCursorChange?: (position: SymbolPosition | null) => void;
}

function docOffsetToPosition(doc: Text, offset: number): SymbolPosition {
	const line = doc.lineAt(offset);
	return {
		line: line.number,
		column: offset - line.from + 1,
	};
}

function positionToDocOffset(doc: Text, position: SymbolPosition): number {
	const safeLine = Math.max(1, Math.min(position.line, doc.lines));
	const line = doc.line(safeLine);
	return Math.min(line.from + Math.max(position.column - 1, 0), line.to);
}

function rangeToOffsets(
	doc: Text,
	range: SymbolHoverResult["range"],
	fallbackOffset: number,
): { from: number; to: number } {
	if (!range) {
		return {
			from: fallbackOffset,
			to: Math.min(doc.length, fallbackOffset + 1),
		};
	}

	const from = positionToDocOffset(doc, {
		line: range.line,
		column: range.column,
	});
	const rawTo = positionToDocOffset(doc, {
		line: range.endLine,
		column: range.endColumn,
	});

	return {
		from,
		to: Math.min(doc.length, Math.max(from + 1, rawTo)),
	};
}

function isDefinitionModifierPressed(event: {
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}) {
	return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

function createTooltip(
	hover: SymbolHoverResult,
	doc: Text,
	pos: number,
	canGoToDefinition: boolean,
	onGoToDefinition?: (() => void) | undefined,
): Tooltip {
	const dom = document.createElement("div");
	const root = createRoot(dom);

	root.render(
		createElement(CodeEditorSymbolHover, {
			contents: hover.contents,
			canGoToDefinition,
			onGoToDefinition,
		}),
	);

	const { from, to } = rangeToOffsets(doc, hover.range, pos);
	return {
		pos: from,
		end: to,
		above: true,
		arrow: true,
		create() {
			return {
				dom,
				destroy() {
					root.unmount();
				},
			};
		},
	};
}

function createDefinitionLinkPlugin(): Extension {
	return ViewPlugin.fromClass(
		class {
			private modifierPressed = false;
			private hoveredOffset: number | null = null;
			private lastPointerCoords: { x: number; y: number } | null = null;
			private highlightedElement: HTMLElement | null = null;
			private highlightedElementPreviousStyle: {
				cursor: string;
				textDecoration: string;
				textDecorationColor: string;
				textDecorationThickness: string;
				textUnderlineOffset: string;
			} | null = null;
			private readonly handleMouseMove = (event: MouseEvent) => {
				this.onMouseMove(event);
			};
			private readonly handleMouseLeave = () => {
				this.onMouseLeave();
			};
			private readonly handleWindowKeyChange = (event: KeyboardEvent) => {
				this.setModifierPressed(isDefinitionModifierPressed(event));
			};
			private readonly handleWindowBlur = () => {
				this.setModifierPressed(false);
			};
			private readonly window: Window | null;

			constructor(private readonly view: EditorView) {
				this.window = this.view.dom.ownerDocument.defaultView;
				this.view.dom.addEventListener("mousemove", this.handleMouseMove);
				this.view.dom.addEventListener("mouseleave", this.handleMouseLeave);
				this.window?.addEventListener("keydown", this.handleWindowKeyChange);
				this.window?.addEventListener("keyup", this.handleWindowKeyChange);
				this.window?.addEventListener("blur", this.handleWindowBlur);
			}

			update(update: ViewUpdate) {
				if (update.docChanged) {
					this.syncHighlight();
				}
			}

			private onMouseMove(event: MouseEvent) {
				this.lastPointerCoords = {
					x: event.clientX,
					y: event.clientY,
				};

				if (!this.modifierPressed) {
					this.setHoveredOffset(null);
					return;
				}

				this.setHoveredOffset(
					this.view.posAtCoords({
						x: event.clientX,
						y: event.clientY,
					}),
				);
			}

			private onMouseLeave() {
				this.lastPointerCoords = null;
				this.setHoveredOffset(null);
			}

			destroy() {
				this.view.dom.removeEventListener("mousemove", this.handleMouseMove);
				this.view.dom.removeEventListener("mouseleave", this.handleMouseLeave);
				this.window?.removeEventListener("keydown", this.handleWindowKeyChange);
				this.window?.removeEventListener("keyup", this.handleWindowKeyChange);
				this.window?.removeEventListener("blur", this.handleWindowBlur);
				this.clearHighlight();
			}

			private setModifierPressed(nextValue: boolean) {
				if (this.modifierPressed === nextValue) {
					return;
				}

				this.modifierPressed = nextValue;
				if (this.modifierPressed && this.lastPointerCoords) {
					this.setHoveredOffset(this.view.posAtCoords(this.lastPointerCoords));
					return;
				}

				this.setHoveredOffset(null);
			}

			private setHoveredOffset(offset: number | null) {
				if (this.hoveredOffset === offset) {
					return;
				}

				this.hoveredOffset = offset;
				this.syncHighlight();
			}

			private clearHighlight() {
				if (this.highlightedElement && this.highlightedElementPreviousStyle) {
					this.highlightedElement.style.cursor =
						this.highlightedElementPreviousStyle.cursor;
					this.highlightedElement.style.textDecoration =
						this.highlightedElementPreviousStyle.textDecoration;
					this.highlightedElement.style.textDecorationColor =
						this.highlightedElementPreviousStyle.textDecorationColor;
					this.highlightedElement.style.textDecorationThickness =
						this.highlightedElementPreviousStyle.textDecorationThickness;
					this.highlightedElement.style.textUnderlineOffset =
						this.highlightedElementPreviousStyle.textUnderlineOffset;
				}

				this.highlightedElement = null;
				this.highlightedElementPreviousStyle = null;
				this.view.dom.classList.remove("cm-definition-link-mode");
			}

			private syncHighlight() {
				this.clearHighlight();
				if (!this.modifierPressed || this.hoveredOffset === null) {
					return;
				}

				const domAtPos = this.view.domAtPos(this.hoveredOffset);
				const baseElement =
					domAtPos.node instanceof HTMLElement
						? domAtPos.node
						: domAtPos.node.parentElement;
				const tokenElement = baseElement?.closest("span");
				if (
					!(tokenElement instanceof HTMLElement) ||
					!this.view.dom.contains(tokenElement)
				) {
					return;
				}

				this.highlightedElementPreviousStyle = {
					cursor: tokenElement.style.cursor,
					textDecoration: tokenElement.style.textDecoration,
					textDecorationColor: tokenElement.style.textDecorationColor,
					textDecorationThickness: tokenElement.style.textDecorationThickness,
					textUnderlineOffset: tokenElement.style.textUnderlineOffset,
				};
				tokenElement.style.cursor = "pointer";
				tokenElement.style.textDecoration = "underline";
				tokenElement.style.textDecorationColor = "currentColor";
				tokenElement.style.textDecorationThickness = "1px";
				tokenElement.style.textUnderlineOffset = "2px";
				this.highlightedElement = tokenElement;
				this.view.dom.classList.add("cm-definition-link-mode");
			}
		},
	);
}

function logSymbolInteractionError(action: string, error: unknown) {
	console.error(`Failed to ${action}`, error);
}

export function createSymbolInteractions({
	resolveHover,
	onGoToDefinition,
	onGoToTypeDefinition,
	onGoToImplementation,
	onFindAllReferences,
	onRenameSymbol,
	onShowCodeActions,
	onCursorChange,
}: CreateSymbolInteractionsOptions): Extension[] {
	const extensions: Extension[] = [];
	const wrapAction = (
		label: string,
		action?: SymbolAction,
	): SymbolAction | undefined =>
		action === undefined
			? undefined
			: (position: SymbolPosition) => {
					try {
						return action(position);
					} catch (error) {
						logSymbolInteractionError(label, error);
						return false;
					}
				};
	const runGoToDefinition = wrapAction("go to definition", onGoToDefinition);
	const runGoToTypeDefinition = wrapAction(
		"go to type definition",
		onGoToTypeDefinition,
	);
	const runGoToImplementation = wrapAction(
		"go to implementation",
		onGoToImplementation,
	);
	const runFindAllReferences = wrapAction(
		"find all references",
		onFindAllReferences,
	);
	const runRenameSymbol = wrapAction("rename symbol", onRenameSymbol);
	const runShowCodeActions = wrapAction("show code actions", onShowCodeActions);

	if (resolveHover) {
		extensions.push(
			hoverTooltip(
				async (view, pos): Promise<Tooltip | null> => {
					const position = docOffsetToPosition(view.state.doc, pos);
					let hover: SymbolHoverResult | null;
					try {
						hover = await resolveHover(position);
					} catch (error) {
						logSymbolInteractionError("resolve symbol hover", error);
						return null;
					}
					if (!hover || hover.contents.length === 0) {
						return null;
					}

					return createTooltip(
						hover,
						view.state.doc,
						pos,
						Boolean(runGoToDefinition),
						runGoToDefinition
							? () => {
									runGoToDefinition(position);
								}
							: undefined,
					);
				},
				{ hoverTime: 250 },
			),
		);
	}

	if (runGoToDefinition) {
		extensions.push(createDefinitionLinkPlugin());
		extensions.push(
			keymap.of([
				{
					key: "F12",
					run(view) {
						return runGoToDefinition(
							docOffsetToPosition(
								view.state.doc,
								view.state.selection.main.head,
							),
						);
					},
				},
			]),
		);

		extensions.push(
			EditorView.domEventHandlers({
				mousedown(event, view) {
					if (
						event.button !== 0 ||
						!isDefinitionModifierPressed(event) ||
						event.defaultPrevented
					) {
						return false;
					}

					const offset = view.posAtCoords({
						x: event.clientX,
						y: event.clientY,
					});
					if (offset === null) {
						return false;
					}

					const handled = runGoToDefinition(
						docOffsetToPosition(view.state.doc, offset),
					);
					if (handled) {
						event.preventDefault();
					}
					return handled;
				},
			}),
		);
	}

	const additionalKeyBindings: Array<{
		key: string;
		run: (view: EditorView) => boolean;
	}> = [];

	if (runFindAllReferences) {
		additionalKeyBindings.push({
			key: "Shift-F12",
			run(view) {
				return runFindAllReferences(
					docOffsetToPosition(view.state.doc, view.state.selection.main.head),
				);
			},
		});
	}

	if (runRenameSymbol) {
		additionalKeyBindings.push({
			key: "F2",
			run(view) {
				return runRenameSymbol(
					docOffsetToPosition(view.state.doc, view.state.selection.main.head),
				);
			},
		});
	}

	if (runShowCodeActions) {
		additionalKeyBindings.push({
			key: "Mod-.",
			run(view) {
				return runShowCodeActions(
					docOffsetToPosition(view.state.doc, view.state.selection.main.head),
				);
			},
		});
	}

	if (additionalKeyBindings.length > 0) {
		extensions.push(keymap.of(additionalKeyBindings));
	}

	// Type def / implementation are surfaced via the context menu only for
	// now (no dedicated keymap). Keep the wrapped runners alive so callers
	// can still pass these handlers.
	void runGoToTypeDefinition;
	void runGoToImplementation;

	if (onCursorChange) {
		const notifyCursor = (view: EditorView) => {
			onCursorChange(
				view.hasFocus
					? docOffsetToPosition(view.state.doc, view.state.selection.main.head)
					: null,
			);
		};

		extensions.push(
			ViewPlugin.fromClass(
				class {
					constructor(view: EditorView) {
						notifyCursor(view);
					}

					update(update: ViewUpdate) {
						if (
							update.selectionSet ||
							update.focusChanged ||
							update.docChanged
						) {
							notifyCursor(update.view);
						}
					}

					destroy() {
						onCursorChange(null);
					}
				},
			),
		);
	}

	return extensions;
}
