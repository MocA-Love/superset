import { promises as fs } from "node:fs";
import path from "node:path";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { and, eq, isNull } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { localDb } from "main/lib/local-db";

export type FileIntakeTarget =
	| {
			kind: "workspace-file";
			workspaceId: string;
			absolutePath: string;
			isDirectory: boolean;
	  }
	| {
			kind: "scratch-file";
			absolutePath: string;
	  }
	| {
			kind: "scratch-directory";
			// v1: directory not in a registered workspace is treated as scratch:
			// the directory itself is opened in the tabs as a "folder entry" (we just
			// show the first file encountered). We keep the UX simple and do not
			// recursively open — the user can register the folder as a workspace
			// explicitly from the existing UI if they want full treatment.
			absolutePath: string;
	  };

interface ResolvedWorkspace {
	workspaceId: string;
	worktreePath: string;
}

const IS_WINDOWS = process.platform === "win32";

/** Make paths directly comparable across drops and DB rows. On Windows this
 * also lowercases so drive-letter and directory case mismatches don't
 * misclassify a registered-workspace file as scratch. */
function normalize(p: string): string {
	const resolved = path.resolve(p);
	return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/** Walk symlinks before comparing so a file living outside its worktree via
 * a symlink farm still classifies against the workspace it logically
 * belongs to. Falls back to `path.resolve` if the target doesn't exist. */
async function canonicalPath(p: string): Promise<string> {
	try {
		return normalize(await fs.realpath(p));
	} catch {
		return normalize(p);
	}
}

function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Scan the local DB for all workspace worktree/repo roots, long side first so
 * nested paths win the match (e.g., a submodule registered as a workspace
 * beats its parent repo).
 */
function listRegisteredRoots(): ResolvedWorkspace[] {
	const worktreeRoots = localDb
		.select({
			workspaceId: workspaces.id,
			worktreePath: worktrees.path,
		})
		.from(workspaces)
		.innerJoin(worktrees, eq(workspaces.worktreeId, worktrees.id))
		.where(and(eq(workspaces.type, "worktree"), isNull(workspaces.deletingAt)))
		.all()
		.filter(
			(row): row is ResolvedWorkspace =>
				typeof row.worktreePath === "string" && row.worktreePath.length > 0,
		);

	const branchRoots = localDb
		.select({
			workspaceId: workspaces.id,
			worktreePath: projects.mainRepoPath,
		})
		.from(workspaces)
		.innerJoin(projects, eq(workspaces.projectId, projects.id))
		.where(and(eq(workspaces.type, "branch"), isNull(workspaces.deletingAt)))
		.all()
		.filter(
			(row): row is ResolvedWorkspace =>
				typeof row.worktreePath === "string" && row.worktreePath.length > 0,
		);

	return [...worktreeRoots, ...branchRoots].sort(
		(a, b) => b.worktreePath.length - a.worktreePath.length,
	);
}

async function resolveRegisteredRoots(): Promise<ResolvedWorkspace[]> {
	const raw = listRegisteredRoots();
	return Promise.all(
		raw.map(async (root) => ({
			workspaceId: root.workspaceId,
			worktreePath: await canonicalPath(root.worktreePath),
		})),
	);
}

function findRegisteredWorkspaceFor(
	canonicalChild: string,
	roots: ResolvedWorkspace[],
): ResolvedWorkspace | null {
	for (const root of roots) {
		if (isPathInside(canonicalChild, root.worktreePath)) {
			return root;
		}
	}
	return null;
}

async function classifyPath(
	absolutePath: string,
	roots: ResolvedWorkspace[],
): Promise<FileIntakeTarget> {
	let stat: import("node:fs").Stats;
	try {
		stat = await fs.stat(absolutePath);
	} catch {
		return { kind: "scratch-file", absolutePath };
	}
	const isDirectory = stat.isDirectory();

	const canonical = await canonicalPath(absolutePath);
	const match = findRegisteredWorkspaceFor(canonical, roots);
	if (match) {
		return {
			kind: "workspace-file",
			workspaceId: match.workspaceId,
			absolutePath,
			isDirectory,
		};
	}

	if (isDirectory) {
		return { kind: "scratch-directory", absolutePath };
	}
	return { kind: "scratch-file", absolutePath };
}

export async function classifyPaths(
	absolutePaths: string[],
): Promise<FileIntakeTarget[]> {
	const deduped = Array.from(
		new Map(absolutePaths.map((p) => [normalize(p), p])).values(),
	);
	// Resolve registered roots once per batch — previously each classifyPath
	// ran two SQLite joins independently, which scaled badly with large drops.
	const roots = await resolveRegisteredRoots();
	return Promise.all(deduped.map((p) => classifyPath(p, roots)));
}

/**
 * Split targets by kind so the renderer can be instructed how to open each.
 *
 * Directories inside registered workspaces are kept in `byWorkspace` as an
 * entry with an empty `absolutePaths` when they're the only drop for that
 * workspace — that way the renderer still navigates to the workspace but
 * doesn't try to open the folder as a file (which would produce a broken
 * FileViewerPane).
 */
function splitTargets(targets: FileIntakeTarget[]) {
	const byWorkspace = new Map<string, string[]>();
	const scratch: string[] = [];
	for (const t of targets) {
		if (t.kind === "workspace-file") {
			const existing = byWorkspace.get(t.workspaceId) ?? [];
			// Directories: register the workspace as a nav target but never push
			// the path as a file to open.
			if (!t.isDirectory) existing.push(t.absolutePath);
			byWorkspace.set(t.workspaceId, existing);
		} else {
			// scratch-file and scratch-directory both surface as scratch tabs;
			// v1 scratch doesn't distinguish, it just opens the path.
			scratch.push(t.absolutePath);
		}
	}
	return { byWorkspace, scratch };
}

export function focusFirstWindow(): BrowserWindow | null {
	const wins = BrowserWindow.getAllWindows();
	if (wins.length === 0) return null;
	const main = wins[0];
	if (main.isMinimized()) main.restore();
	main.show();
	main.focus();
	return main;
}

/**
 * Pending cold-start paths: macOS fires `open-file` before the window exists,
 * and on Windows/Linux the first launch's file args arrive in process.argv
 * before the renderer is ready. We queue here and drain on first dispatch.
 */
const pendingPaths: string[] = [];
let ready = false;

export function queuePath(absolutePath: string): void {
	pendingPaths.push(absolutePath);
}

export function markFileIntakeReady(): void {
	ready = true;
}

export function isFileIntakeReady(): boolean {
	return ready;
}

export function takePendingPaths(): string[] {
	const snapshot = pendingPaths.splice(0, pendingPaths.length);
	return snapshot;
}

/**
 * Public API: hand a batch of OS paths (from open-file / argv / DnD /
 * second-instance) over to the renderer.
 *
 * We *never* encode file paths in the route URL. The renderer's persistent
 * hash history serializes routes to localStorage, which would silently
 * restore scratch / workspace file intents on the next launch (Q1:B violation)
 * and log absolute paths to disk. All payload data flows through IPC
 * channels that the renderer consumes into its zustand stores.
 */
export async function dispatchPaths(absolutePaths: string[]): Promise<void> {
	if (absolutePaths.length === 0) return;

	if (!ready) {
		for (const p of absolutePaths) queuePath(p);
		return;
	}

	const targets = await classifyPaths(absolutePaths);
	if (targets.length === 0) return;

	const win = focusFirstWindow();
	if (!win) {
		for (const p of absolutePaths) queuePath(p);
		return;
	}

	const { byWorkspace, scratch } = splitTargets(targets);

	// Q5:A — batch per workspace so the renderer can open all of them as tabs
	// without each event overwriting the previous DeepLinkNavigation intent.
	for (const [workspaceId, paths] of byWorkspace) {
		win.webContents.send("file-intake:open-workspace-batch", {
			workspaceId,
			absolutePaths: paths,
		});
	}

	if (scratch.length > 0) {
		win.webContents.send("file-intake:open-scratch-batch", {
			absolutePaths: scratch,
		});
	}
}

export async function drainPendingPaths(): Promise<void> {
	if (pendingPaths.length === 0) return;
	const paths = takePendingPaths();
	await dispatchPaths(paths);
}

/**
 * Identify file-path-looking argv entries. We deliberately skip flags, URLs,
 * and the executable path so we don't misinterpret the launch argv on cold
 * start. Only entries that already exist on disk (as either file or directory)
 * are treated as drops.
 */
export async function filterFilePathArgs(argv: string[]): Promise<string[]> {
	const candidates = argv.filter((arg, idx) => {
		// Skip the executable (argv[0]) and anything that looks like a flag/URL.
		if (idx === 0) return false;
		if (arg.startsWith("-")) return false;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return false;
		return true;
	});

	const resolved = await Promise.all(
		candidates.map(async (arg) => {
			try {
				const abs = path.isAbsolute(arg) ? arg : path.resolve(arg);
				await fs.access(abs);
				return abs;
			} catch {
				return null;
			}
		}),
	);
	return resolved.filter((v): v is string => v !== null);
}
