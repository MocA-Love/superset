export const INTERNAL_FILE_PATH_MIME = "application/x-superset-file-path";

export function getInternalDraggedFilePath(
	dataTransfer: DataTransfer,
): string | null {
	if (!Array.from(dataTransfer.types).includes(INTERNAL_FILE_PATH_MIME)) {
		return null;
	}

	return dataTransfer.getData(INTERNAL_FILE_PATH_MIME) || null;
}
