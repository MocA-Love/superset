import { describe, expect, it } from "bun:test";
import { darkTheme } from "shared/themes";
import { __testing } from "./index";

const { themeSchema, themeStateSchema } = __testing;

describe("themeSchema", () => {
	it("preserves the editor field on a custom theme", () => {
		const input = {
			id: "my-custom",
			name: "My Custom",
			type: "dark" as const,
			ui: darkTheme.ui,
			terminal: darkTheme.terminal,
			editor: {
				colors: {
					background: "#111111",
					foreground: "#eeeeee",
				},
				syntax: {
					keyword: "#ff6688",
					string: "#88ff66",
				},
			},
			isCustom: true,
		};

		const parsed = themeSchema.parse(input);

		expect(parsed.editor).toBeDefined();
		expect(parsed.editor?.colors?.background).toBe("#111111");
		expect(parsed.editor?.colors?.foreground).toBe("#eeeeee");
		expect(parsed.editor?.syntax?.keyword).toBe("#ff6688");
		expect(parsed.editor?.syntax?.string).toBe("#88ff66");
	});

	it("accepts a theme without terminal overrides", () => {
		const input = {
			id: "no-terminal",
			name: "No Terminal",
			type: "light" as const,
			ui: darkTheme.ui,
			isCustom: true,
		};

		expect(() => themeSchema.parse(input)).not.toThrow();
	});

	it("accepts a theme without editor overrides", () => {
		const input = {
			id: "no-editor",
			name: "No Editor",
			type: "dark" as const,
			ui: darkTheme.ui,
			terminal: darkTheme.terminal,
			isCustom: true,
		};

		const parsed = themeSchema.parse(input);
		expect(parsed.editor).toBeUndefined();
	});

	it("preserves partial editor.colors overrides", () => {
		const input = {
			id: "partial-colors",
			name: "Partial Colors",
			type: "dark" as const,
			ui: darkTheme.ui,
			editor: {
				colors: {
					addition: "#00ff00",
				},
			},
		};

		const parsed = themeSchema.parse(input);
		expect(parsed.editor?.colors?.addition).toBe("#00ff00");
	});

	it("preserves partial editor.syntax overrides", () => {
		const input = {
			id: "partial-syntax",
			name: "Partial Syntax",
			type: "dark" as const,
			ui: darkTheme.ui,
			editor: {
				syntax: {
					markdownHeading: "#abcdef",
				},
			},
		};

		const parsed = themeSchema.parse(input);
		expect(parsed.editor?.syntax?.markdownHeading).toBe("#abcdef");
	});

	it("round-trips a full theme state with editor overrides via themeStateSchema", () => {
		const customTheme = {
			id: "round-trip",
			name: "Round Trip",
			type: "dark" as const,
			ui: darkTheme.ui,
			editor: {
				colors: { background: "#000000" },
				syntax: { keyword: "#ffffff" },
			},
			isCustom: true,
		};

		const parsed = themeStateSchema.parse({
			activeThemeId: "round-trip",
			customThemes: [customTheme],
		});

		expect(parsed.customThemes[0]?.editor?.colors?.background).toBe("#000000");
		expect(parsed.customThemes[0]?.editor?.syntax?.keyword).toBe("#ffffff");
	});
});
