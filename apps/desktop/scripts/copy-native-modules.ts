/**
 * Prepare native modules for electron-builder.
 *
 * With Bun 1.3+ isolated installs, node_modules contains symlinks to packages
 * stored in node_modules/.bun/. electron-builder cannot follow these symlinks
 * when creating asar archives.
 *
 * This script:
 * 1. Detects if native modules are symlinks
 * 2. Replaces symlinks with actual file copies
 * 3. electron-builder can then properly package and unpack them
 *
 * This is safe because bun install will recreate the symlinks on next install.
 */

import { execSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { maxSatisfying, satisfies } from "semver";
import { requiredMaterializedNodeModules } from "../runtime-dependencies";

// Target architecture for cross-compilation. When set, platform-specific
// packages for this arch are fetched from npm if not already present.
// Set via TARGET_ARCH env var (e.g., TARGET_ARCH=x64).
const TARGET_ARCH = process.env.TARGET_ARCH || process.arch;
const TARGET_PLATFORM = process.env.TARGET_PLATFORM || process.platform;

function getWorkspaceRootNodeModulesDir(nodeModulesDir: string): string {
	return join(nodeModulesDir, "..", "..", "..", "node_modules");
}

function getBunFlatNodeModulesDir(nodeModulesDir: string): string {
	return join(
		getWorkspaceRootNodeModulesDir(nodeModulesDir),
		".bun",
		"node_modules",
	);
}

function getBunStoreDir(nodeModulesDir: string): string {
	return join(getWorkspaceRootNodeModulesDir(nodeModulesDir), ".bun");
}

function findBunStoreFolderName(
	bunStoreDir: string,
	moduleName: string,
	versionRange: string,
): string | null {
	if (!existsSync(bunStoreDir)) return null;
	const entries = readdirSync(bunStoreDir);
	const modulePrefix = `${moduleName.replace("/", "+")}@`;
	const matchingEntries = entries.filter((entry) => entry.startsWith(modulePrefix));

	const extractVersion = (entry: string): string | null => {
		const remainder = entry.slice(modulePrefix.length);
		const candidate = remainder.split("_")[0];
		return candidate.length > 0 ? candidate : null;
	};

	const versions = matchingEntries
		.map((entry) => ({ entry, version: extractVersion(entry) }))
		.filter((item): item is { entry: string; version: string } =>
			item.version !== null,
		);

	const exactMatch = versions.find((item) => item.version === versionRange);
	if (exactMatch) return exactMatch.entry;

	const bestMatch = maxSatisfying(
		versions.map((item) => item.version),
		versionRange,
	);
	if (!bestMatch) {
		return null;
	}

	return versions.find((item) => item.version === bestMatch)?.entry ?? null;
}

function copyModuleIfSymlink(
	nodeModulesDir: string,
	moduleName: string,
	required: boolean,
): boolean {
	const modulePath = join(nodeModulesDir, moduleName);
	const bunFlatNodeModulesDir = getBunFlatNodeModulesDir(nodeModulesDir);
	const bunFlatModulePath = join(bunFlatNodeModulesDir, moduleName);

	if (!existsSync(modulePath)) {
		if (existsSync(bunFlatModulePath)) {
			console.log(`  ${moduleName}: materializing from Bun store index`);
			mkdirSync(dirname(modulePath), { recursive: true });
			cpSync(realpathSync(bunFlatModulePath), modulePath, { recursive: true });
			console.log(`    Copied to: ${modulePath}`);
			return true;
		}
		if (required) {
			console.error(`  [ERROR] ${moduleName} not found at ${modulePath}`);
			process.exit(1);
		}
		console.log(`  ${moduleName}: not found (skipping)`);
		return false;
	}

	const stats = lstatSync(modulePath);

	if (stats.isSymbolicLink()) {
		// Resolve symlink to get real path
		const realPath = realpathSync(modulePath);
		console.log(`  ${moduleName}: symlink -> replacing with real files`);
		console.log(`    Real path: ${realPath}`);

		// Remove the symlink
		rmSync(modulePath);

		// Copy the actual files
		cpSync(realPath, modulePath, { recursive: true });

		console.log(`    Copied to: ${modulePath}`);
	} else {
		console.log(`  ${moduleName}: already real directory (not a symlink)`);
	}

	return true;
}

function readInstalledModuleVersion(modulePath: string): string | null {
	const packageJsonPath = join(modulePath, "package.json");
	if (!existsSync(packageJsonPath)) return null;
	type PackageJson = { version?: string };
	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson;
	return packageJson.version ?? null;
}

function copyExactModuleVersion(
	nodeModulesDir: string,
	moduleName: string,
	version: string,
	destPath: string,
	required: boolean,
): boolean {
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	const bunStoreFolderName = findBunStoreFolderName(
		bunStoreDir,
		moduleName,
		version,
	);
	if (bunStoreFolderName) {
		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			moduleName,
		);
		if (existsSync(sourcePath)) {
			rmSync(destPath, { recursive: true, force: true });
			mkdirSync(dirname(destPath), { recursive: true });
			cpSync(sourcePath, destPath, { recursive: true });
			console.log(`    Copied ${moduleName}@${version} to: ${destPath}`);
			return true;
		}
	}

	if (fetchNpmPackage(moduleName, version, destPath)) {
		return true;
	}

	if (required) {
		console.error(
			`  [ERROR] Failed to materialize ${moduleName}@${version} at ${destPath}`,
		);
		process.exit(1);
	}

	return false;
}

