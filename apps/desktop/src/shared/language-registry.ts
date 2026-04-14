type FileLanguageRule = {
	editorLanguage: string;
	languageServiceLanguageId: string | null;
	activeEditorLanguageId: string | null;
	referenceGraphLanguageId?: string | null;
	shikiLanguage: string | null;
	fileNames?: string[];
	fileNamePrefixes?: string[];
	fileNamePatterns?: RegExp[];
	suffixes?: string[];
};

export interface ResolvedFileLanguage {
	editorLanguage: string;
	languageServiceLanguageId: string | null;
	activeEditorLanguageId: string | null;
	referenceGraphLanguageId: string;
	shikiLanguage: string | null;
}

const DEFAULT_FILE_LANGUAGE: ResolvedFileLanguage = {
	editorLanguage: "plaintext",
	languageServiceLanguageId: null,
	activeEditorLanguageId: null,
	referenceGraphLanguageId: "plaintext",
	shikiLanguage: null,
};

const FILE_LANGUAGE_RULES: FileLanguageRule[] = [
	{
		editorLanguage: "dockerfile",
		languageServiceLanguageId: "dockerfile",
		activeEditorLanguageId: "dockerfile",
		shikiLanguage: "dockerfile",
		fileNames: ["dockerfile", "containerfile"],
		suffixes: [".dockerfile"],
	},
	{
		editorLanguage: "dotenv",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "dotenv",
		shikiLanguage: null,
		fileNames: [".env"],
		fileNamePrefixes: [".env."],
	},
	{
		editorLanguage: "typescript",
		languageServiceLanguageId: "typescriptreact",
		activeEditorLanguageId: "typescriptreact",
		referenceGraphLanguageId: "typescriptreact",
		shikiLanguage: "tsx",
		suffixes: [".tsx"],
	},
	{
		editorLanguage: "typescript",
		languageServiceLanguageId: "typescript",
		activeEditorLanguageId: "typescript",
		shikiLanguage: "typescript",
		suffixes: [".ts", ".mts", ".cts"],
	},
	{
		editorLanguage: "javascript",
		languageServiceLanguageId: "javascriptreact",
		activeEditorLanguageId: "javascriptreact",
		referenceGraphLanguageId: "javascriptreact",
		shikiLanguage: "jsx",
		suffixes: [".jsx"],
	},
	{
		editorLanguage: "javascript",
		languageServiceLanguageId: "javascript",
		activeEditorLanguageId: "javascript",
		shikiLanguage: "javascript",
		suffixes: [".js", ".mjs", ".cjs"],
	},
	{
		editorLanguage: "json",
		languageServiceLanguageId: "jsonc",
		activeEditorLanguageId: "jsonc",
		shikiLanguage: "jsonc",
		suffixes: [".jsonc"],
		fileNames: [
			"jsconfig.json",
			"settings.json",
			"extensions.json",
			"launch.json",
			"tasks.json",
			"keybindings.json",
			"tsconfig.json",
		],
		fileNamePatterns: [/^tsconfig\..+\.json$/],
	},
	{
		editorLanguage: "json",
		languageServiceLanguageId: "json",
		activeEditorLanguageId: "json",
		shikiLanguage: "json",
		suffixes: [".json"],
	},
	{
		editorLanguage: "html",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "astro",
		shikiLanguage: "astro",
		suffixes: [".astro"],
	},
	{
		editorLanguage: "html",
		languageServiceLanguageId: "html",
		activeEditorLanguageId: "html",
		shikiLanguage: "html",
		suffixes: [".html", ".htm"],
	},
	{
		editorLanguage: "css",
		languageServiceLanguageId: "css",
		activeEditorLanguageId: "css",
		shikiLanguage: "css",
		suffixes: [".css"],
	},
	{
		editorLanguage: "scss",
		languageServiceLanguageId: "scss",
		activeEditorLanguageId: "scss",
		shikiLanguage: "scss",
		suffixes: [".scss"],
	},
	{
		editorLanguage: "less",
		languageServiceLanguageId: "less",
		activeEditorLanguageId: "less",
		shikiLanguage: "less",
		suffixes: [".less"],
	},
	{
		editorLanguage: "markdown",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "markdown",
		shikiLanguage: "markdown",
		suffixes: [".md", ".mdx"],
	},
	{
		editorLanguage: "yaml",
		languageServiceLanguageId: "yaml",
		activeEditorLanguageId: "yaml",
		shikiLanguage: "yaml",
		suffixes: [".yaml", ".yml"],
	},
	{
		editorLanguage: "xml",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "xml",
		shikiLanguage: "xml",
		suffixes: [".xml"],
	},
	{
		editorLanguage: "toml",
		languageServiceLanguageId: "toml",
		activeEditorLanguageId: "toml",
		shikiLanguage: "toml",
		suffixes: [".toml"],
	},
	{
		editorLanguage: "csv",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "csv",
		shikiLanguage: "csv",
		suffixes: [".csv"],
	},
	{
		editorLanguage: "tsv",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "tsv",
		shikiLanguage: "tsv",
		suffixes: [".tsv"],
	},
	{
		editorLanguage: "shell",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "shellscript",
		referenceGraphLanguageId: "shellscript",
		shikiLanguage: "shellscript",
		suffixes: [".sh", ".bash", ".zsh", ".fish"],
	},
	{
		editorLanguage: "makefile",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "makefile",
		shikiLanguage: "make",
		fileNames: ["makefile"],
	},
	{
		editorLanguage: "python",
		languageServiceLanguageId: "python",
		activeEditorLanguageId: "python",
		shikiLanguage: "python",
		suffixes: [".py", ".pyi"],
	},
	{
		editorLanguage: "dart",
		languageServiceLanguageId: "dart",
		activeEditorLanguageId: "dart",
		shikiLanguage: "dart",
		suffixes: [".dart"],
	},
	{
		editorLanguage: "ruby",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "ruby",
		shikiLanguage: "ruby",
		suffixes: [".rb"],
	},
	{
		editorLanguage: "go",
		languageServiceLanguageId: "go",
		activeEditorLanguageId: "go",
		shikiLanguage: "go",
		suffixes: [".go"],
	},
	{
		editorLanguage: "rust",
		languageServiceLanguageId: "rust",
		activeEditorLanguageId: "rust",
		shikiLanguage: "rust",
		suffixes: [".rs"],
	},
	{
		editorLanguage: "java",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "java",
		shikiLanguage: "java",
		suffixes: [".java"],
	},
	{
		editorLanguage: "kotlin",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "kotlin",
		shikiLanguage: "kotlin",
		suffixes: [".kt"],
	},
	{
		editorLanguage: "swift",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "swift",
		shikiLanguage: "swift",
		suffixes: [".swift"],
	},
	{
		editorLanguage: "c",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "c",
		shikiLanguage: "c",
		suffixes: [".c", ".h"],
	},
	{
		editorLanguage: "cpp",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "cpp",
		shikiLanguage: "cpp",
		suffixes: [".cpp", ".hpp"],
	},
	{
		editorLanguage: "csharp",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "csharp",
		shikiLanguage: "csharp",
		suffixes: [".cs"],
	},
	{
		editorLanguage: "php",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "php",
		shikiLanguage: "php",
		suffixes: [".php"],
	},
	{
		editorLanguage: "sql",
		languageServiceLanguageId: null,
		activeEditorLanguageId: "sql",
		shikiLanguage: "sql",
		suffixes: [".sql"],
	},
	{
		editorLanguage: "graphql",
		languageServiceLanguageId: "graphql",
		activeEditorLanguageId: "graphql",
		shikiLanguage: "graphql",
		suffixes: [".graphql", ".gql", ".graphqls"],
	},
];

