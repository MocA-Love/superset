import { describe, expect, it } from "bun:test";
import { isSafeUrl, sanitizeUrl } from "./safeUrl";

describe("isSafeUrl", () => {
	it("allows null/undefined/empty (no href present)", () => {
		expect(isSafeUrl(null)).toBe(true);
		expect(isSafeUrl(undefined)).toBe(true);
		expect(isSafeUrl("")).toBe(true);
	});

	it("allows http(s) urls", () => {
		expect(isSafeUrl("https://example.com")).toBe(true);
		expect(isSafeUrl("http://example.com")).toBe(true);
	});

	it("allows mailto, ftp, tel, data:image", () => {
		expect(isSafeUrl("mailto:user@example.com")).toBe(true);
		expect(isSafeUrl("ftp://example.com")).toBe(true);
		expect(isSafeUrl("tel:+15551234567")).toBe(true);
		expect(isSafeUrl("data:image/png;base64,AAAA")).toBe(true);
	});

	it("allows relative urls and fragments", () => {
		expect(isSafeUrl("/path/to/file")).toBe(true);
		expect(isSafeUrl("./relative")).toBe(true);
		expect(isSafeUrl("#anchor")).toBe(true);
		expect(isSafeUrl("?query=1")).toBe(true);
		expect(isSafeUrl("file.html")).toBe(true);
	});

	it("blocks javascript: scheme (case-insensitive, with whitespace)", () => {
		expect(isSafeUrl("javascript:alert(1)")).toBe(false);
		expect(isSafeUrl("JavaScript:alert(1)")).toBe(false);
		expect(isSafeUrl("  javascript:alert(1)")).toBe(false);
		expect(isSafeUrl("\tjavascript:alert(1)")).toBe(false);
	});

	it("blocks vbscript: scheme", () => {
		expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
		expect(isSafeUrl("VBScript:msgbox(1)")).toBe(false);
	});

	it("blocks data:text/html (HTML smuggled in data URI)", () => {
		expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
		expect(isSafeUrl("Data:Text/Html,<script>")).toBe(false);
	});
});

describe("sanitizeUrl", () => {
	it("returns the url when safe", () => {
		expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
		expect(sanitizeUrl("/relative")).toBe("/relative");
	});

	it("returns null when unsafe", () => {
		expect(sanitizeUrl("javascript:alert(1)")).toBe(null);
		expect(sanitizeUrl("vbscript:x")).toBe(null);
		expect(sanitizeUrl("data:text/html,evil")).toBe(null);
	});

	it("returns null for null input, preserves empty string for empty input", () => {
		expect(sanitizeUrl(null)).toBe(null);
		expect(sanitizeUrl(undefined)).toBe(null);
		// Empty string is technically "safe" but downstream renderHTML drops it.
		expect(sanitizeUrl("")).toBe("");
	});
});
