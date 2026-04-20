import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import type { RunRipgrepStream, SearchPatchEvent } from "./search";
import {
	invalidateAllSearchIndexes,
	patchSearchIndexesForRoot,
	replaceContent,
	searchContent,
	searchContentStream,
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
	// On macOS, os.tmpdir() resolves to `/var/folders/...` which is itself a
	// symlink to `/private/var/folders/...`. workspace-fs' write path calls
	// fs.realpath() and enforces that the result lives under the workspace
	// root; without this realpath call the tempdir symlink would trip that
	// check every time.
	const raw = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-fs-search-"));
	const rootPath = await fs.realpath(raw);
	tempRoots.push(rootPath);
	return rootPath;
}

function createPatchEvent(event: SearchPatchEvent): SearchPatchEvent {
	return event;
}

// The test environment doesn't have `rg` on PATH (CI agents rarely do), so
// `defaultRunRipgrep` would throw ENOENT and the caller silently falls back
// to the synchronous scan path. That fallback can't exercise ripgrep-only
// features like `--multiline`, so tests that need those opt into the
// bundled @vscode/ripgrep binary explicitly.
const execFileAsync = promisify(execFile);
const bundledRunRipgrep = async (
	args: string[],
	options: { cwd: string; maxBuffer: number; signal?: AbortSignal },
): Promise<{ stdout: string }> => {
	const result = await execFileAsync(bundledRgPath, args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer,
		windowsHide: true,
		signal: options.signal,
	});
	return { stdout: result.stdout };
};

// Same idea as bundledRunRipgrep, but streams stdout so searchContentStream
// can exercise its incremental parse path.
const bundledSpawnRipgrep: RunRipgrepStream = async function* (args, options) {
	const { spawn } = await import("node:child_process");
	const child = spawn(bundledRgPath, args, {
		cwd: options.cwd,
		windowsHide: true,
	});
	const signal = options.signal;
	const onAbort = () => {
		if (!child.killed) child.kill("SIGTERM");
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		child.stdout.setEncoding("utf8");
		for await (const chunk of child.stdout as AsyncIterable<string>) {
			yield chunk;
		}
		await new Promise<void>((resolve, reject) => {
			child.once("close", (code) => {
				if (code === null || code === 0 || code === 1) resolve();
				else reject(new Error(`rg exit ${code}`));
			});
			child.once("error", reject);
		});
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!child.killed) child.kill("SIGTERM");
	}
};

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

	it("surfaces unexpected ripgrep failures instead of silently falling back", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(
			path.join(rootPath, "alpha.ts"),
			"export const alpha = 1;\n",
		);

		let threw = false;
		try {
			await searchFiles({
				rootPath,
				query: "alpha",
				runRipgrep: async () => {
					// Simulate the exact shape of an argv-parse error (rg exits 2
					// when it doesn't understand a flag). Pre-hardening, this
					// failure silently degraded to fast-glob.
					const error = new Error(
						"Command failed: rg: unexpected argument for option '--follow'",
					) as Error & { code?: number };
					error.code = 2;
					throw error;
				},
			});
		} catch {
			threw = true;
		}

		expect(threw).toEqual(true);
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

describe("searchContent", () => {
	it("respects .gitignore via ripgrep when includeHidden=false", async () => {
		const rootPath = await createTempRoot();
		// ripgrep only honors `.gitignore` inside a git repository (everywhere
		// else it looks for `.ignore`). Workspaces are always git worktrees in
		// production, so set one up here to mirror the real environment.
		await execFileAsync("git", ["init", "--quiet"], { cwd: rootPath });
		await fs.mkdir(path.join(rootPath, "dist"), { recursive: true });
		await fs.writeFile(path.join(rootPath, "src.ts"), "const TOKEN = 1;\n");
		await fs.writeFile(
			path.join(rootPath, "dist", "bundled.ts"),
			"const TOKEN = 2;\n",
		);
		await fs.writeFile(path.join(rootPath, ".gitignore"), "dist/\n");

		const results = await searchContent({
			rootPath,
			query: "TOKEN",
			includeHidden: false,
			runRipgrep: bundledRunRipgrep,
		});
		const paths = results.map((r) => r.relativePath);
		expect(paths).toContain("src.ts");
		expect(paths.includes("dist/bundled.ts")).toEqual(false);
	});

	it("reveals .gitignore'd files when includeHidden=true", async () => {
		const rootPath = await createTempRoot();
		await execFileAsync("git", ["init", "--quiet"], { cwd: rootPath });
		await fs.mkdir(path.join(rootPath, "dist"), { recursive: true });
		await fs.writeFile(
			path.join(rootPath, "dist", "bundled.ts"),
			"const TOKEN = 2;\n",
		);
		await fs.writeFile(path.join(rootPath, ".gitignore"), "dist/\n");

		const results = await searchContent({
			rootPath,
			query: "TOKEN",
			includeHidden: true,
			runRipgrep: bundledRunRipgrep,
		});
		expect(results.map((r) => r.relativePath)).toContain("dist/bundled.ts");
	});

	it("wholeWord=true does not match substrings", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(
			path.join(rootPath, "a.ts"),
			"const foo = 1;\nconst foobar = 2;\n",
		);

		const results = await searchContent({
			rootPath,
			query: "foo",
			wholeWord: true,
			runRipgrep: bundledRunRipgrep,
		});
		// Only the `foo` line should match; `foobar` must be filtered out.
		expect(results).toHaveLength(1);
		expect(results[0]?.line).toEqual(1);
	});

	it("multiline=true lets regex span newlines", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(
			path.join(rootPath, "a.ts"),
			"function foo() {\n  return 1;\n}\n",
		);

		const results = await searchContent({
			rootPath,
			query: "function foo\\(\\).*return",
			isRegex: true,
			multiline: true,
			runRipgrep: bundledRunRipgrep,
		});
		expect(results.length).toBeGreaterThan(0);
	});

	it("scoped cancellation does not cross-cancel Search tab and Quick Open", async () => {
		const rootPath = await createTempRoot();
		await fs.writeFile(path.join(rootPath, "a.ts"), "ALPHA\n");
		await fs.writeFile(path.join(rootPath, "b.ts"), "BETA\n");

		const [alpha, beta] = await Promise.all([
			searchContent({
				rootPath,
				query: "ALPHA",
				scopeId: "search-tab",
				runRipgrep: bundledRunRipgrep,
			}),
			searchContent({
				rootPath,
				query: "BETA",
				scopeId: "quick-open",
				runRipgrep: bundledRunRipgrep,
			}),
		]);

		expect(alpha[0]?.relativePath).toEqual("a.ts");
		expect(beta[0]?.relativePath).toEqual("b.ts");
	});
});

