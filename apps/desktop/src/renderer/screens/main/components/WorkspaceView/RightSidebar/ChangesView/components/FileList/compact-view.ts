import type { ChangedFile } from "shared/changes-types";

export function getFileName(path: string): string {
	return path.split("/").pop() || path;
}

export function getDirectoryLabel(path: string): string | undefined {
	const parts = path.split("/");
	if (parts.length <= 1) {
		return undefined;
	}

	return parts.slice(0, -1).join("/");
}

export function sortFilesForCompactView(files: ChangedFile[]): ChangedFile[] {
	return [...files].sort((left, right) => {
		const fileNameDelta = getFileName(left.path).localeCompare(
			getFileName(right.path),
		);
		if (fileNameDelta !== 0) {
			return fileNameDelta;
		}

		return left.path.localeCompare(right.path);
	});
}
