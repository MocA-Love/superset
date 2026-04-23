import { describe, expect, it } from "bun:test";
import { parseQuickOpenQuery } from "./parseQuickOpenQuery";

describe("parseQuickOpenQuery", () => {
	it("returns the query as-is when no line suffix", () => {
		expect(parseQuickOpenQuery("foo.ts")).toEqual({
			searchQuery: "foo.ts",
		});
	});

	it("returns the query as-is for empty string", () => {
		expect(parseQuickOpenQuery("")).toEqual({
			searchQuery: "",
		});
	});

	it("parses file:line", () => {
		expect(parseQuickOpenQuery("foo.ts:123")).toEqual({
			searchQuery: "foo.ts",
			line: 123,
		});
	});

	it("parses file:line:column", () => {
		expect(parseQuickOpenQuery("foo.ts:123:45")).toEqual({
			searchQuery: "foo.ts",
			line: 123,
			column: 45,
		});
	});

	it("parses path with directories and line", () => {
		expect(parseQuickOpenQuery("src/components/App.tsx:42")).toEqual({
			searchQuery: "src/components/App.tsx",
			line: 42,
		});
	});

	it("returns query as-is when line is zero", () => {
		expect(parseQuickOpenQuery("foo.ts:0")).toEqual({
			searchQuery: "foo.ts:0",
		});
	});

	it("returns query as-is when line is negative", () => {
		expect(parseQuickOpenQuery("foo.ts:-5")).toEqual({
			searchQuery: "foo.ts:-5",
		});
	});

	it("returns query as-is for non-numeric suffix", () => {
		expect(parseQuickOpenQuery("foo.ts:abc")).toEqual({
			searchQuery: "foo.ts:abc",
		});
	});

	it("returns query as-is when path part is empty", () => {
		expect(parseQuickOpenQuery(":123")).toEqual({
			searchQuery: ":123",
		});
	});

	it("trims whitespace", () => {
		expect(parseQuickOpenQuery("  foo.ts:10  ")).toEqual({
			searchQuery: "foo.ts",
			line: 10,
		});
	});

	it("returns query as-is for column zero", () => {
		expect(parseQuickOpenQuery("foo.ts:10:0")).toEqual({
			searchQuery: "foo.ts:10:0",
		});
	});

	it("handles Windows-style paths", () => {
		expect(parseQuickOpenQuery("src\\utils\\helpers.ts:99")).toEqual({
			searchQuery: "src\\utils\\helpers.ts",
			line: 99,
		});
	});
});
