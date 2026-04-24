import { describe, expect, it } from "bun:test";
import {
	compileGlobMatchers,
	compileGlobPatterns,
	directoryMayContainMatches,
	expandBracePatterns,
	globToRegExp,
	matchesAnyGlob,
	normalizeGlobPath,
} from "./glob-utils";

describe("normalizeGlobPath", () => {
	it("leaves forward slashes unchanged", () => {
		expect(normalizeGlobPath("src/deep/file.ts")).toBe("src/deep/file.ts");
	});

	it("normalizes platform separator to forward slashes", () => {
		const sep = process.platform === "win32" ? "\\" : "/";
		const input = `src${sep}deep${sep}file.ts`;
		expect(normalizeGlobPath(input)).toBe("src/deep/file.ts");
	});
});

describe("globToRegExp", () => {
	it("matches literal paths", () => {
		const re = globToRegExp("src/index.ts");
		expect(re.test("src/index.ts")).toBe(true);
		expect(re.test("src/other.ts")).toBe(false);
	});

	it("matches single * (non-separator)", () => {
		const re = globToRegExp("*.ts");
		expect(re.test("foo.ts")).toBe(true);
		expect(re.test("bar.ts")).toBe(true);
		expect(re.test("dir/foo.ts")).toBe(false);
	});

	it("matches **/*.ts recursively", () => {
		const re = globToRegExp("**/*.ts");
		expect(re.test("foo.ts")).toBe(true);
		expect(re.test("src/foo.ts")).toBe(true);
		expect(re.test("src/deep/foo.ts")).toBe(true);
		expect(re.test("foo.js")).toBe(false);
	});

	it("matches **/ prefix", () => {
		const re = globToRegExp("**/node_modules");
		expect(re.test("node_modules")).toBe(true);
		expect(re.test("packages/foo/node_modules")).toBe(true);
	});

	it("matches ? as single non-separator", () => {
		const re = globToRegExp("file?.ts");
		expect(re.test("file1.ts")).toBe(true);
		expect(re.test("fileA.ts")).toBe(true);
		expect(re.test("file.ts")).toBe(false);
		expect(re.test("file12.ts")).toBe(false);
	});

	it("matches character class [...]", () => {
		const re = globToRegExp("file[0-9].ts");
		expect(re.test("file0.ts")).toBe(true);
		expect(re.test("file9.ts")).toBe(true);
		expect(re.test("filea.ts")).toBe(false);
	});

	it("escapes special regex chars", () => {
		const re = globToRegExp("file.name.ts");
		expect(re.test("file.name.ts")).toBe(true);
		expect(re.test("fileXname.ts")).toBe(false);
	});

	it("handles unclosed [ as literal", () => {
		const re = globToRegExp("file[.ts");
		expect(re.test("file[.ts")).toBe(true);
	});
});

describe("expandBracePatterns", () => {
	it("expands simple braces", () => {
		expect(expandBracePatterns("{a,b,c}")).toEqual(["a", "b", "c"]);
	});

	it("expands braces with prefix and suffix", () => {
		expect(expandBracePatterns("src/*.{ts,js}")).toEqual([
			"src/*.ts",
			"src/*.js",
		]);
	});

	it("handles nested braces", () => {
		expect(expandBracePatterns("{a,{b,c}}")).toEqual(["a", "b", "c"]);
	});

	it("returns pattern unchanged if no braces", () => {
		expect(expandBracePatterns("**/*.ts")).toEqual(["**/*.ts"]);
	});

	it("handles escaped braces", () => {
		expect(expandBracePatterns("\\{a,b}")).toEqual(["\\{a,b}"]);
	});
});

describe("compileGlobPatterns", () => {
	it("returns empty for null/undefined/empty", () => {
		expect(compileGlobPatterns(null)).toEqual([]);
		expect(compileGlobPatterns(undefined)).toEqual([]);
		expect(compileGlobPatterns("")).toEqual([]);
		expect(compileGlobPatterns("  ")).toEqual([]);
	});

	it("returns single pattern for simple glob", () => {
		expect(compileGlobPatterns("**/*.ts")).toEqual(["**/*.ts"]);
	});

	it("expands brace patterns", () => {
		expect(compileGlobPatterns("{**/*.ts,**/*.js}")).toEqual([
			"**/*.ts",
			"**/*.js",
		]);
	});
});

describe("matchesAnyGlob", () => {
	it("returns false for empty matchers", () => {
		expect(matchesAnyGlob([], "foo.ts")).toBe(false);
	});

	it("matches with compiled matchers", () => {
		const matchers = compileGlobMatchers("**/*.ts");
		expect(matchesAnyGlob(matchers, "src/foo.ts")).toBe(true);
		expect(matchesAnyGlob(matchers, "src/foo.js")).toBe(false);
	});

	it("matches default exclude globs", () => {
		const matchers = compileGlobMatchers("{**/.git,**/node_modules}");
		expect(matchesAnyGlob(matchers, "node_modules")).toBe(true);
		expect(matchesAnyGlob(matchers, "packages/foo/node_modules")).toBe(true);
		expect(matchesAnyGlob(matchers, ".git")).toBe(true);
		expect(matchesAnyGlob(matchers, "src/index.ts")).toBe(false);
	});
});

describe("directoryMayContainMatches", () => {
	it("returns true for empty patterns", () => {
		expect(directoryMayContainMatches("src", [])).toBe(true);
	});

	it("returns true when directory matches static prefix", () => {
		expect(directoryMayContainMatches("src", ["src/**/*.ts"])).toBe(true);
		expect(directoryMayContainMatches("src/deep", ["src/**/*.ts"])).toBe(true);
	});

	it("returns false when directory diverges from prefix", () => {
		expect(directoryMayContainMatches("dist", ["src/**/*.ts"])).toBe(false);
	});

	it("returns true for patterns without static prefix", () => {
		expect(directoryMayContainMatches("anything", ["**/*.ts"])).toBe(true);
	});
});
