import type { WebglAddon } from "@xterm/addon-webgl";

/**
 * `@xterm/addon-webgl`'s `RectangleRenderer._updateRectangle` hardcodes the
 * rectangle alpha to `1` for cells with palette/RGB backgrounds. That makes
 * codex- and Claude Code-style TUI blocks paint as fully opaque rectangles
 * even when the terminal theme background is `rgba(0,0,0,0)` under window
 * vibrancy — the symptom the user sees as "black bars behind some lines".
 *
 * We can't fix this from public API alone: the WebGL renderer reads
 * `theme.ansi[i].rgba` for `CM_P16/CM_P256` cells, but discards the alpha
 * channel two lines later. So we patch the prototype to honor the alpha that
 * `parseColor` already preserves, and elsewhere we override the relevant
 * palette entries (`theme.black`, `theme.brightBlack`) to transparent values
 * when vibrancy is on. The TextureAtlas forces foreground glyphs through
 * `color.opaque` (`TextureAtlas.ts:357-359`), so palette-0 *text* keeps
 * rendering at full opacity even after we drop the bg alpha.
 *
 * codex (and Claude Code) emit explicit truecolor backgrounds via
 * `\x1b[48;2;R;G;B m` — see `codex-rs/tui/src/style.rs::user_message_bg`,
 * which queries the terminal's bg via OSC 11 and blends 12% white onto it.
 * When vibrancy reports an OSC 11 of `(0,0,0)` (because we set
 * `theme.background = rgba(0,0,0,0)`), codex paints with `~(30,30,30)` —
 * still very dark and clearly visible as black bars on top of the
 * transparent terminal. CM_RGB cells carry no alpha bits in the SGR
 * encoding, so we apply a brightness-threshold heuristic when vibrancy is
 * active: any RGB cell whose darkest channel is below
 * `NEAR_BLACK_THRESHOLD` is treated as transparent. Coloured highlights
 * (red error rows, blue selections, etc.) all have at least one channel
 * well above the threshold and stay opaque.
 *
 * This is `@xterm/addon-webgl@0.20.0-beta.196` private-API surgery; bumping
 * the addon (the workspace pins it via Bun overrides) requires re-checking
 * `RectangleRenderer.ts` for shape changes. The patch is idempotent and
 * applies once per JS module load, so multiple terminal panes share a single
 * patched prototype.
 */

const PATCHED = Symbol.for("superset.webgl.rectangleRenderer.alphaPatched");

const Attributes = {
	CM_MASK: 0x3000000,
	CM_P16: 0x1000000,
	CM_P256: 0x2000000,
	CM_RGB: 0x3000000,
	CM_DEFAULT: 0,
	PCOLOR_MASK: 0xff,
	RGB_MASK: 0xffffff,
} as const;

const FgFlags = {
	INVERSE: 0x4000000,
} as const;

const INDICES_PER_RECTANGLE = 8;

/**
 * Catches codex's `(30,30,30)`-ish overlay block fills and similar dark-gray
 * panel paints from other ratatui-based TUIs. Bright/colored cells (red
 * errors, blue selections) keep at least one channel >= ~80, so 80 is a
 * conservative cutoff. The renderer only consults this when vibrancy is on,
 * via `setRgbTransparencyForVibrancy(true)`.
 */
const NEAR_BLACK_THRESHOLD = 80;

let rgbTransparencyEnabled = false;

interface VibrancyDebugStats {
	rectsTotal: number;
	cmDefault: number;
	cmP16P256Opaque: number;
	cmP16P256Transparent: number;
	cmRgbOpaque: number;
	cmRgbTransparent: number;
	uniqueRgb: Map<number, number>;
}

function createStats(): VibrancyDebugStats {
	return {
		rectsTotal: 0,
		cmDefault: 0,
		cmP16P256Opaque: 0,
		cmP16P256Transparent: 0,
		cmRgbOpaque: 0,
		cmRgbTransparent: 0,
		uniqueRgb: new Map(),
	};
}

let debugStats: VibrancyDebugStats = createStats();

function expandFloat32Array(
	input: Float32Array,
	minLength: number,
): Float32Array {
	if (input.length >= minLength) return input;
	const next = new Float32Array(Math.max(input.length * 2, minLength));
	next.set(input);
	return next;
}