function resolveDependencySource(
	moduleName: string,
	versionRange: string,
): {
	sourceModuleName: string;
	sourceVersionRange: string;
} {
	if (!versionRange.startsWith("npm:")) {
		return {
			sourceModuleName: moduleName,
			sourceVersionRange: versionRange,
		};
	}

	const aliasSpec = versionRange.slice(4);
	const match = aliasSpec.match(/^((?:@[^/]+\/)?[^@]+)@(.+)$/);
	if (!match) {
		return {
			sourceModuleName: moduleName,
			sourceVersionRange: versionRange,
		};
	}

	return {
		sourceModuleName: match[1],
		sourceVersionRange: match[2],
	};
}

function copyDependencyForPackage(
	nodeModulesDir: string,
	parentModuleName: string,
	dependencyName: string,
	dependencyRange: string,
	required: boolean,
	options?: {
		preferNested?: boolean;
	},
): string | null {
	const resolvedDependency = resolveDependencySource(
		dependencyName,
		dependencyRange,
	);
	const topLevelDependencyPath = join(nodeModulesDir, dependencyName);
	const topLevelVersion = readInstalledModuleVersion(topLevelDependencyPath);
	const sourceTopLevelDependencyPath = join(
		nodeModulesDir,
		resolvedDependency.sourceModuleName,
	);
	const sourceTopLevelVersion = readInstalledModuleVersion(
		sourceTopLevelDependencyPath,
	);
	const nestedDependencyPath = join(
		nodeModulesDir,
		parentModuleName,
		"node_modules",
		dependencyName,
	);
	const preferNested = options?.preferNested ?? false;

	const materializeNestedFromSource = (sourcePath: string): string => {
		rmSync(nestedDependencyPath, { recursive: true, force: true });
		mkdirSync(dirname(nestedDependencyPath), { recursive: true });
		cpSync(sourcePath, nestedDependencyPath, {
			recursive: true,
		});
		return nestedDependencyPath;
	};
	const materializeTopLevelFromSource = (sourcePath: string): string => {
		rmSync(topLevelDependencyPath, { recursive: true, force: true });
		mkdirSync(dirname(topLevelDependencyPath), { recursive: true });
		cpSync(sourcePath, topLevelDependencyPath, {
			recursive: true,
		});
		return topLevelDependencyPath;
	};

	if (preferNested) {
		const nestedVersion = readInstalledModuleVersion(nestedDependencyPath);
		if (
			nestedVersion &&
			satisfies(nestedVersion, resolvedDependency.sourceVersionRange)
		) {
			const nestedStats = lstatSync(nestedDependencyPath);
			if (nestedStats.isSymbolicLink()) {
				const realPath = realpathSync(nestedDependencyPath);
				rmSync(nestedDependencyPath);
				cpSync(realPath, nestedDependencyPath, {
					recursive: true,
				});
			}
			return nestedDependencyPath;
		}

		if (
			topLevelVersion &&
			satisfies(topLevelVersion, resolvedDependency.sourceVersionRange)
		) {
			copyModuleIfSymlink(nodeModulesDir, dependencyName, required);
			return materializeNestedFromSource(topLevelDependencyPath);
		}

		if (
			resolvedDependency.sourceModuleName !== dependencyName &&
			sourceTopLevelVersion &&
			satisfies(
				sourceTopLevelVersion,
				resolvedDependency.sourceVersionRange,
			)
		) {
			copyModuleIfSymlink(
				nodeModulesDir,
				resolvedDependency.sourceModuleName,
				required,
			);
			return materializeNestedFromSource(sourceTopLevelDependencyPath);
		}

		console.log(
			`  ${dependencyName}: materializing nested copy for ${parentModuleName} (${topLevelVersion ?? sourceTopLevelVersion ?? "missing"} does not satisfy ${resolvedDependency.sourceVersionRange})`,
		);
		copyExactModuleVersion(
			nodeModulesDir,
			resolvedDependency.sourceModuleName,
			resolvedDependency.sourceVersionRange,
			nestedDependencyPath,
			required,
		);
		return nestedDependencyPath;
	}

	if (
		topLevelVersion &&
		satisfies(topLevelVersion, resolvedDependency.sourceVersionRange)
	) {
		copyModuleIfSymlink(nodeModulesDir, dependencyName, required);
		return topLevelDependencyPath;
	}

	if (
		resolvedDependency.sourceModuleName !== dependencyName &&
		sourceTopLevelVersion &&
		satisfies(sourceTopLevelVersion, resolvedDependency.sourceVersionRange)
	) {
		copyModuleIfSymlink(
			nodeModulesDir,
			resolvedDependency.sourceModuleName,
			required,
		);
		return materializeTopLevelFromSource(sourceTopLevelDependencyPath);
	}

	if (!topLevelVersion) {
		console.log(
			`  ${dependencyName}: top-level version missing; materializing ${resolvedDependency.sourceVersionRange} at the workspace root`,
		);
		copyExactModuleVersion(
			nodeModulesDir,
			resolvedDependency.sourceModuleName,
			resolvedDependency.sourceVersionRange,
			topLevelDependencyPath,
			required,
		);
		return topLevelDependencyPath;
	}

	const nestedVersion = readInstalledModuleVersion(nestedDependencyPath);
	if (
		nestedVersion &&
		satisfies(nestedVersion, resolvedDependency.sourceVersionRange)
	) {
		const nestedStats = lstatSync(nestedDependencyPath);
		if (nestedStats.isSymbolicLink()) {
			const realPath = realpathSync(nestedDependencyPath);
			rmSync(nestedDependencyPath);
			cpSync(realPath, nestedDependencyPath, {
				recursive: true,
			});
		}
		return nestedDependencyPath;
	}

	console.log(
		`  ${dependencyName}: top-level version ${topLevelVersion ?? sourceTopLevelVersion ?? "missing"} does not satisfy ${resolvedDependency.sourceVersionRange}; materializing nested copy for ${parentModuleName}`,
	);

	copyExactModuleVersion(
		nodeModulesDir,
		resolvedDependency.sourceModuleName,
		resolvedDependency.sourceVersionRange,
		nestedDependencyPath,
		required,
	);

	return nestedDependencyPath;
}

