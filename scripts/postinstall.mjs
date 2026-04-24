/**
 * Cross-platform postinstall entry.
 *
 * Replaces the bash-only postinstall.sh so `bun install` works on Windows as
 * well as macOS / Linux without needing Git Bash or WSL.
 *
 * Steps:
 *   1. Guard against infinite recursion (electron-builder install-app-deps
 *      can trigger nested bun installs which would re-enter this script).
 *   2. Run sherif for workspace validation.
 *   3. Skip the desktop native rebuild in CI — GitHub Actions uses many
 *      parallel `bun install` jobs that don't need desktop native deps, and
 *      nested bun installs have been flaky while the outer install is still
 *      materializing packages.
 *   4. Install native dependencies for the desktop app. On Windows the
 *      compilation may fail without Visual Studio Build Tools, so the step
 *      is non-fatal there (prebuilt binaries will be used when available).
 */

import { execSync } from "node:child_process";

if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}
process.env.SUPERSET_POSTINSTALL_RUNNING = "1";

const env = { ...process.env, SUPERSET_POSTINSTALL_RUNNING: "1" };

function run(cmd) {
	execSync(cmd, { stdio: "inherit", env });
}

function tryRun(cmd, label) {
	try {
		execSync(cmd, { stdio: "inherit", env });
	} catch {
		console.warn(
			`[postinstall] ${label} failed (non-fatal on Windows) — continuing`,
		);
	}
}

run("sherif");

if (process.env.CI) {
	process.exit(0);
}

if (process.platform === "win32") {
	tryRun(
		"bun run --filter=@superset/desktop install:deps",
		"desktop install:deps",
	);
} else {
	run("bun run --filter=@superset/desktop install:deps");
}
