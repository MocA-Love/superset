import { describe, expect, test } from "bun:test";
import {
	resolveActiveEditorLanguageId,
	resolveFileLanguage,
	resolveFileLanguageServiceLanguageId,
	resolveReferenceGraphLanguageId,
	resolveShikiLanguageFromFilePath,
} from "./language-registry";

describe("language-registry", () => {
	test("maps TypeScript module variants consistently", () => {
		expect(resolveFileLanguage("file.ts")).toMatchObject({
			editorLanguage: "typescript",
			languageServiceLanguageId: "typescript",
			activeEditorLanguageId: "typescript",
			shikiLanguage: "typescript",
		});
		expect(resolveFileLanguage("file.mts")).toMatchObject({
			editorLanguage: "typescript",
			languageServiceLanguageId: "typescript",
			activeEditorLanguageId: "typescript",
			shikiLanguage: "typescript",
		});
		expect(resolveFileLanguage("file.d.mts")).toMatchObject({
			editorLanguage: "typescript",
			languageServiceLanguageId: "typescript",
			activeEditorLanguageId: "typescript",
			shikiLanguage: "typescript",
		});
		expect(resolveFileLanguage("file.cts")).toMatchObject({
			editorLanguage: "typescript",
			languageServiceLanguageId: "typescript",
			activeEditorLanguageId: "typescript",
			shikiLanguage: "typescript",
		});
	});

	test("keeps TSX and JSX provider ids separate from editor highlighting ids", () => {
		expect(resolveFileLanguage("component.tsx")).toMatchObject({
			editorLanguage: "typescript",
			languageServiceLanguageId: "typescriptreact",
			activeEditorLanguageId: "typescriptreact",
			referenceGraphLanguageId: "typescriptreact",
			shikiLanguage: "tsx",
		});
		expect(resolveFileLanguage("component.jsx")).toMatchObject({
			editorLanguage: "javascript",
			languageServiceLanguageId: "javascriptreact",
			activeEditorLanguageId: "javascriptreact",
			referenceGraphLanguageId: "javascriptreact",
			shikiLanguage: "jsx",
		});
	});

	test("handles special file names before generic suffixes", () => {
		expect(resolveFileLanguage(".env.production")).toMatchObject({
			editorLanguage: "dotenv",
			activeEditorLanguageId: "dotenv",
			shikiLanguage: null,
		});
		expect(resolveFileLanguage("Dockerfile")).toMatchObject({
			editorLanguage: "dockerfile",
			languageServiceLanguageId: "dockerfile",
			activeEditorLanguageId: "dockerfile",
		});
		expect(resolveFileLanguage("tsconfig.app.json")).toMatchObject({
			editorLanguage: "json",
			languageServiceLanguageId: "jsonc",
			activeEditorLanguageId: "jsonc",
			shikiLanguage: "jsonc",
		});
	});

	test("exposes focused accessors", () => {
		expect(resolveFileLanguageServiceLanguageId("file.d.cts")).toBe(
			"typescript",
		);
		expect(resolveActiveEditorLanguageId("script.sh")).toBe("shellscript");
		expect(resolveReferenceGraphLanguageId("component.tsx")).toBe(
			"typescriptreact",
		);
		expect(resolveShikiLanguageFromFilePath("component.tsx")).toBe("tsx");
	});
});
