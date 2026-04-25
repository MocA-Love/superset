import { describe, expect, it } from "bun:test";
import { extractAttachmentRefs, stripAttachmentRefs } from "./attachmentRefs";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("attachmentRefs", () => {
	it("extracts POSIX and Windows TODO Agent attachment references in order", () => {
		const posixPath = `/Users/me/.superset/todo-agent/attachments/${UUID}-report.png`;
		const windowsPath =
			"C:\\Users\\me\\.superset\\todo-agent\\attachments\\plain.txt";
		const text = [
			`Please inspect ![report](${posixPath}) first.`,
			`Then compare ![raw](${windowsPath}).`,
			`Duplicate should be collapsed ![again](${posixPath}).`,
		].join("\n");

		expect(extractAttachmentRefs(text)).toEqual([
			{
				fullMatch: `![report](${posixPath})`,
				alt: "report",
				path: posixPath,
				name: "report.png",
			},
			{
				fullMatch: `![raw](${windowsPath})`,
				alt: "raw",
				path: windowsPath,
				name: "plain.txt",
			},
		]);
	});

	it("ignores unrelated image references and unsafe attachment-like paths", () => {
		const text = [
			"![remote](https://example.com/todo-agent/attachments/a.png)",
			"![space](/Users/me/.superset/todo-agent/attachments/file name.png)",
			"![other](/Users/me/.superset/not-todo-agent/attachments/file.png)",
		].join("\n");

		expect(extractAttachmentRefs(text)).toEqual([]);
	});

	it("strips attachment markdown while preserving surrounding body text", () => {
		const attachmentPath = `/tmp/superset/todo-agent/attachments/${UUID}-screen.png`;
		const text = [
			"Before",
			"",
			`![screen](${attachmentPath})`,
			"",
			"",
			"After",
		].join("\n");

		expect(stripAttachmentRefs(text)).toBe("Before\n\nAfter");
	});
});
