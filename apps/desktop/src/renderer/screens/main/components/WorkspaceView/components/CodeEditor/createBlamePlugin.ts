import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { electronTrpcClient } from "renderer/lib/trpc-client";

export interface BlameEntry {
	line: number;
	commitHash: string;
	author: string;
	timestamp: number;
	summary: string;
	authorAvatarUrl?: string;
}

interface BlamePluginOptions {
	worktreePath?: string;
}

interface GitHubCommitAuthor {
	login: string | null;
	avatarUrl: string | null;
}

const blameDateFormatter = new Intl.DateTimeFormat("ja-JP-u-hc-h24", {
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

function formatTimeAgo(timestamp: number): string {
	const now = Date.now() / 1000;
	const diff = now - timestamp;

	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
	if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}日前`;
	if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}ヶ月前`;
	return `${Math.floor(diff / (86400 * 365))}年前`;
}

function formatFullDate(timestamp: number): string {
	return blameDateFormatter.format(new Date(timestamp * 1000));
}

function formatInlineText(entry: BlameEntry): string {
	const summary =
		entry.summary.length > 50
			? `${entry.summary.substring(0, 50)}…`
			: entry.summary;
	return `${entry.author}, ${formatTimeAgo(entry.timestamp)} · ${summary}`;
}

function getInitials(name: string): string {
	return name
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? "")
		.join("");
}

// SVG icons as strings
const ICON_COMMIT =
	'<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="0" y1="8" x2="4.5" y2="8" stroke="currentColor" stroke-width="1.5"/><line x1="11.5" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="1.5"/></svg>';

const ICON_COPY =
	'<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';

const _ICON_ARROW =
	'<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.042-.018.75.75 0 0 1-.018-1.042l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06Z"/></svg>';

// Singleton tooltip element
let activeTooltip: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const commitAuthorCache = new Map<string, GitHubCommitAuthor | null>();
const commitAuthorInFlight = new Map<
	string,
	Promise<GitHubCommitAuthor | null>
>();

function clearHideTimer() {
	if (hideTimer !== null) {
		clearTimeout(hideTimer);
		hideTimer = null;
	}
}

function scheduleHide() {
	clearHideTimer();
	hideTimer = setTimeout(() => {
		activeTooltip?.remove();
		activeTooltip = null;
		hideTimer = null;
	}, 120);
}

function setAvatarContent({
	avatar,
	initials,
	avatarUrl,
}: {
	avatar: HTMLDivElement;
	initials: string;
	avatarUrl?: string | null;
}) {
	avatar.replaceChildren();
	avatar.classList.toggle("cm-bt-avatar--image", Boolean(avatarUrl));

	if (!avatarUrl) {
		avatar.textContent = initials;
		return;
	}

	const image = document.createElement("img");
	image.className = "cm-bt-avatar-image";
	image.alt = "";
	image.src = avatarUrl;
	image.referrerPolicy = "no-referrer";
	image.addEventListener("error", () => {
		avatar.classList.remove("cm-bt-avatar--image");
		avatar.replaceChildren();
		avatar.textContent = initials;
	});
	avatar.appendChild(image);
}

function loadCommitAuthor({
	worktreePath,
	commitHash,
}: {
	worktreePath: string;
	commitHash: string;
}): Promise<GitHubCommitAuthor | null> {
	const cacheKey = `${worktreePath}#${commitHash}`;
	const cached = commitAuthorCache.get(cacheKey);
	if (cached !== undefined) {
		return Promise.resolve(cached);
	}

	const inFlight = commitAuthorInFlight.get(cacheKey);
	if (inFlight) {
		return inFlight;
	}

	const request = electronTrpcClient.changes.getGitHubCommitAuthor
		.query({ worktreePath, commitHash })
		.then((result) => {
			commitAuthorCache.set(cacheKey, result);
			return result;
		})
		.catch(() => {
			commitAuthorCache.set(cacheKey, null);
			return null;
		})
		.finally(() => {
			commitAuthorInFlight.delete(cacheKey);
		});

	commitAuthorInFlight.set(cacheKey, request);
	return request;
}

