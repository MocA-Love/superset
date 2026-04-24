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
 * `CM_RGB` cells stay opaque (no alpha bits in the SGR `48;2;r;g;b` packing),
 * matching the original behavior so TUIs that paint deliberate solid-color
 * highlights aren't accidentally erased.
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
	let preserveAlpha: boolean;

	if (fg & FgFlags.INVERSE) {
		switch (fg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256:
				rgba = this._themeService.colors.ansi[fg & Attributes.PCOLOR_MASK].rgba;
				preserveAlpha = true;
				break;
			case Attributes.CM_RGB:
				rgba = (fg & Attributes.RGB_MASK) << 8;
				preserveAlpha = false;
				break;
			default:
				rgba = this._themeService.colors.foreground.rgba;
				preserveAlpha = true;
		}
	} else {
		switch (bg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256:
				rgba = this._themeService.colors.ansi[bg & Attributes.PCOLOR_MASK].rgba;
				preserveAlpha = true;
				break;
			case Attributes.CM_RGB:
				rgba = (bg & Attributes.RGB_MASK) << 8;
				preserveAlpha = false;
				break;
			default:
				rgba = this._themeService.colors.background.rgba;
				preserveAlpha = true;
		}
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
	const a = preserveAlpha ? (rgba & 0xff) / 255 : 1;

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
		a,
	);
}

/**
 * Patch the `RectangleRenderer.prototype._updateRectangle` shipped with the
 * given `WebglAddon` so that palette/default-bg rectangles honor their alpha.
 * Idempotent across calls and across multiple addon instances.
 */
export function installRectangleRendererAlphaPatch(addon: WebglAddon): void {
	try {
		const renderer = (addon as unknown as { _renderer?: unknown })._renderer as
			| {
					_rectangleRenderer?: { value?: unknown };
			  }
			| undefined;
		const instance = renderer?._rectangleRenderer?.value;
		if (!instance) return;
		const proto = Object.getPrototypeOf(instance) as Record<
			PropertyKey,
			unknown
		> & { [PATCHED]?: true };
		if (proto[PATCHED]) return;
		const original = proto._updateRectangle;
		if (typeof original !== "function") return;
		proto._updateRectangle = patchedUpdateRectangle;
		proto[PATCHED] = true;
	} catch (error) {
		console.warn(
			"[terminal] Failed to patch WebGL RectangleRenderer for vibrancy:",
			error,
		);
	}
}
