import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SearchPatchEvent } from "./search";
import {
	invalidateAllSearchIndexes,
	patchSearchIndexesForRoot,
	searchFiles,
	warmupSearchIndex,
} from "./search";

const tempRoots: string[] = [];

afterEach(async () => {
	invalidateAllSearchIndexes();
	await Promise.all(
		tempRoots.splice(0, tempRoots.length).map(async (rootPath) => {
			await fs.rm(rootPath, { recursive: true, force: true });
		}),
	);
});

async function createTempRoot(): Promise<string> {
	const rootPath = await fs.mkdtemp(
		path.join(os.tmpdir(), "workspace-fs-search-"),
	);
	tempRoots.push(rootPath);
	return rootPath;
}

function createPatchEvent(event: SearchPatchEvent): SearchPatchEvent {
	return event;
}

describe("patchSearchIndexesForRoot", () => {
	it("adds created files to an existing visible search index", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(
			path.join(rootPath, "alpha.ts"),
			"export const alpha = 1;\n",
		);

		await searchFiles({
			rootPath,
			query: "alpha",
		});

		const betaPath = path.join(rootPath, "beta.ts");
		await fs.writeFile(betaPath, "export const beta = 2;\n");

		patchSearchIndexesForRoot(rootPath, [
			createPatchEvent({
				kind: "create",
				absolutePath: betaPath,
				isDirectory: false,
			}),
		]);

		const results = await searchFiles({
			rootPath,
			query: "beta",
		});

		expect(results.map((result) => result.absolutePath)).toContain(betaPath);
	});

	it("removes deleted files from an existing visible search index", async () => {
		const rootPath = await createTempRoot();
		const alphaPath = path.join(rootPath, "alpha.ts");
		await fs.writeFile(alphaPath, "export const alpha = 1;\n");

		await searchFiles({
			rootPath,
			query: "alpha",
		});

		await fs.rm(alphaPath);

		patchSearchIndexesForRoot(rootPath, [
			createPatchEvent({
				kind: "delete",
				absolutePath: alphaPath,
				isDirectory: false,
			}),
		]);

		const results = await searchFiles({
			rootPath,
			query: "alpha",
		});

		expect(results).toHaveLength(0);
	});

	it("keeps hidden files out of visible indexes while updating hidden indexes", async () => {
		const rootPath = await createTempRoot();
		await searchFiles({
			rootPath,
			query: "bootstrap",
		});
		await searchFiles({
			rootPath,
			query: "bootstrap",
			includeHidden: true,
		});

		const hiddenPath = path.join(rootPath, ".env.local");
		await fs.writeFile(hiddenPath, "SECRET_TOKEN=1\n");

		patchSearchIndexesForRoot(rootPath, [
			createPatchEvent({
				kind: "create",
				absolutePath: hiddenPath,
				isDirectory: false,
			}),
		]);

		const visibleResults = await searchFiles({
			rootPath,
			query: ".env",
		});
		const hiddenResults = await searchFiles({
			rootPath,
			query: ".env",
			includeHidden: true,
		});

		expect(visibleResults).toHaveLength(0);
		expect(hiddenResults.map((result) => result.absolutePath)).toContain(
			hiddenPath,
		);
	});

	it("keeps gitignore-style build artifacts out of patch updates", async () => {
		const rootPath = await createTempRoot();
		const srcPath = path.join(rootPath, "src", "alpha.ts");
		const distPath = path.join(rootPath, "dist", "alpha.js");

		await fs.mkdir(path.dirname(srcPath), { recursive: true });
		await fs.writeFile(srcPath, "export const alpha = 1;\n");

		await searchFiles({
			rootPath,
			query: "alpha",
		});

		// Simulate a watcher event firing after a freshly-built artifact
		// appears. The file is under `dist/` which ripgrep would drop on a
		// full rebuild, so the incremental patch path must drop it too.
		await fs.mkdir(path.dirname(distPath), { recursive: true });
		await fs.writeFile(distPath, "export var alpha = 1;\n");

		patchSearchIndexesForRoot(rootPath, [
			createPatchEvent({
				kind: "create",
				absolutePath: distPath,
				isDirectory: false,
			}),
		]);

		const results = await searchFiles({
			rootPath,
			query: "alpha",
		});
		const paths = results.map((result) => result.absolutePath);
		expect(paths).toContain(srcPath);
		expect(paths.includes(distPath)).toEqual(false);
	});

	it("rebuilds search indexes after a directory rename", async () => {
		const rootPath = await createTempRoot();
		const oldDirectoryPath = path.join(rootPath, "old-dir");
		const newDirectoryPath = path.join(rootPath, "new-dir");
		const oldFilePath = path.join(oldDirectoryPath, "target.ts");
		const newFilePath = path.join(newDirectoryPath, "target.ts");

		await fs.mkdir(oldDirectoryPath, { recursive: true });
		await fs.writeFile(oldFilePath, "export const target = 1;\n");

		await searchFiles({
			rootPath,
			query: "old-dir/target.ts",
		});

		await fs.rename(oldDirectoryPath, newDirectoryPath);

		patchSearchIndexesForRoot(rootPath, [
			createPatchEvent({
				kind: "rename",
				absolutePath: newDirectoryPath,
				oldAbsolutePath: oldDirectoryPath,
				isDirectory: true,
			}),
		]);

		const oldPathResults = await searchFiles({
			rootPath,
			query: "old-dir/target.ts",
		});
		const newPathResults = await searchFiles({
			rootPath,
			query: "new-dir/target.ts",
		});

		expect(
			oldPathResults.some(
				(result) => result.relativePath === "old-dir/target.ts",
			),
		).toEqual(false);
		expect(newPathResults[0]?.absolutePath).toEqual(newFilePath);
		expect(newPathResults[0]?.relativePath).toEqual("new-dir/target.ts");
	});
});