function showTooltip(
	entry: BlameEntry,
	anchor: HTMLElement,
	options?: BlamePluginOptions,
) {
	clearHideTimer();

	if (activeTooltip) {
		activeTooltip.remove();
	}

	const shortHash = entry.commitHash.substring(0, 7);
	const timeAgo = formatTimeAgo(entry.timestamp);
	const fullDate = formatFullDate(entry.timestamp);
	const initials = getInitials(entry.author);

	const tooltip = document.createElement("div");
	tooltip.className = "cm-blame-tooltip";

	// Build tooltip DOM safely without innerHTML to avoid XSS from commit author/summary
	const header = document.createElement("div");
	header.className = "cm-bt-header";

	const avatar = document.createElement("div");
	avatar.className = "cm-bt-avatar";
	setAvatarContent({
		avatar,
		initials,
		avatarUrl: entry.authorAvatarUrl,
	});

	const meta = document.createElement("div");
	meta.className = "cm-bt-meta";

	const authorEl = document.createElement("span");
	authorEl.className = "cm-bt-author";
	authorEl.textContent = entry.author;

	const timeEl = document.createElement("span");
	timeEl.className = "cm-bt-time";
	timeEl.textContent = `${timeAgo} (${fullDate})`;

	meta.append(authorEl, timeEl);
	header.append(avatar, meta);

	const message = document.createElement("div");
	message.className = "cm-bt-message";
	message.textContent = entry.summary;

	const hashRow = document.createElement("div");
	hashRow.className = "cm-bt-hash-row";
	hashRow.innerHTML = `<span class="cm-bt-icon">${ICON_COMMIT}</span>`;

	const hashEl = document.createElement("span");
	hashEl.className = "cm-bt-hash";
	hashEl.textContent = shortHash;

	const copyBtn = document.createElement("button");
	copyBtn.className = "cm-bt-copy-btn";
	copyBtn.title = "コピー";
	copyBtn.innerHTML = ICON_COPY;

	hashRow.append(hashEl, copyBtn);

	tooltip.append(header, message, hashRow);

	// Copy button handler
	copyBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		navigator.clipboard.writeText(entry.commitHash).catch(() => {});
		copyBtn.innerHTML =
			'<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
		setTimeout(() => {
			copyBtn.innerHTML = ICON_COPY;
		}, 1500);
	});

	tooltip.addEventListener("mouseenter", clearHideTimer);
	tooltip.addEventListener("mouseleave", scheduleHide);

	document.body.appendChild(tooltip);
	activeTooltip = tooltip;

	// Position above the anchor line, aligned to left edge
	const rect = anchor.getBoundingClientRect();
	tooltip.style.left = `${rect.left}px`;
	tooltip.style.top = "0px"; // temp

	requestAnimationFrame(() => {
		if (!activeTooltip) return;
		const th = activeTooltip.getBoundingClientRect().height;
		const top = rect.top - th - 8;
		activeTooltip.style.top = `${top < 8 ? rect.bottom + 8 : top}px`;
	});

	if (!entry.authorAvatarUrl && options?.worktreePath) {
		void loadCommitAuthor({
			worktreePath: options.worktreePath,
			commitHash: entry.commitHash,
		}).then((authorInfo) => {
			if (activeTooltip !== tooltip || !authorInfo?.avatarUrl) {
				return;
			}

			setAvatarContent({
				avatar,
				initials,
				avatarUrl: authorInfo.avatarUrl,
			});
		});
	}
}

class BlameWidget extends WidgetType {
	constructor(
		private readonly text: string,
		private readonly entry: BlameEntry,
		private readonly options?: BlamePluginOptions,
	) {
		super();
	}

	eq(_other: BlameWidget): boolean {
		// 常に false にして DOM を再利用しない。
		// eq() が true だと toDOM() が呼ばれず hasLeft がリセットされないため、
		// mouseleave 後に同じ行へ戻ると即座にトリップが表示されるバグが発生する。
		return false;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "cm-blame-inline";
		span.textContent = `\u00a0\u00a0${this.text}`;
		span.setAttribute("aria-hidden", "true");

		// ウィジェット生成直後にカーソルが上にあっても表示しない。
		// 一度マウスが離れてから戻ってきた時、またはホバーしたまま2秒経過したら表示する。
		let hasLeft = false;
		let dwellTimer: ReturnType<typeof setTimeout> | null = null;

		const clearDwellTimer = () => {
			if (dwellTimer !== null) {
				clearTimeout(dwellTimer);
				dwellTimer = null;
			}
		};

		// destroy() からクリーンアップできるよう DOM に持たせる
		(
			span as HTMLElement & {
				_dwellTimer?: ReturnType<typeof setTimeout> | null;
			}
		)._dwellTimer = null;

		span.addEventListener("mouseenter", () => {
			if (hasLeft) {
				// 一度離れた後に戻ってきた → 即表示
				showTooltip(this.entry, span, this.options);
			} else {
				// 初回ホバー（ウィジェット生成直後から乗っている状態）→ 2秒待つ
				dwellTimer = setTimeout(() => {
					dwellTimer = null;
					showTooltip(this.entry, span, this.options);
				}, 1000);
				(
					span as HTMLElement & {
						_dwellTimer?: ReturnType<typeof setTimeout> | null;
					}
				)._dwellTimer = dwellTimer;
			}
		});
		span.addEventListener("mouseleave", () => {
			clearDwellTimer();
			hasLeft = true;
			scheduleHide();
		});

		return span;
	}

