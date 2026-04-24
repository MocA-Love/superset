import { promises as fs } from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import {
	dispatchPaths,
	type FileIntakeScratchBatch,
	type FileIntakeWorkspaceBatch,
	fileIntakeEmitter,
} from "main/lib/file-intake";
import { z } from "zod";
import { publicProcedure, router } from "../..";

// v1 scratch file procedures: deliberately do NOT go through the
// workspace-scoped filesystem service. A scratch file has no workspace root —
// the path the user handed us (via DnD / open-with / argv) IS the access
// boundary. We still sanity-check the path is absolute and does not traverse
// to /etc or similar via parent refs after resolution.
const MAX_SCRATCH_READ_BYTES = 5 * 1024 * 1024; // 5 MB

/** Paths that aren't strictly off-limits but where an accidental DnD edit /
 * viewing would be much worse than helpful. scratch mode is a text-file
 * convenience feature; it is not a general system editor.
 *
 * Patterns are evaluated against the **forward-slash-normalized** path so
 * the same regexes catch Windows paths (`C:/Users/x/.ssh/id_rsa`) without
 * duplicating every rule for backslashes.
 */
const SCRATCH_DENY_PATTERNS: RegExp[] = [
	// Unix system dirs.
	/^\/etc\//,
	/^\/System\//,
	/^\/usr\//,
	/^\/private\/etc\//,
	// Windows system dirs (path has been forward-slashed beforehand).
	/^[A-Za-z]:\/Windows\//,
	/^[A-Za-z]:\/Program(Data| Files)\//,
	// User secrets — match the dotfolder segment on any platform.
	/\/\.ssh\//,
	/\/\.aws\//,
	/\/\.gnupg\//,
];

function sanitizeAbsolutePath(input: string): string {
	if (!path.isAbsolute(input)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Scratch paths must be absolute",
		});
	}
	// path.resolve normalizes `..` / `.` segments so the result can be compared
	// against a prefix safely if we ever add a sandbox root later.
	return path.resolve(input);
}

function assertScratchAllowed(abs: string, action: "read" | "write"): void {
	// Normalize separators so POSIX patterns also match Windows paths.
	const probe = abs.replace(/\\/g, "/");
	for (const pattern of SCRATCH_DENY_PATTERNS) {
		if (pattern.test(probe)) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: `Scratch ${action} refused for system/secret path: ${abs}`,
			});
		}
	}
}

/** Resolve the parent directory via realpath and rejoin basename. Catches
 * symlink-parent escapes where the final path component looks fine but a
 * parent segment redirects into a protected tree. */
