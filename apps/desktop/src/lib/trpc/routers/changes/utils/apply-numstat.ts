import type { ChangedFile } from "shared/changes-types";
import type { SimpleGit } from "simple-git";
import { parseDiffNumstat } from "./parse-status";

export async function applyNumstatToFiles(
	git: SimpleGit,
	files: ChangedFile[],
	diffArgs: string[],
): Promise<void> {
	if (files.length === 0) return;

	const NUMSTAT_TIMEOUT_MS = 15_000;
	try {
		const numstat = await Promise.race([
			git.raw(diffArgs),
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(`numstat timed out after ${NUMSTAT_TIMEOUT_MS}ms`),
						),
					NUMSTAT_TIMEOUT_MS,
				),
			),
		]);
		const stats = parseDiffNumstat(numstat);

		for (const file of files) {
			const fileStat = stats.get(file.path);
			if (fileStat) {
				file.additions = fileStat.additions;
				file.deletions = fileStat.deletions;
			}
		}
	} catch {}
}