	destroy(dom: HTMLElement): void {
		// カーソルが別の行に移った際にタイマーをクリーンアップ
		const timer = (
			dom as HTMLElement & { _dwellTimer?: ReturnType<typeof setTimeout> }
		)._dwellTimer;
		if (timer !== null && timer !== undefined) clearTimeout(timer);
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildBlameDecorations(
	view: EditorView,
	blameMap: Map<number, BlameEntry>,
	options?: BlamePluginOptions,
): DecorationSet {
	const doc = view.state.doc;
	const cursorPos = view.state.selection.main.head;
	const cursorLine = doc.lineAt(cursorPos).number;

	const entry = blameMap.get(cursorLine);
	if (!entry) return Decoration.none;

	const line = doc.line(cursorLine);
	const text = formatInlineText(entry);

	return Decoration.set([
		Decoration.widget({
			widget: new BlameWidget(text, entry, options),
			side: 1,
		}).range(line.to),
	]);
}

const blameTheme = EditorView.baseTheme({
	".cm-blame-inline": {
		opacity: "0.4",
		fontSize: "0.85em",
		fontStyle: "italic",
		userSelect: "none",
		color: "inherit",
		whiteSpace: "pre",
		cursor: "default",
		"&:hover": {
			opacity: "0.7",
		},
	},
});

const blameTooltipStyles = `
.cm-blame-tooltip {
  position: fixed;
  z-index: 10000;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  padding: 10px 12px 8px;
  min-width: 320px;
  max-width: 520px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-style: normal;
  pointer-events: auto;
  color: var(--popover-foreground);
}

.cm-bt-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.cm-bt-avatar {
  width: 28px;
  height: 28px;
  min-width: 28px;
  border-radius: calc(var(--radius) - 4px);
  background: var(--secondary);
  color: var(--secondary-foreground);
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: 0.02em;
  border: 1px solid var(--border);
  overflow: hidden;
}

.cm-bt-avatar--image {
  background: transparent;
  color: transparent;
}

.cm-bt-avatar-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cm-bt-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.cm-bt-author {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--popover-foreground);
  line-height: 1.3;
}

.cm-bt-time {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  line-height: 1.3;
}

.cm-bt-message {
  font-size: 0.82rem;
  color: var(--popover-foreground);
  margin-bottom: 8px;
  line-height: 1.45;
  word-break: break-word;
  padding-left: 38px;
}

.cm-bt-hash-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
  border-top: 1px solid var(--border);
}

.cm-bt-changes-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
  border-top: 1px solid var(--border);
  margin-top: 2px;
}

.cm-bt-changes-label {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  margin-right: 2px;
}

.cm-bt-icon {
  display: flex;
  align-items: center;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.cm-bt-icon-arrow {
  color: var(--muted-foreground);
  opacity: 0.5;
}

.cm-bt-hash {
  font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
  font-size: 0.78rem;
  color: var(--chart-1);
  letter-spacing: 0.02em;
}

.cm-bt-hash-muted {
  color: var(--muted-foreground);
}

.cm-bt-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted-foreground);
  padding: 2px 4px;
  border-radius: calc(var(--radius) - 6px);
  margin-left: 2px;
  transition: color 0.15s, background 0.15s;
}

.cm-bt-copy-btn:hover {
  color: var(--popover-foreground);
  background: var(--accent);
}
`;

function injectBlameTooltipStyles() {
	const id = "cm-blame-tooltip-styles";
	if (document.getElementById(id)) return;
	const style = document.createElement("style");
	style.id = id;
	style.textContent = blameTooltipStyles;
	document.head.appendChild(style);
}

export function createBlamePlugin(
	entries: BlameEntry[],
	options?: BlamePluginOptions,
): Extension {
	injectBlameTooltipStyles();

	const blameMap = new Map<number, BlameEntry>(entries.map((e) => [e.line, e]));

	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private lastCursorLine = -1;

			constructor(view: EditorView) {
				this.decorations = buildBlameDecorations(view, blameMap, options);
				this.lastCursorLine = view.state.doc.lineAt(
					view.state.selection.main.head,
				).number;
			}

			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet
				) {
					if (update.selectionSet) {
						const newLine = update.view.state.doc.lineAt(
							update.view.state.selection.main.head,
						).number;
						// カーソル行が変わったら古いトリップを即座に閉じる
						if (newLine !== this.lastCursorLine) {
							activeTooltip?.remove();
							activeTooltip = null;
							clearHideTimer();
							this.lastCursorLine = newLine;
						}
					}
						this.decorations = buildBlameDecorations(
							update.view,
							blameMap,
							options,
						);
					}
				}
			},
		{ decorations: (v) => v.decorations },
	);

	return [plugin, blameTheme];
}
