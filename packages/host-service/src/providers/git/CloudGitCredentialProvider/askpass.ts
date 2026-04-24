import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function writeTempAskpass(token: string): Promise<string> {
	if (process.platform === "win32") {
		const filePath = join(tmpdir(), `git-askpass-${randomUUID()}.cmd`);
		// Git on Windows runs askpass helpers directly — the file extension
		// determines the interpreter, so we ship a .cmd variant. Uses findstr
		// for a case-insensitive prefix check that works in every cmd.exe.
		const script = `@echo off\r\nsetlocal EnableExtensions\r\necho %~1|findstr /I "^Username" >nul && (echo x-access-token) || (echo ${escapeCmdEcho(token)})\r\n`;
		await writeFile(filePath, script);
		return filePath;
	}

	const filePath = join(tmpdir(), `git-askpass-${randomUUID()}.sh`);
	const script = `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "${token}" ;;
esac
`;
	await writeFile(filePath, script);
	await chmod(filePath, 0o700);
	return filePath;
}

/** Escape characters that would break `echo` or `findstr` in cmd.exe. */
function escapeCmdEcho(value: string): string {
	return value.replace(/([&<>^|%])/g, "^$1");
}