function materializeProductionDependencyTree(
	nodeModulesDir: string,
	packageRelativePath: string,
	seen: Set<string>,
): void {
	const packagePath = join(nodeModulesDir, packageRelativePath);
	const packageJsonPath = join(packagePath, "package.json");

	if (!existsSync(packageJsonPath)) {
		return;
	}

	type PackageJson = {
		name?: string;
		version?: string;
		dependencies?: Record<string, string>;
	};

	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson;
	const packageKey = packageJson.name
		? `${packageJson.name}@${packageJson.version ?? "0.0.0"}`
		: realpathSync(packagePath);

	if (seen.has(packageKey)) {
		return;
	}
	seen.add(packageKey);

	try {
		for (const [dependencyName, dependencyRange] of Object.entries(
			packageJson.dependencies ?? {},
		)) {
			const dependencyPath = copyDependencyForPackage(
				nodeModulesDir,
				packageRelativePath,
				dependencyName,
				dependencyRange,
				true,
				{ preferNested: true },
			);

			if (!dependencyPath) {
				continue;
			}

			materializeProductionDependencyTree(
				nodeModulesDir,
				relative(nodeModulesDir, dependencyPath),
				seen,
			);
		}
	} finally {
		seen.delete(packageKey);
	}
}

/**
 * Fetch an npm package tarball and extract it to destPath.
 * Used when cross-compiling and the target platform package isn't in the Bun store.
 */
