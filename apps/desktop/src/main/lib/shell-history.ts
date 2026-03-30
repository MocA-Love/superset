import { constants } from "node:fs";
import {
	access,
	chmod,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let cachedHistory: string[] | null = null;
let lastReadTime = 0;
const CACHE_TTL_MS = 30_000;

const META_MARKER = 0x83;

function decodeMetafied(buffer: Buffer): string {
	const decoded: number[] = [];
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === META_MARKER && i + 1 < buffer.length) {
			decoded.push(buffer[i + 1] ^ 0x20);
			i++;
		} else {
			decoded.push(buffer[i]);
		}
	}
	return Buffer.from(decoded).toString("utf-8");
}

function parseZshHistory(content: string): string[] {
	const entries: string[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		// Extended format: : timestamp:0;command
		const match = line.match(/^:\s*\d+:\d+;(.+)$/);
		const command = match ? match[1] : line;
		// Skip multi-line continuations
		if (command.endsWith("\\")) continue;
		const trimmed = command.trim();
		if (trimmed) entries.push(trimmed);
	}
	return entries;
}

function parseBashHistory(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => line.trim() && !line.startsWith("#"))
		.map((line) => line.trim());
}

async function readHistoryFile(): Promise<string[]> {
	const home = homedir();

	// Try zsh first (more common on macOS)
	const zshPath = `${home}/.zsh_history`;
	try {
		await access(zshPath, constants.R_OK);
		const buffer = await readFile(zshPath);
		const content = buffer.includes(META_MARKER)
			? decodeMetafied(buffer)
			: buffer.toString("utf-8");
		return parseZshHistory(content);
	} catch {
		// zsh history not available
	}

	// Fall back to bash
	const bashPath = `${home}/.bash_history`;
	try {
		await access(bashPath, constants.R_OK);
		const content = await readFile(bashPath, "utf-8");
		return parseBashHistory(content);
	} catch {
		// bash history not available
	}

	return [];
}

async function getHistory(): Promise<string[]> {
	const now = Date.now();
	if (cachedHistory && now - lastReadTime < CACHE_TTL_MS) {
		return cachedHistory;
	}

	const entries = await readHistoryFile();

	// Deduplicate, most-recent-first
	const seen = new Set<string>();
	const result: string[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const cmd = entries[i];
		if (!seen.has(cmd)) {
			seen.add(cmd);
			result.push(cmd);
		}
	}

	cachedHistory = result.slice(0, 10_000);
	lastReadTime = now;
	return cachedHistory;
}

const PAGE_SIZE = 8;

export async function getSuggestions(
	prefix: string,
	offset = 0,
): Promise<string[]> {
	if (!prefix || prefix.length < 2) return [];

	const history = await getHistory();
	const results: string[] = [];
	let skipped = 0;

	for (const cmd of history) {
		if (cmd.startsWith(prefix) && cmd !== prefix) {
			if (skipped < offset) {
				skipped++;
				continue;
			}
			results.push(cmd);
			if (results.length >= PAGE_SIZE) break;
		}
	}

	return results;
}

function encodeMetafied(text: string): Buffer {
	const src = Buffer.from(text, "utf-8");
	const out: number[] = [];
	for (let i = 0; i < src.length; i++) {
		const b = src[i];
		if (b === META_MARKER) {
			out.push(META_MARKER, b ^ 0x20);
		} else {
			out.push(b);
		}
	}
	return Buffer.from(out);
}

function filterZshLines(lines: string[], commandToDelete: string): string[] {
	const filtered: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const match = line.match(/^:\s*\d+:\d+;(.+)$/);
		const cmd = match ? match[1] : null;

		if (cmd !== null) {
			// Collect continuation lines (ending with \)
			let fullCmd = cmd;
			let blockLen = 1;
			while (fullCmd.endsWith("\\") && i + blockLen < lines.length) {
				fullCmd = fullCmd.slice(0, -1) + lines[i + blockLen];
				blockLen++;
			}
			if (fullCmd.trim() === commandToDelete.trim()) {
				i += blockLen;
				continue;
			}
		}
		filtered.push(line);
		i++;
	}
	return filtered;
}

function filterBashLines(lines: string[], commandToDelete: string): string[] {
	return lines.filter((line) => line.trim() !== commandToDelete.trim());
}

async function atomicWriteFile(
	filePath: string,
	content: Buffer,
): Promise<void> {
	const tmp = join(
		tmpdir(),
		`superset-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await writeFile(tmp, content, { mode: 0o600 });
	try {
		const orig = await stat(filePath);
		await chmod(tmp, orig.mode);
	} catch {
		// keep default 0o600
	}
	await rename(tmp, filePath);
}

export async function deleteHistoryEntry(command: string): Promise<void> {
	const home = homedir();

	// Try zsh first
	const zshPath = `${home}/.zsh_history`;
	try {
		await access(zshPath, constants.R_OK | constants.W_OK);
		const buffer = await readFile(zshPath);
		const isMetafiedFile = buffer.includes(META_MARKER);
		const content = isMetafiedFile
			? decodeMetafied(buffer)
			: buffer.toString("utf-8");

		const lines = content.split("\n");
		const filtered = filterZshLines(lines, command);
		if (filtered.length === lines.length) {
			// Nothing deleted
			cachedHistory = null;
			return;
		}

		const newContent = filtered.join("\n");
		const newBuffer = isMetafiedFile
			? encodeMetafied(newContent)
			: Buffer.from(newContent, "utf-8");
		await atomicWriteFile(zshPath, newBuffer);
		cachedHistory = null;
		return;
	} catch {
		// zsh not available or not writable
	}

	// Fall back to bash
	const bashPath = `${home}/.bash_history`;
	try {
		await access(bashPath, constants.R_OK | constants.W_OK);
		const content = await readFile(bashPath, "utf-8");
		const lines = content.split("\n");
		const filtered = filterBashLines(lines, command);
		if (filtered.length < lines.length) {
			await atomicWriteFile(
				bashPath,
				Buffer.from(filtered.join("\n"), "utf-8"),
			);
		}
		cachedHistory = null;
	} catch {
		// bash not available
	}
}