interface RectVertices {
	attributes: Float32Array;
}

interface RectangleRendererInternals {
	_terminal: { rows: number; cols: number };
	_themeService: {
		colors: {
			ansi: Array<{ rgba: number }>;
			background: { rgba: number };
			foreground: { rgba: number };
		};
	};
	_dimensions: { device: { cell: { width: number; height: number } } };
	_addRectangle(
		array: Float32Array,
		offset: number,
		x1: number,
		y1: number,
		w: number,
		h: number,
		r: number,
		g: number,
		b: number,
		a: number,
	): void;
}

function bumpUniqueRgb(stats: VibrancyDebugStats, rgba: number): void {
	if (stats.uniqueRgb.size > 64) return;
	const key = (rgba >> 8) & 0xffffff;
	stats.uniqueRgb.set(key, (stats.uniqueRgb.get(key) ?? 0) + 1);
}

function patchedUpdateRectangle(
	this: RectangleRendererInternals,
	vertices: RectVertices,
	offset: number,
	fg: number,
	bg: number,
	startX: number,
	endX: number,
	y: number,
): void {
	let rgba: number;
	let alpha: number;
	let bucket: keyof Pick<
		VibrancyDebugStats,
		| "cmDefault"
		| "cmP16P256Opaque"
		| "cmP16P256Transparent"
		| "cmRgbOpaque"
		| "cmRgbTransparent"
	>;

	if (fg & FgFlags.INVERSE) {
		switch (fg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256:
				rgba = this._themeService.colors.ansi[fg & Attributes.PCOLOR_MASK].rgba;
				alpha = (rgba & 0xff) / 255;
				bucket = alpha < 1 ? "cmP16P256Transparent" : "cmP16P256Opaque";
				break;
			case Attributes.CM_RGB:
				rgba = (fg & Attributes.RGB_MASK) << 8;
				// Inverse highlights (selection-like behavior) stay opaque so the
				// inverted character remains legible.
				alpha = 1;
				bucket = "cmRgbOpaque";
				break;
			default:
				rgba = this._themeService.colors.foreground.rgba;
				alpha = (rgba & 0xff) / 255;
				bucket = "cmDefault";
		}
	} else {
		switch (bg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256:
				rgba = this._themeService.colors.ansi[bg & Attributes.PCOLOR_MASK].rgba;
				alpha = (rgba & 0xff) / 255;
				bucket = alpha < 1 ? "cmP16P256Transparent" : "cmP16P256Opaque";
				break;
			case Attributes.CM_RGB: {
				rgba = (bg & Attributes.RGB_MASK) << 8;
				if (rgbTransparencyEnabled) {
					const r = (rgba >> 24) & 0xff;
					const g = (rgba >> 16) & 0xff;
					const b = (rgba >> 8) & 0xff;
					if (Math.max(r, g, b) < NEAR_BLACK_THRESHOLD) {
						alpha = 0;
						bucket = "cmRgbTransparent";
					} else {
						alpha = 1;
						bucket = "cmRgbOpaque";
					}
				} else {
					alpha = 1;
					bucket = "cmRgbOpaque";
				}
				break;
			}
			default:
				rgba = this._themeService.colors.background.rgba;
				alpha = (rgba & 0xff) / 255;
				bucket = "cmDefault";
		}
	}

	debugStats.rectsTotal += 1;
	debugStats[bucket] += 1;
	if (
		bucket === "cmRgbOpaque" ||
		bucket === "cmRgbTransparent" ||
		bucket === "cmP16P256Opaque"
	) {
		bumpUniqueRgb(debugStats, rgba);
	}

	if (vertices.attributes.length < offset + 4) {
		vertices.attributes = expandFloat32Array(
			vertices.attributes,
			this._terminal.rows * this._terminal.cols * INDICES_PER_RECTANGLE,
		);
	}

	const cellWidth = this._dimensions.device.cell.width;
	const cellHeight = this._dimensions.device.cell.height;
	const x1 = startX * cellWidth;
	const y1 = y * cellHeight;
	const r = ((rgba >> 24) & 0xff) / 255;
	const g = ((rgba >> 16) & 0xff) / 255;
	const b = ((rgba >> 8) & 0xff) / 255;

	this._addRectangle(
		vertices.attributes,
		offset,
		x1,
		y1,
		(endX - startX) * cellWidth,
		cellHeight,
		r,
		g,
		b,
		alpha,
	);
}