function fetchNpmPackage(
	packageName: string,
	version: string,
	destPath: string,
): boolean {
	// npm tarball URL: @scope/pkg/-/pkg-version.tgz (filename uses pkg name without scope)
	const barePackageName = packageName.includes("/")
		? packageName.split("/")[1]
		: packageName;
	const url = `https://registry.npmjs.org/${packageName}/-/${barePackageName}-${version}.tgz`;
	console.log(`  ${packageName}: fetching from npm (${version})`);
	try {
		mkdirSync(destPath, { recursive: true });
		execSync(
			`curl -sL "${url}" | tar xz -C "${destPath}" --strip-components=1`,
			{
				stdio: "pipe",
			},
		);
		console.log(`    Extracted to: ${destPath}`);
		return true;
	} catch (err) {
		console.error(
			`  [ERROR] Failed to fetch ${packageName}@${version}: ${err}`,
		);
		return false;
	}
}

function copyAstGrepPlatformPackages(nodeModulesDir: string): void {
	const astGrepNapiPath = join(nodeModulesDir, "@ast-grep", "napi");
	if (!existsSync(astGrepNapiPath)) return;

	const astGrepPkgJsonPath = join(astGrepNapiPath, "package.json");
	if (!existsSync(astGrepPkgJsonPath)) return;

	type AstGrepPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const astGrepPkg = JSON.parse(
		readFileSync(astGrepPkgJsonPath, "utf8"),
	) as AstGrepPackageJson;
	const optionalDeps = astGrepPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@ast-grep/napi-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	// Determine which platform package we need for the target arch
	const targetPlatformSuffix = `${TARGET_PLATFORM === "darwin" ? "darwin" : TARGET_PLATFORM === "win32" ? "win32" : "linux"}-${TARGET_ARCH}`;
	const targetPkg = platformPackages.find((pkg) =>
		pkg.name.includes(targetPlatformSuffix),
	);

	// Bun isolated installs keep package payloads in workspaceRoot/node_modules/.bun
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedTargetPackage = false;

	for (const platformPkg of platformPackages) {
		const isTargetPkg = targetPkg && platformPkg.name === targetPkg.name;
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			const copied = copyModuleIfSymlink(
				nodeModulesDir,
				platformPkg.name,
				false,
			);
			if (isTargetPkg && copied) resolvedTargetPackage = true;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (bunStoreFolderName) {
			const sourcePath = join(
				bunStoreDir,
				bunStoreFolderName,
				"node_modules",
				platformPkg.name,
			);
			if (existsSync(sourcePath)) {
				console.log(`  ${platformPkg.name}: copying from Bun store`);
				mkdirSync(dirname(destPath), { recursive: true });
				cpSync(sourcePath, destPath, { recursive: true });
				if (isTargetPkg) resolvedTargetPackage = true;
				continue;
			}
		}

		// If this is the target platform package and it's not in the Bun store,
		// fetch it from npm (cross-compilation scenario)
		if (isTargetPkg) {
			if (fetchNpmPackage(platformPkg.name, platformPkg.version, destPath)) {
				resolvedTargetPackage = true;
				continue;
			}
		}

		console.warn(
			`  ${platformPkg.name}: not found in Bun store or node_modules`,
		);
	}

	if (!resolvedTargetPackage) {
		console.error(
			`  [ERROR] Target platform package ${targetPkg?.name ?? `@ast-grep/napi-${targetPlatformSuffix}`} was not materialized`,
		);
		process.exit(1);
	}
}

