type PackagedNodeModuleCopy = {
	filter: string[];
	from: string;
	to: string;
};

type ExternalizedRuntimeModule = {
	asarUnpackGlobs: string[];
	materialize: string[];
	packagedCopies: PackagedNodeModuleCopy[];
	specifier: string;
};

function copyWholeModule(moduleName: string): PackagedNodeModuleCopy {
	return {
		from: `node_modules/${moduleName}`,
		to: `node_modules/${moduleName}`,
		filter: ["**/*"],
	};
}

function copyModuleSubtree(
	moduleName: string,
	filter: string[],
): PackagedNodeModuleCopy {
	return {
		from: `node_modules/${moduleName}`,
		to: `node_modules/${moduleName}`,
		filter,
	};
}

const externalizedRuntimeModules: ExternalizedRuntimeModule[] = [
	{
		specifier: "better-sqlite3",
		materialize: ["better-sqlite3"],
		packagedCopies: [copyWholeModule("better-sqlite3")],
		asarUnpackGlobs: ["**/node_modules/better-sqlite3/**/*"],
	},
	{
		specifier: "node-pty",
		materialize: ["node-pty"],
		packagedCopies: [copyWholeModule("node-pty")],
		asarUnpackGlobs: ["**/node_modules/node-pty/**/*"],
	},
	{
		specifier: "@superset/macos-process-metrics",
		materialize: ["@superset/macos-process-metrics"],
		packagedCopies: [copyWholeModule("@superset/macos-process-metrics")],
		asarUnpackGlobs: ["**/node_modules/@superset/macos-process-metrics/**/*"],
	},
	{
		specifier: "@superset/macos-window-blur",
		materialize: ["@superset/macos-window-blur"],
		packagedCopies: [copyWholeModule("@superset/macos-window-blur")],
		asarUnpackGlobs: ["**/node_modules/@superset/macos-window-blur/**/*"],
	},
	{
		specifier: "@ast-grep/napi",
		materialize: ["@ast-grep/napi"],
		packagedCopies: [copyWholeModule("@ast-grep")],
		asarUnpackGlobs: ["**/node_modules/@ast-grep/napi*/**/*"],
	},
	{
		specifier: "@parcel/watcher",
		materialize: ["@parcel/watcher"],
		packagedCopies: [
			copyModuleSubtree("@parcel", ["watcher/**/*", "watcher-*/**/*"]),
		],
		asarUnpackGlobs: ["**/node_modules/@parcel/watcher*/**/*"],
	},
	{
		specifier: "libsql",
		materialize: ["libsql"],
		packagedCopies: [
			copyWholeModule("libsql"),
			copyWholeModule("@libsql"),
			copyWholeModule("@neon-rs"),
		],
		asarUnpackGlobs: ["**/node_modules/@libsql/**/*"],
	},
];

const packagedSupportModules = [
	copyWholeModule("bindings"),
	copyWholeModule("file-uri-to-path"),
	copyWholeModule("detect-libc"),
	copyWholeModule("is-glob"),
	copyWholeModule("is-extglob"),
	copyWholeModule("picomatch"),
	copyWholeModule("node-addon-api"),
	copyWholeModule("typescript"),
	copyWholeModule("yaml-language-server"),
	copyWholeModule("dockerfile-language-server-nodejs"),
	copyWholeModule("graphql-language-service-cli"),
	copyWholeModule("graphql"),
	copyWholeModule("pyright"),
	copyWholeModule("vscode-css-languageservice"),
	copyWholeModule("vscode-html-languageservice"),
	copyWholeModule("vscode-json-languageservice"),
	copyWholeModule("vscode-languageserver-textdocument"),
	copyWholeModule("vscode-langservers-extracted"),
];

export const mainExternalizedDependencies = [
	...externalizedRuntimeModules.map((module) => module.specifier),
	"pg-native",
];

export const packagedNodeModuleCopies = [
	...externalizedRuntimeModules.flatMap((module) => module.packagedCopies),
	...packagedSupportModules,
];

export const packagedAsarUnpackGlobs = [
	...externalizedRuntimeModules.flatMap((module) => module.asarUnpackGlobs),
	"**/node_modules/bindings/**/*",
	"**/node_modules/file-uri-to-path/**/*",
];

export const requiredMaterializedNodeModules = [
	...externalizedRuntimeModules.flatMap((module) => module.materialize),
	"bindings",
	"file-uri-to-path",
	"detect-libc",
	"is-glob",
	"is-extglob",
	"picomatch",
	"node-addon-api",
	"typescript",
	"yaml-language-server",
	"dockerfile-language-server-nodejs",
	"graphql-language-service-cli",
	"graphql",
	"pyright",
	"vscode-css-languageservice",
	"vscode-html-languageservice",
	"vscode-json-languageservice",
	"vscode-languageserver-textdocument",
	"vscode-langservers-extracted",
];