describe("replaceContent", () => {
	it("supports regex capture group replacements ($1)", async () => {
		const rootPath = await createTempRoot();
		const filePath = path.join(rootPath, "a.ts");
		await fs.writeFile(filePath, "const foo = 1;\nconst bar = 2;\n");

		const result = await replaceContent({
			rootPath,
			query: "(foo|bar)",
			replacement: "$1Name",
			isRegex: true,
		});
		expect(result.filesUpdated).toEqual(1);

		const updated = await fs.readFile(filePath, "utf8");
		expect(updated).toEqual("const fooName = 1;\nconst barName = 2;\n");
	});

	it("wholeWord replacement does not touch substring hits", async () => {
		const rootPath = await createTempRoot();
		const filePath = path.join(rootPath, "a.ts");
		await fs.writeFile(filePath, "foo + foobar\n");

		const result = await replaceContent({
			rootPath,
			query: "foo",
			replacement: "BAR",
			wholeWord: true,
		});
		expect(result.filesUpdated).toEqual(1);

		const updated = await fs.readFile(filePath, "utf8");
		expect(updated).toEqual("BAR + foobar\n");
	});
});

describe("searchContentStream", () => {
	it("yields each match incrementally as ripgrep produces them", async () => {
		const rootPath = await createTempRoot();
		// Spread matches across multiple files so ripgrep flushes between
		// them; this is the scenario where streaming actually pays off.
		for (let fileIndex = 0; fileIndex < 5; fileIndex++) {
			await fs.writeFile(
				path.join(rootPath, `file-${fileIndex}.ts`),
				"export const NEEDLE = 1;\n",
			);
		}

		const matches = [];
		for await (const match of searchContentStream({
			rootPath,
			query: "NEEDLE",
			spawnRipgrep: bundledSpawnRipgrep,
		})) {
			matches.push(match);
		}

		expect(matches.length).toEqual(5);
		for (const match of matches) {
			expect(match.relativePath.startsWith("file-")).toEqual(true);
			expect(match.line).toEqual(1);
			expect(match.preview.includes("NEEDLE")).toEqual(true);
		}
	});

	it("honors limit so runaway queries terminate", async () => {
		const rootPath = await createTempRoot();
		const lines: string[] = [];
		for (let i = 0; i < 50; i++) lines.push(`NEEDLE line ${i}`);
		await fs.writeFile(path.join(rootPath, "big.ts"), `${lines.join("\n")}\n`);

		const matches = [];
		for await (const match of searchContentStream({
			rootPath,
			query: "NEEDLE",
			limit: 2,
			spawnRipgrep: bundledSpawnRipgrep,
		})) {
			matches.push(match);
		}

		// ripgrep's --max-count caps per-file too, but limit should enforce the
		// tighter cap regardless of underlying behavior.
		expect(matches.length <= 2).toEqual(true);
	});

	it("cancels streaming when the external signal fires", async () => {
		const rootPath = await createTempRoot();
		for (let i = 0; i < 50; i++) {
			await fs.writeFile(
				path.join(rootPath, `file-${i}.ts`),
				"NEEDLE\n".repeat(100),
			);
		}

		const controller = new AbortController();
		const matches = [];
		const iter = searchContentStream({
			rootPath,
			query: "NEEDLE",
			signal: controller.signal,
			spawnRipgrep: bundledSpawnRipgrep,
		});

		let seen = 0;
		for await (const match of iter) {
			matches.push(match);
			seen += 1;
			if (seen === 1) {
				controller.abort();
			}
		}

		// After abort, the generator must stop yielding; we may or may not
		// have a trailing match that was already in the buffer, but it must
		// not stream the entire 5000-match corpus.
		expect(matches.length < 500).toEqual(true);
	});
});
