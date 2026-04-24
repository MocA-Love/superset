import { promises as fs } from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { dispatchPaths } from "main/lib/file-intake";
import { z } from "zod";
import { publicProcedure, router } from "../..";

// v1 scratch file procedures: deliberately do NOT go through the
// workspace-scoped filesystem service. A scratch file has no workspace root —
// the path the user handed us (via DnD / open-with / argv) IS the access
// boundary. We still sanity-check the path is absolute and does not traverse
// to /etc or similar via parent refs after resolution.
const MAX_SCRATCH_READ_BYTES = 5 * 1024 * 1024; // 5 MB

/** Paths that aren't strictly off-limits but where an accidental DnD edit
 * would be much worse than helpful. scratch mode is a text-file convenience
 * feature; it is not a general system editor. */
const SCRATCH_WRITE_DENY_PATTERNS: RegExp[] = [
	// Unix system dirs.
	/^\/etc\//,
	/^\/System\//,
	/^\/usr\//,
	/^\/private\/etc\//,
	// User secrets.
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

function assertScratchWriteAllowed(abs: string): void {
	for (const pattern of SCRATCH_WRITE_DENY_PATTERNS) {
		if (pattern.test(abs)) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: `Scratch write refused for system/secret path: ${abs}`,
			});
		}
	}
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
				const maxBytes = Math.min(
					input.maxBytes ?? MAX_SCRATCH_READ_BYTES,
					MAX_SCRATCH_READ_BYTES,
				);

				let stat: Awaited<ReturnType<typeof fs.stat>>;
				try {
					stat = await fs.stat(abs);
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: `File not found: ${abs}`,
						});
					}
					throw err;
				}
				if (stat.isDirectory()) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Path is a directory: ${abs}`,
					});
				}
				if (stat.size > maxBytes) {
					return {
						kind: "too-large" as const,
						absolutePath: abs,
						size: stat.size,
						maxBytes,
					};
				}

				// Read as UTF-8 text. For true binary files this will still return
				// characters but the CodeEditor in the renderer renders it as-is.
				// Scratch mode is intended for text files; binary support is not a
				// v1 goal.
				const content = await fs.readFile(abs, { encoding: "utf8" });
				return {
					kind: "text" as const,
					absolutePath: abs,
					content,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
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
				assertScratchWriteAllowed(abs);

				// Use lstat to detect symlinks before we open for write: fs.writeFile
				// would happily follow a symlink and overwrite whatever it points at,
				// which is the classic "dropped-file authorized me to edit
				// ~/.ssh/authorized_keys" footgun. Policy: refuse to write through
				// symlinks in scratch mode.
				let lstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
				try {
					lstat = await fs.lstat(abs);
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
						throw err;
					}
				}
				if (lstat?.isDirectory()) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Path is a directory: ${abs}`,
					});
				}
				if (lstat?.isSymbolicLink()) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: `Refusing to write through symlink: ${abs}`,
					});
				}

				await fs.writeFile(abs, input.content, { encoding: "utf8" });
				const newStat = await fs.stat(abs);
				return {
					absolutePath: abs,
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
	});
