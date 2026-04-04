export function detectLanguage(filePath: string): string {
	const normalizedPath = filePath.toLowerCase().replaceAll("\\", "/");
	const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
	const ext = normalizedPath.split(".").pop()?.toLowerCase();

	if (
		fileName === "dockerfile" ||
		fileName === "containerfile" ||
		normalizedPath.endsWith(".dockerfile")
	) {
		return "dockerfile";
	}

	if (fileName === ".env" || fileName.startsWith(".env.")) {
		return "dotenv";
	}

	const languageMap: Record<string, string> = {
		// JavaScript/TypeScript
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",

		// Web
		html: "html",
		htm: "html",
		astro: "html",
		css: "css",
		scss: "scss",
		less: "less",

		// Data formats
		json: "json",
		jsonc: "json",
		yaml: "yaml",
		yml: "yaml",
		xml: "xml",
		toml: "toml",
		csv: "csv",
		tsv: "tsv",

		// Markdown/Documentation
		md: "markdown",
		mdx: "markdown",

		// Shell
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		fish: "shell",

		// Config
		dockerfile: "dockerfile",
		makefile: "makefile",

		// Other languages
		py: "python",
		pyi: "python",
		dart: "dart",
		rb: "ruby",
		go: "go",
		rs: "rust",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		cpp: "cpp",
		h: "c",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sql: "sql",
		graphql: "graphql",
		gql: "graphql",
		graphqls: "graphql",
	};

	return languageMap[ext || ""] || "plaintext";
}