function copyLibsqlDependencies(nodeModulesDir: string): void {
	const libsqlPath = join(nodeModulesDir, "libsql");
	const libsqlPkgJsonPath = join(libsqlPath, "package.json");
	if (!existsSync(libsqlPkgJsonPath)) return;

	type LibsqlPackageJson = {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	const libsqlPkg = JSON.parse(
		readFileSync(libsqlPkgJsonPath, "utf8"),
	) as LibsqlPackageJson;
	const deps = libsqlPkg.dependencies ?? {};
	const optionalDeps = libsqlPkg.optionalDependencies ?? {};

	console.log("\nPreparing libsql runtime dependencies...");
	for (const [dep, version] of Object.entries(deps)) {
		copyDependencyForPackage(nodeModulesDir, "libsql", dep, version, true);
	}

	// Copy whichever optional native platform packages Bun installed for this platform.
	for (const dep of Object.keys(optionalDeps)) {
		copyModuleIfSymlink(nodeModulesDir, dep, false);
	}

	// Some Bun installs place optional deps under .bun/node_modules/@scope.
	// Mirror discovered @libsql optional packages if present there.
	const bunFlatLibsqlScopePath = join(
		getBunFlatNodeModulesDir(nodeModulesDir),
		"@libsql",
	);
	if (existsSync(bunFlatLibsqlScopePath)) {
		for (const entry of readdirSync(bunFlatLibsqlScopePath)) {
			if (
				!entry.includes("darwin") &&
				!entry.includes("linux") &&
				!entry.includes("win32")
			) {
				continue;
			}
			copyModuleIfSymlink(nodeModulesDir, `@libsql/${entry}`, false);
		}
	}

	// Cross-compilation: ensure the target platform's @libsql package is present
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetLibsqlPkgs = Object.entries(optionalDeps).filter(([name]) =>
		name.includes(targetSuffix),
	);
	for (const [name, version] of targetLibsqlPkgs) {
		const destPath = join(nodeModulesDir, name);
		if (!existsSync(destPath)) {
			fetchNpmPackage(name, version, destPath);
		}
	}
}

function copyParcelWatcherPlatformPackages(nodeModulesDir: string): void {
	const watcherPath = join(nodeModulesDir, "@parcel", "watcher");
	const watcherPkgJsonPath = join(watcherPath, "package.json");
	if (!existsSync(watcherPkgJsonPath)) return;

	type ParcelWatcherPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const watcherPkg = JSON.parse(
		readFileSync(watcherPkgJsonPath, "utf8"),
	) as ParcelWatcherPackageJson;
	const optionalDeps = watcherPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@parcel/watcher-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	console.log("\nPreparing parcel watcher platform package...");
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedPlatformPackage = false;

	for (const platformPkg of platformPackages) {
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			resolvedPlatformPackage =
				copyModuleIfSymlink(nodeModulesDir, platformPkg.name, false) ||
				resolvedPlatformPackage;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (!bunStoreFolderName) {
			console.warn(
				`  ${platformPkg.name}: no Bun store entry matched version ${platformPkg.version}`,
			);
			continue;
		}

		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			platformPkg.name,
		);
		if (!existsSync(sourcePath)) {
			console.warn(
				`  ${platformPkg.name}: Bun store path missing after resolve (${sourcePath})`,
			);
			continue;
		}

		console.log(`  ${platformPkg.name}: copying from Bun store`);
		mkdirSync(dirname(destPath), { recursive: true });
		cpSync(sourcePath, destPath, { recursive: true });
		resolvedPlatformPackage = true;
	}

	if (!resolvedPlatformPackage) {
		console.error(
			"  [ERROR] No `@parcel/watcher-<platform>` runtime package was materialized",
		);
		process.exit(1);
	}
}

function prepareNativeModules() {
	console.log("Preparing external runtime modules for electron-builder...");
	console.log(
		`  Target: ${TARGET_PLATFORM}/${TARGET_ARCH} (host: ${process.platform}/${process.arch})`,
	);

	// bun creates symlinks for direct dependencies in the workspace's node_modules
	const nodeModulesDir = join(dirname(import.meta.dirname), "node_modules");

	console.log("\nMaterializing packaged runtime modules...");
	for (const moduleName of requiredMaterializedNodeModules) {
		copyModuleIfSymlink(nodeModulesDir, moduleName, true);
	}

	console.log("\nMaterializing runtime dependency trees...");
	const runtimeDependencyRoots = [
		"yaml-language-server",
		"dockerfile-language-server-nodejs",
		"graphql-language-service-cli",
		"pyright",
		"vscode-css-languageservice",
		"vscode-html-languageservice",
		"vscode-json-languageservice",
		"vscode-languageserver-textdocument",
		"vscode-langservers-extracted",
		"strip-ansi",
	];
	const seenPackages = new Set<string>();
	for (const moduleName of runtimeDependencyRoots) {
		copyModuleIfSymlink(nodeModulesDir, moduleName, true);
		materializeProductionDependencyTree(nodeModulesDir, moduleName, seenPackages);
	}

	console.log("\nPreparing ast-grep platform package...");
	copyAstGrepPlatformPackages(nodeModulesDir);
	copyParcelWatcherPlatformPackages(nodeModulesDir);
	copyLibsqlDependencies(nodeModulesDir);

	console.log("\nDone!");
}

prepareNativeModules();
