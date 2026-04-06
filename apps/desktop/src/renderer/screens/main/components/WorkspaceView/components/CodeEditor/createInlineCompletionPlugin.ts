import {
	EditorSelection,
	Prec,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

export interface InlineCompletionRequestArgs {
	currentFileContent: string;
	cursorOffset: number;
}

export type InlineCompletionRequest = (
	args: InlineCompletionRequestArgs,
) => Promise<string | null>;

class InlineCompletionWidget extends WidgetType {
	constructor(private readonly text: string) {
		super();
	}

	eq(other: InlineCompletionWidget) {
		return other.text === this.text;
	}

	toDOM() {
		const element = document.createElement("span");
		element.className = "cm-inline-completion";
		element.textContent = this.text;
		return element;
	}
}

const setInlineCompletionEffect = StateEffect.define<string>();
const clearInlineCompletionEffect = StateEffect.define<void>();

const inlineCompletionField = StateField.define<string>({
	create() {
		return "";
	},
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(clearInlineCompletionEffect)) {
				return "";
			}
			if (effect.is(setInlineCompletionEffect)) {
				return effect.value;
			}
		}

		if (transaction.docChanged || transaction.selection) {
			return "";
		}

		return value;
	},
	provide: (field) =>
		EditorView.decorations.compute([field], (state) => {
			const text = state.field(field);
			if (!text) {
				return Decoration.none;
			}

			const selection = state.selection.main;
			if (!selection.empty) {
				return Decoration.none;
			}

			return Decoration.set([
				Decoration.widget({
					widget: new InlineCompletionWidget(text),
					side: 1,
				}).range(selection.from),
			]);
		}),
});

const inlineCompletionTheme = EditorView.baseTheme({
	".cm-inline-completion": {
		color: "var(--muted-foreground)",
		opacity: "0.55",
		pointerEvents: "none",
		whiteSpace: "pre",
	},
});

function clearInlineCompletion(view: EditorView): boolean {
	const suggestion = view.state.field(inlineCompletionField, false);
	if (!suggestion) {
		return false;
	}

	view.dispatch({
		effects: clearInlineCompletionEffect.of(undefined),
	});
	return true;
}

export function createInlineCompletionPlugin(
	request: InlineCompletionRequest,
	options?: { delayMs?: number },
) {
	const delayMs = options?.delayMs ?? 350;

	const plugin = ViewPlugin.fromClass(
		class {
			private timeoutId: number | null = null;
			private requestId = 0;
			private destroyed = false;

			constructor(private readonly view: EditorView) {
				this.schedule();
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.selectionSet || update.focusChanged) {
					this.schedule();
				}
			}

			destroy() {
				this.destroyed = true;
				if (this.timeoutId !== null) {
					window.clearTimeout(this.timeoutId);
					this.timeoutId = null;
				}
			}

			private schedule() {
				if (this.timeoutId !== null) {
					window.clearTimeout(this.timeoutId);
					this.timeoutId = null;
				}

				const selection = this.view.state.selection.main;
				if (
					this.view.state.readOnly ||
					!this.view.hasFocus ||
					!selection.empty
				) {
					clearInlineCompletion(this.view);
					return;
				}

				const currentRequestId = ++this.requestId;
				const snapshotText = this.view.state.doc.toString();
				const snapshotCursor = selection.from;
				this.timeoutId = window.setTimeout(() => {
					this.timeoutId = null;
					void request({
						currentFileContent: snapshotText,
						cursorOffset: snapshotCursor,
					})
						.then((suggestion) => {
							if (this.destroyed || currentRequestId !== this.requestId) {
								return;
							}

							const latestSelection = this.view.state.selection.main;
							if (
								!latestSelection.empty ||
								latestSelection.from !== snapshotCursor ||
								this.view.state.doc.toString() !== snapshotText
							) {
								return;
							}

							if (!suggestion) {
								clearInlineCompletion(this.view);
								return;
							}

							this.view.dispatch({
								effects: setInlineCompletionEffect.of(suggestion),
							});
						})
						.catch((error) => {
							if (this.destroyed || currentRequestId !== this.requestId) {
								return;
							}
							console.warn(
								"[CodeEditor] Inline completion request failed:",
								error,
							);
							clearInlineCompletion(this.view);
						});
				}, delayMs);
			}
		},
	);

	return [
		inlineCompletionField,
		inlineCompletionTheme,
		plugin,
		Prec.highest(
			keymap.of([
				{
					key: "Tab",
					run(view) {
						const suggestion = view.state.field(inlineCompletionField, false);
						if (!suggestion) {
							return false;
						}

						const cursor = view.state.selection.main.from;
						view.dispatch({
							changes: {
								from: cursor,
								to: cursor,
								insert: suggestion,
							},
							selection: EditorSelection.cursor(cursor + suggestion.length),
							effects: clearInlineCompletionEffect.of(undefined),
						});
						return true;
					},
				},
				{
					key: "Escape",
					run(view) {
						return clearInlineCompletion(view);
					},
				},
			]),
		),
	];
}
