import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";

let cachedHistory: string[] | null = null;
let lastReadTime = 0;
const CACHE_TTL_MS = 30_000;

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
		const content = await readFile(zshPath, "utf-8");
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