/**
 * Toggle the brightness-based transparency heuristic for `CM_RGB` cells.
 * Wired from the vibrancy store: enabled when the user has window vibrancy
 * on, disabled otherwise (so non-vibrancy themes render exactly as before).
 */
export function setRgbTransparencyForVibrancy(enabled: boolean): void {
	rgbTransparencyEnabled = enabled;
}

interface VibrancyDebugApi {
	stats: () => VibrancyDebugStats;
	reset: () => void;
	dump: () => void;
	patched: () => boolean;
}

declare global {
	interface Window {
		__supersetTerminalVibrancy__?: VibrancyDebugApi;
	}
}

let prototypePatched = false;

function ensureDebugApi(): void {
	if (typeof window === "undefined") return;
	if (window.__supersetTerminalVibrancy__) return;
	window.__supersetTerminalVibrancy__ = {
		stats: () => debugStats,
		reset: () => {
			debugStats = createStats();
		},
		patched: () => prototypePatched,
		dump: () => {
			const top = [...debugStats.uniqueRgb.entries()]
				.sort(([, a], [, b]) => b - a)
				.slice(0, 16)
				.map(([rgb, count]) => ({
					rgb: `#${rgb.toString(16).padStart(6, "0")}`,
					count,
				}));
			console.table({
				prototypePatched,
				rgbTransparencyEnabled,
				NEAR_BLACK_THRESHOLD,
				rectsTotal: debugStats.rectsTotal,
				cmDefault: debugStats.cmDefault,
				cmP16P256Opaque: debugStats.cmP16P256Opaque,
				cmP16P256Transparent: debugStats.cmP16P256Transparent,
				cmRgbOpaque: debugStats.cmRgbOpaque,
				cmRgbTransparent: debugStats.cmRgbTransparent,
			});
			console.table(top);
		},
	};
	console.log(
		"[terminal-vibrancy] debug API ready: window.__supersetTerminalVibrancy__.dump()",
	);
}

// Install the debug API as soon as this module is imported, so DevTools can
// inspect state even before any terminal pane has mounted.
ensureDebugApi();

/**
 * Patch the `RectangleRenderer.prototype._updateRectangle` shipped with the
 * given `WebglAddon` so that palette/default-bg rectangles honor their alpha
 * and CM_RGB near-black cells become transparent under vibrancy. Idempotent
 * across calls and across multiple addon instances.
 */
export function installRectangleRendererAlphaPatch(addon: WebglAddon): void {
	ensureDebugApi();
	try {
		const renderer = (addon as unknown as { _renderer?: unknown })._renderer as
			| {
					_rectangleRenderer?: { value?: unknown };
			  }
			| undefined;
		const instance = renderer?._rectangleRenderer?.value;
		if (!instance) {
			console.warn(
				"[terminal-vibrancy] addon._renderer._rectangleRenderer.value missing; patch skipped",
			);
			return;
		}
		const proto = Object.getPrototypeOf(instance) as Record<
			PropertyKey,
			unknown
		> & { [PATCHED]?: true };
		if (proto[PATCHED]) {
			prototypePatched = true;
			return;
		}
		const original = proto._updateRectangle;
		if (typeof original !== "function") {
			console.warn(
				"[terminal-vibrancy] _updateRectangle not found on prototype; patch skipped",
			);
			return;
		}
		proto._updateRectangle = patchedUpdateRectangle;
		proto[PATCHED] = true;
		prototypePatched = true;
		console.log(
			"[terminal-vibrancy] WebGL RectangleRenderer alpha patch installed (vibrancy RGB-transparency:",
			rgbTransparencyEnabled ? "on" : "off",
			")",
		);
	} catch (error) {
		console.warn(
			"[terminal-vibrancy] Failed to patch WebGL RectangleRenderer:",
			error,
		);
	}
}