async function canonicalizeLeafPath(abs: string): Promise<string> {
	const dir = path.dirname(abs);
	let canonicalDir: string;
	try {
		canonicalDir = await fs.realpath(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Parent directory does not exist: ${dir}`,
			});
		}
		throw err;
	}
	return path.join(canonicalDir, path.basename(abs));
}

export const createScratchRouter = () =>
	router({
		readFile: publicProcedure
			.input(
				z.object({
					absolutePath: z.string(),
					maxBytes: z.number().int().positive().optional(),
				}),
			)
			.query(async ({ input }) => {
				const abs = sanitizeAbsolutePath(input.absolutePath);
				const canonical = await canonicalizeLeafPath(abs);
				// Symmetric with writeFile: deny readable secrets too so the user
				// doesn't get a surprise `FORBIDDEN` only at save time after
				// editing `~/.ssh/config` in scratch.
				assertScratchAllowed(canonical, "read");
				const maxBytes = Math.min(
					input.maxBytes ?? MAX_SCRATCH_READ_BYTES,
					MAX_SCRATCH_READ_BYTES,
				);

				let lstat: Awaited<ReturnType<typeof fs.lstat>>;
				try {
					lstat = await fs.lstat(canonical);
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: `File not found: ${canonical}`,
						});
					}
					throw err;
				}
				if (lstat.isDirectory()) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Path is a directory: ${canonical}`,
					});
				}
				if (lstat.isSymbolicLink()) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: `Refusing to read through symlink: ${canonical}`,
					});
				}
				if (lstat.size > maxBytes) {
					return {
						kind: "too-large" as const,
						absolutePath: canonical,
						size: lstat.size,
						maxBytes,
					};
				}

				// Read as UTF-8 text. For true binary files this will still return
				// characters but the CodeEditor in the renderer renders it as-is.
				// Scratch mode is intended for text files; binary support is not a
				// v1 goal.
				const content = await fs.readFile(canonical, { encoding: "utf8" });
				return {
					kind: "text" as const,
					absolutePath: canonical,
					content,
					size: lstat.size,
					mtimeMs: lstat.mtimeMs,
				};
			}),

		writeFile: publicProcedure
			.input(
				z.object({
					absolutePath: z.string(),
					content: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const abs = sanitizeAbsolutePath(input.absolutePath);
				// Resolve symlinks in every parent segment before enforcing
				// policy. Checking only the final basename with lstat(abs) misses
				// the case where a *parent* directory is a symlink pointing into
				// a protected tree — lstat sees a regular file and the deny-list
				// sees `/tmp/link/...` but writeFile then touches the real
				// target. canonicalizeLeafPath + assertScratchAllowed catch both
				// parent-dir escapes and direct hits.
				const canonical = await canonicalizeLeafPath(abs);
				assertScratchAllowed(canonical, "write");

				let lstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
				try {
					lstat = await fs.lstat(canonical);
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
						throw err;
					}
				}
				if (lstat?.isDirectory()) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Path is a directory: ${canonical}`,
					});
				}
				if (lstat?.isSymbolicLink()) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: `Refusing to write through symlink: ${canonical}`,
					});
				}

				await fs.writeFile(canonical, input.content, { encoding: "utf8" });
				const newStat = await fs.stat(canonical);
				return {
					absolutePath: canonical,
					size: newStat.size,
					mtimeMs: newStat.mtimeMs,
				};
			}),

		/**
		 * Renderer-originated DnD: when the user drops OS files onto the window,
		 * the preload surfaces the absolute paths and calls this mutation. We
		 * route through the same `dispatchPaths` used by native `open-file` /
		 * argv so the classification + navigation stay in one place.
		 */
		ingestDroppedPaths: publicProcedure
			.input(
				z.object({
					absolutePaths: z.array(z.string()),
				}),
			)
			.mutation(async ({ input }) => {
				const sanitized = input.absolutePaths
					.filter((p) => path.isAbsolute(p))
					.map((p) => path.resolve(p));
				await dispatchPaths(sanitized);
				return { accepted: sanitized.length };
			}),

		/**
		 * Subscriptions the renderer uses to receive file-intake dispatches.
		 * trpc-electron requires observables (not async generators) — we just
		 * mirror events from `fileIntakeEmitter`. AGENTS.md mandates tRPC for
		 * main↔renderer IPC; this replaces an earlier `webContents.send` path.
		 */
		onOpenWorkspaceBatch: publicProcedure.subscription(() =>
			observable<FileIntakeWorkspaceBatch>((emit) => {
				const handler = (batch: FileIntakeWorkspaceBatch) => emit.next(batch);
				fileIntakeEmitter.on("open-workspace-batch", handler);
				return () => {
					fileIntakeEmitter.off("open-workspace-batch", handler);
				};
			}),
		),

		onOpenScratchBatch: publicProcedure.subscription(() =>
			observable<FileIntakeScratchBatch>((emit) => {
				const handler = (batch: FileIntakeScratchBatch) => emit.next(batch);
				fileIntakeEmitter.on("open-scratch-batch", handler);
				return () => {
					fileIntakeEmitter.off("open-scratch-batch", handler);
				};
			}),
		),
	});