describe("searchFiles", () => {
	it("prioritizes exact filename matches ahead of fuzzy path matches", async () => {
		const rootPath = await createTempRoot();
		const exactMatchPath = path.join(rootPath, "WorkspaceFiles.tsx");
		const fuzzyMatchPath = path.join(rootPath, "hooks", "useWorkspaceFiles.ts");

		await fs.mkdir(path.dirname(fuzzyMatchPath), { recursive: true });
		await fs.writeFile(exactMatchPath, "export const exact = true;\n");
		await fs.writeFile(fuzzyMatchPath, "export const fuzzy = true;\n");

		const results = await searchFiles({
			rootPath,
			query: "WorkspaceFiles.tsx",
			limit: 5,
		});

		expect(results[0]?.absolutePath).toEqual(exactMatchPath);
		expect(results).toHaveLength(1);

		const fuzzyResults = await searchFiles({
			rootPath,
			query: "useWorkspaceFiles",
			limit: 5,
		});

		expect(fuzzyResults[0]?.absolutePath).toEqual(fuzzyMatchPath);
	});

	it("normalizes exact relative path queries before lookup", async () => {
		const rootPath = await createTempRoot();
		const targetPath = path.join(rootPath, "src", "file.ts");

		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, "export const value = true;\n");

		const results = await searchFiles({
			rootPath,
			query: "./src/file.ts",
			limit: 5,
		});

		expect(results[0]?.absolutePath).toEqual(targetPath);
		expect(results[0]?.relativePath).toEqual("src/file.ts");
	});

	it("returns every compact path collision instead of dropping later entries", async () => {
		const rootPath = await createTempRoot();
		const nestedPath = path.join(rootPath, "foo", "bar.ts");
		const flatPath = path.join(rootPath, "foo-bar.ts");

		await fs.mkdir(path.dirname(nestedPath), { recursive: true });
		await fs.writeFile(nestedPath, "export const nested = true;\n");
		await fs.writeFile(flatPath, "export const flat = true;\n");

		const results = await searchFiles({
			rootPath,
			query: "foobarts",
			limit: 5,
		});

		expect(results.map((result) => result.absolutePath)).toEqual([
			flatPath,
			nestedPath,
		]);
	});

	it("boosts open files above otherwise-equivalent fuzzy matches", async () => {
		const rootPath = await createTempRoot();
		const firstPath = path.join(rootPath, "src", "alpha.ts");
		const secondPath = path.join(rootPath, "src", "beta.ts");

		await fs.mkdir(path.dirname(firstPath), { recursive: true });
		await fs.writeFile(firstPath, "export const alpha = 1;\n");
		await fs.writeFile(secondPath, "export const beta = 1;\n");

		const baselineBeta = await searchFiles({
			rootPath,
			query: "ts",
			limit: 5,
		});
		invalidateAllSearchIndexes();

		// "ts" matches both files with an identical fuzzy score, so ordering is
		// dictated entirely by the MRU/open tiebreakers.
		const withOpen = await searchFiles({
			rootPath,
			query: "ts",
			limit: 5,
			openFilePaths: [secondPath],
		});

		expect(withOpen[0]?.absolutePath).toEqual(secondPath);
		expect(withOpen[0]?.score ?? 0).toBeGreaterThan(
			baselineBeta[0]?.score ?? 0,
		);
	});

	it("prefers recently viewed files on equal fuzzy score", async () => {
		const rootPath = await createTempRoot();
		const oldPath = path.join(rootPath, "old.ts");
		const newPath = path.join(rootPath, "new.ts");

		await fs.writeFile(oldPath, "export const value = 1;\n");
		await fs.writeFile(newPath, "export const value = 2;\n");

		const results = await searchFiles({
			rootPath,
			query: "ts",
			limit: 5,
			// Most-recent-first ordering: newPath is freshest, oldPath is stale.
			recentFilePaths: [newPath, oldPath],
		});

		expect(results[0]?.absolutePath).toEqual(newPath);
		expect(results[1]?.absolutePath).toEqual(oldPath);
	});

	it("does not cancel concurrent searches on the same root with different scopeIds", async () => {
		const rootPath = await createTempRoot();
		const alphaPath = path.join(rootPath, "alpha.ts");
		const betaPath = path.join(rootPath, "beta.ts");

		await fs.writeFile(alphaPath, "export const alpha = 1;\n");
		await fs.writeFile(betaPath, "export const beta = 1;\n");

		// Simulate Cmd+P and the Files tab both querying the same workspace
		// at the same time. Prior to scopeId support, the second call would
		// abort the first and the first search would return [].
		const [quickOpen, filesTab] = await Promise.all([
			searchFiles({
				rootPath,
				query: "alpha",
				scopeId: "quick-open",
			}),
			searchFiles({
				rootPath,
				query: "beta",
				scopeId: "files-tab",
			}),
		]);

		expect(quickOpen[0]?.absolutePath).toEqual(alphaPath);
		expect(filesTab[0]?.absolutePath).toEqual(betaPath);
	});

	it("invokes ripgrep without the invalid --follow=false flag", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(
			path.join(rootPath, "alpha.ts"),
			"export const alpha = 1;\n",
		);

		const capturedArgs: string[][] = [];
		await searchFiles({
			rootPath,
			query: "alpha",
			runRipgrep: async (args) => {
				capturedArgs.push(args);
				return { stdout: "alpha.ts\0" };
			},
		});

		expect(capturedArgs).toHaveLength(1);
		const args = capturedArgs[0] ?? [];
		// `--follow=false` is not a valid ripgrep flag; passing it makes rg exit
		// with code 2 and our fallback hides the error. Guard against regressions.
		expect(args.some((arg) => arg.startsWith("--follow"))).toEqual(false);
		expect(args).toContain("--files");
		expect(args).toContain("--null");
	});

	it("warmupSearchIndex populates the cache without returning matches", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(
			path.join(rootPath, "alpha.ts"),
			"export const a = 1;\n",
		);

		await warmupSearchIndex({ rootPath });

		// If warmup landed in the cache, the subsequent searchFiles call never
		// needs to rebuild; this just asserts results are still correct.
		const results = await searchFiles({
			rootPath,
			query: "alpha",
			limit: 5,
		});
		expect(results[0]?.relativePath).toEqual("alpha.ts");
	});
});
