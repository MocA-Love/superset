export const INTERNAL_FILE_PATH_MIME = "application/x-superset-file-path";

export function hasInternalDraggedFilePath(
	dataTransfer: DataTransfer,
): boolean {
	return Array.from(dataTransfer.types).includes(INTERNAL_FILE_PATH_MIME);
}

export function getInternalDraggedFilePath(
	dataTransfer: DataTransfer,
): string | null {
	if (!hasInternalDraggedFilePath(dataTransfer)) {
		return null;
	}

	return dataTransfer.getData(INTERNAL_FILE_PATH_MIME) || null;
}
