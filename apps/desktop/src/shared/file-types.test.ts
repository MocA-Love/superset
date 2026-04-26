import { describe, expect, test } from "bun:test";
import {
	getAudioMimeType,
	getImageExtensionFromMimeType,
	getImageMimeType,
	getVideoMimeType,
	hasRenderedPreview,
	isAudioFile,
	isHtmlFile,
	isImageFile,
	isMarkdownFile,
	isSpreadsheetFile,
	isVideoFile,
	parseBase64DataUrl,
} from "./file-types";

const PNG_BASE64 = Buffer.from("png").toString("base64");

describe("file-types", () => {
	test("maps image file paths to MIME types", () => {
		expect(getImageMimeType("logo.svg")).toBe("image/svg+xml");
		expect(getImageMimeType("logo.ico")).toBe("image/x-icon");
		expect(getImageMimeType("logo.unknown")).toBeNull();
	});

	test("maps image MIME types to preferred extensions", () => {
		expect(getImageExtensionFromMimeType("image/jpeg")).toBe("jpg");
		expect(getImageExtensionFromMimeType("image/vnd.microsoft.icon")).toBe(
			"ico",
		);
		expect(getImageExtensionFromMimeType("image/webp")).toBe("webp");
		expect(getImageExtensionFromMimeType("image/avif")).toBeNull();
	});

	test("detects every rendered preview file family", () => {
		expect(isMarkdownFile("README.MDX")).toBe(true);
		expect(isImageFile("diagram.WEBP")).toBe(true);
		expect(isHtmlFile("report.htm")).toBe(true);
		expect(isAudioFile("voice.OPUS")).toBe(true);
		expect(isVideoFile("screen-recording.webm")).toBe(true);

		expect(hasRenderedPreview("README.md")).toBe(true);
		expect(hasRenderedPreview("diagram.svg")).toBe(true);
		expect(hasRenderedPreview("index.html")).toBe(true);
		expect(hasRenderedPreview("voice.m4a")).toBe(true);
		expect(hasRenderedPreview("movie.mp4")).toBe(true);
		expect(hasRenderedPreview("archive.zip")).toBe(false);
	});

	test("detects spreadsheet files without treating them as rendered previews", () => {
		expect(isSpreadsheetFile("budget.xlsx")).toBe(true);
		expect(isSpreadsheetFile("legacy.XLS")).toBe(true);
		expect(isSpreadsheetFile("sheet.ods")).toBe(true);
		expect(hasRenderedPreview("budget.xlsx")).toBe(false);
	});

	test("maps audio and video file paths to MIME types", () => {
		expect(getAudioMimeType("voice.mp3")).toBe("audio/mpeg");
		expect(getAudioMimeType("voice.weba")).toBe("audio/webm");
		expect(getAudioMimeType("voice.txt")).toBeNull();
		expect(getVideoMimeType("clip.mov")).toBe("video/quicktime");
		expect(getVideoMimeType("clip.m4v")).toBe("video/mp4");
		expect(getVideoMimeType("clip.txt")).toBeNull();
	});

	test("parses base64 data URLs with extra MIME parameters", () => {
		expect(
			parseBase64DataUrl(
				`data:image/svg+xml;charset=utf-8;base64,${PNG_BASE64}`,
			),
		).toEqual({
			base64Data: PNG_BASE64,
			mimeType: "image/svg+xml",
		});
	});

	test("rejects malformed base64 data URLs", () => {
		expect(() => parseBase64DataUrl("not-a-data-url")).toThrow(
			"Invalid data URL format",
		);
	});
});
