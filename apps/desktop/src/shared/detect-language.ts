import { detectEditorLanguage } from "./language-registry";

export function detectLanguage(filePath: string): string {
	return detectEditorLanguage(filePath);
}