function normalizePath(filePath: string) {
	return filePath.toLowerCase().replaceAll("\\", "/");
}

function matchesRule(
	rule: FileLanguageRule,
	normalizedPath: string,
	fileName: string,
) {
	if (rule.fileNames?.includes(fileName)) {
		return true;
	}

	if (rule.fileNamePrefixes?.some((prefix) => fileName.startsWith(prefix))) {
		return true;
	}

	if (rule.fileNamePatterns?.some((pattern) => pattern.test(fileName))) {
		return true;
	}

	if (rule.suffixes?.some((suffix) => normalizedPath.endsWith(suffix))) {
		return true;
	}

	return false;
}

export function resolveFileLanguage(filePath: string): ResolvedFileLanguage {
	const normalizedPath = normalizePath(filePath);
	const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;

	const rule = FILE_LANGUAGE_RULES.find((candidate) =>
		matchesRule(candidate, normalizedPath, fileName),
	);

	if (!rule) {
		return DEFAULT_FILE_LANGUAGE;
	}

	return {
		editorLanguage: rule.editorLanguage,
		languageServiceLanguageId: rule.languageServiceLanguageId,
		activeEditorLanguageId: rule.activeEditorLanguageId,
		referenceGraphLanguageId:
			rule.referenceGraphLanguageId ??
			rule.languageServiceLanguageId ??
			rule.editorLanguage,
		shikiLanguage: rule.shikiLanguage,
	};
}

export function detectEditorLanguage(filePath: string): string {
	return resolveFileLanguage(filePath).editorLanguage;
}

export function resolveFileLanguageServiceLanguageId(
	filePath: string,
): string | null {
	return resolveFileLanguage(filePath).languageServiceLanguageId;
}

export function resolveActiveEditorLanguageId(filePath: string): string | null {
	return resolveFileLanguage(filePath).activeEditorLanguageId;
}

export function resolveReferenceGraphLanguageId(filePath: string): string {
	return resolveFileLanguage(filePath).referenceGraphLanguageId;
}

export function resolveShikiLanguageFromFilePath(
	filePath: string,
): string | null {
	return resolveFileLanguage(filePath).shikiLanguage;
}
