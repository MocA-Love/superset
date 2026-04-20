import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { readFile as readFsFile, writeFile as writeFsFile } from "./fs";
import {
	compareItemsByFuzzyScore,
	type FuzzyScorerCache,
	type IItemAccessor,
	prepareQuery,
	scoreItemFuzzy,
} from "./fuzzy-scorer";
import {
	isPathWithinRoot,
	normalizeAbsolutePath,
	toRelativePath,
} from "./paths";
import type {
	FsContentMatch,
	FsReplaceContentResult,
	FsSearchMatch,
} from "./types";

const execFileAsync = promisify(execFile);

const SEARCH_INDEX_TTL_MS = 30_000;
const MAX_SEARCH_RESULTS = 500;
const MAX_KEYWORD_FILE_SIZE_BYTES = 1024 * 1024;
const BINARY_CHECK_SIZE = 8192;
const MAX_PREVIEW_LENGTH = 160;
const KEYWORD_SEARCH_CANDIDATE_MULTIPLIER = 4;
const KEYWORD_SEARCH_MAX_COUNT_PER_FILE = 3;
const KEYWORD_SEARCH_RIPGREP_BUFFER_BYTES = 10 * 1024 * 1024;
const FILE_LISTING_RIPGREP_BUFFER_BYTES = 64 * 1024 * 1024;

// Matches VSCode's Quick Open "boost by recency" behavior. Fuzzy scores are
// already in the thousands for label-prefix hits, so boost values here are
// calibrated to nudge ordering without dominating unrelated fuzzy winners.
const MRU_SCORE_BOOST = 1_000;
const OPEN_FILE_SCORE_BOOST = 2_000;

// How often to yield to the event loop during the scoring hot loop. Lets
// cancellation propagate and keeps the renderer responsive on huge indexes.
const SCORE_YIELD_INTERVAL = 2_048;

const activeFileSearchControllers = new Map<string, AbortController>();
const activeSearchControllers = new Map<string, AbortController>();

// These are the only truly universal ignores. `.gitignore` / `.rgignore`
// semantics are delegated to ripgrep when available (see `listFilesRipgrep`).
// The fast-glob fallback keeps a wider hardcoded list because it lacks
// gitignore support and would otherwise drown the index in build artifacts.
export const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

const FALLBACK_IGNORE_PATTERNS = [
	...DEFAULT_IGNORE_PATTERNS,
	"**/dist/**",
	"**/build/**",
	"**/.next/**",
	"**/.turbo/**",
	"**/coverage/**",
];

interface SearchIndexEntry {
	absolutePath: string;
	relativePath: string;
	name: string;
	/** Parent directory path (pre-computed for fuzzy scorer). */
	description: string | undefined;
}

interface FileSearchIndex {
	items: SearchIndexEntry[];
}

interface FileSearchCacheEntry {
	index: FileSearchIndex;
	builtAt: number;
}

interface PathFilterMatcher {
	includeMatchers: RegExp[];
	excludeMatchers: RegExp[];
	hasFilters: boolean;
}

interface SearchIndexKeyOptions {
	rootPath: string;
	includeHidden: boolean;
}

interface InternalContentMatch {
	absolutePath: string;
	relativePath: string;
	name: string;
	line: number;
	column: number;
	preview: string;
}

export interface SearchPatchEvent {
	kind: "create" | "update" | "delete" | "rename";
	absolutePath: string;
	oldAbsolutePath?: string;
	isDirectory: boolean;
}

export interface SearchFilesOptions {
	rootPath: string;
	query: string;
	includeHidden?: boolean;
	includePattern?: string;
	excludePattern?: string;
	limit?: number;
	/**
	 * Absolute paths that are currently open in the editor. Matches receive a
	 * large score boost so the user's current context floats to the top,
	 * matching VSCode's Quick Open behavior.
	 */
	openFilePaths?: string[];
	/**
	 * Absolute paths ordered most-recent-first. Matches receive a recency boost
	 * plus a tiebreaker by list position, like VSCode's MRU weighting.
	 */
	recentFilePaths?: string[];
	/**
	 * Optional ripgrep runner override. When omitted, the platform `rg` binary
	 * is invoked. A fast-glob fallback kicks in if ripgrep is unavailable.
	 */
	runRipgrep?: (
		args: string[],
		options: RunRipgrepOptions,
	) => Promise<{ stdout: string }>;
	/** Abort signal used to interrupt long scoring loops. */
	signal?: AbortSignal;
}

export interface WarmupSearchIndexOptions {
	rootPath: string;
	includeHidden?: boolean;
	runRipgrep?: (
		args: string[],
		options: RunRipgrepOptions,
	) => Promise<{ stdout: string }>;
}

export interface RunRipgrepOptions {
	cwd: string;
	maxBuffer: number;
	signal?: AbortSignal;
}

export interface SearchContentOptions {
	rootPath: string;
	query: string;
	includeHidden?: boolean;
	includePattern?: string;
	excludePattern?: string;
	limit?: number;
	isRegex?: boolean;
	caseSensitive?: boolean;
	runRipgrep?: (
		args: string[],
		options: RunRipgrepOptions,
	) => Promise<{ stdout: string }>;
}

export interface ReplaceContentOptions {
	rootPath: string;
	query: string;
	replacement: string;
	includeHidden?: boolean;
	includePattern?: string;
	excludePattern?: string;
	isRegex?: boolean;
	caseSensitive?: boolean;
	paths?: string[];
}

interface CompiledSearchPattern {
	isRegex: boolean;
	caseSensitive: boolean;
	regex: RegExp;
}

interface LineSearchMatch {
	index: number;
	length: number;
}

const searchIndexCache = new Map<string, FileSearchCacheEntry>();
const searchIndexBuilds = new Map<string, Promise<FileSearchIndex>>();
const searchIndexVersions = new Map<string, number>();

function createSearchIndexEntry(
	rootPath: string,
	relativePath: string,
): SearchIndexEntry {
	const normalizedRelativePath = normalizePathForGlob(relativePath);
	const absolutePath = normalizeAbsolutePath(
		path.join(rootPath, normalizedRelativePath),
	);
	const name = path.basename(normalizedRelativePath);
	const dir = normalizedRelativePath.slice(0, -(name.length + 1));

	return {
		absolutePath,
		relativePath: normalizedRelativePath,
		name,
		description: dir || undefined,
	};
}

function createFileSearchIndex(items: SearchIndexEntry[]): FileSearchIndex {
	return { items };
}

function getSearchCacheKey({
	rootPath,
	includeHidden,
}: SearchIndexKeyOptions): string {
	return `${normalizeAbsolutePath(rootPath)}::${includeHidden ? "hidden" : "visible"}`;
}

function getSearchIndexVersion(cacheKey: string): number {
	return searchIndexVersions.get(cacheKey) ?? 0;
}

function advanceSearchIndexVersion(cacheKey: string): number {
	const nextVersion = getSearchIndexVersion(cacheKey) + 1;
	searchIndexVersions.set(cacheKey, nextVersion);
	return nextVersion;
}

function parseGlobPatterns(input: string): string[] {
	return input
		.split(",")
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)
		.map((pattern) => (pattern.startsWith("!") ? pattern.slice(1) : pattern))
		.filter((pattern) => pattern.length > 0);
}

function normalizePathForGlob(input: string): string {
	let normalized = input.replace(/\\/g, "/");
	if (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	if (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}
	return normalized;
}

function normalizeGlobPattern(pattern: string): string {
	let normalized = normalizePathForGlob(pattern);
	if (normalized.endsWith("/")) {
		normalized = `${normalized}**`;
	}
	if (!normalized.includes("/")) {
		normalized = `**/${normalized}`;
	}
	return normalized;
}

function escapeRegexCharacter(character: string): string {
	return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	const normalizedPattern = normalizeGlobPattern(pattern);
	let regex = "^";

	for (let index = 0; index < normalizedPattern.length; ) {
		const char = normalizedPattern[index];
		if (!char) {
			break;
		}

		if (char === "*") {
			const isDoubleStar = normalizedPattern[index + 1] === "*";
			if (isDoubleStar) {
				if (normalizedPattern[index + 2] === "/") {
					regex += "(?:.*/)?";
					index += 3;
				} else {
					regex += ".*";
					index += 2;
				}
				continue;
			}
			regex += "[^/]*";
			index += 1;
			continue;
		}

		if (char === "?") {
			regex += "[^/]";
			index += 1;
			continue;
		}

		if (char === "/") {
			regex += "\\/";
			index += 1;
			continue;
		}

		regex += escapeRegexCharacter(char);
		index += 1;
	}

	regex += "$";
	return new RegExp(regex);
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveCaseSensitive(
	query: string,
	caseSensitive: boolean | undefined,
	isRegex: boolean,
): boolean {
	if (caseSensitive !== undefined) {
		return caseSensitive;
	}

	if (isRegex) {
		return true;
	}

	return /[A-Z]/.test(query);
}

function compileSearchPattern({
	query,
	isRegex = false,
	caseSensitive,
}: Pick<
	SearchContentOptions,
	"query" | "isRegex" | "caseSensitive"
>): CompiledSearchPattern {
	const resolvedCaseSensitive = resolveCaseSensitive(
		query,
		caseSensitive,
		isRegex,
	);
	const flags = resolvedCaseSensitive ? "gu" : "giu";
	const source = isRegex ? query : escapeRegExp(query);

	return {
		isRegex,
		caseSensitive: resolvedCaseSensitive,
		regex: new RegExp(source, flags),
	};
}

function collectLineSearchMatches(
	line: string,
	pattern: CompiledSearchPattern,
): LineSearchMatch[] {
	const matches: LineSearchMatch[] = [];
	const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
	let result = regex.exec(line);

	while (result) {
		const matchText = result[0] ?? "";
		const matchLength = matchText.length > 0 ? matchText.length : 1;
		matches.push({
			index: result.index,
			length: matchLength,
		});

		if (matchText.length === 0) {
			regex.lastIndex += 1;
		}

		result = regex.exec(line);
	}

	return matches;
}

function countMatchesInText(
	text: string,
	pattern: CompiledSearchPattern,
): number {
	let count = 0;
	const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
	let result = regex.exec(text);

	while (result) {
		count += 1;
		const matchText = result[0] ?? "";
		if (matchText.length === 0) {
			regex.lastIndex += 1;
		}
		result = regex.exec(text);
	}

	return count;
}

function replaceTextContent(
	text: string,
	pattern: CompiledSearchPattern,
	replacement: string,
): string {
	const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
	return text.replace(regex, replacement);
}

const defaultIgnoreMatchers = DEFAULT_IGNORE_PATTERNS.map(globToRegExp);

function createPathFilterMatcher({
	includePattern,
	excludePattern,
}: {
	includePattern: string;
	excludePattern: string;
}): PathFilterMatcher {
	const includeMatchers = parseGlobPatterns(includePattern).map(globToRegExp);
	const excludeMatchers = parseGlobPatterns(excludePattern).map(globToRegExp);

	return {
		includeMatchers,
		excludeMatchers,
		hasFilters: includeMatchers.length > 0 || excludeMatchers.length > 0,
	};
}

function matchesPathFilters(
	relativePath: string,
	matcher: PathFilterMatcher,
): boolean {
	if (!matcher.hasFilters) {
		return true;
	}

	const normalizedPath = normalizePathForGlob(relativePath);
	if (
		matcher.includeMatchers.length > 0 &&
		!matcher.includeMatchers.some((regex) => regex.test(normalizedPath))
	) {
		return false;
	}

	if (matcher.excludeMatchers.some((regex) => regex.test(normalizedPath))) {
		return false;
	}

	return true;
}

interface BuildSearchIndexOptions extends SearchIndexKeyOptions {
	runRipgrep?: SearchFilesOptions["runRipgrep"];
}

async function listFilesWithRipgrep({
	rootPath,
	includeHidden,
	runRipgrep,
}: {
	rootPath: string;
	includeHidden: boolean;
	runRipgrep: NonNullable<SearchFilesOptions["runRipgrep"]>;
}): Promise<string[] | null> {
	const args = ["--files", "--null", "--no-messages", "--follow=false"];
	if (includeHidden) {
		// Match VSCode's "show hidden/ignored" behavior: when the caller
		// explicitly opts into hidden files, drop both dotfile and gitignore
		// filtering so users can reach every file on disk.
		args.push("--hidden", "--no-ignore");
	}
	// Even when gitignore is respected, always prune version-control metadata
	// and node_modules so the index stays bounded on huge monorepos.
	for (const pattern of DEFAULT_IGNORE_PATTERNS) {
		args.push("--glob", `!${pattern}`);
	}

	try {
		const { stdout } = await runRipgrep(args, {
			cwd: rootPath,
			maxBuffer: FILE_LISTING_RIPGREP_BUFFER_BYTES,
		});
		return stdout
			.split("\0")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	} catch (error) {
		const err = error as NodeJS.ErrnoException & {
			code?: string | number | null;
		};
		// ENOENT: ripgrep binary missing. Any other failure also falls back
		// because we prefer degraded-but-working results over a broken search.
		if (err.code === "ENOENT") {
			return null;
		}
		const exitCode =
			typeof err.code === "number"
				? err.code
				: typeof err.code === "string" && /^\d+$/.test(err.code)
					? Number.parseInt(err.code, 10)
					: null;
		// Exit 1 means "no files" which is still a legitimate result.
		if (exitCode === 1) {
			return [];
		}
		return null;
	}
}

async function listFilesWithFastGlob({
	rootPath,
	includeHidden,
}: {
	rootPath: string;
	includeHidden: boolean;
}): Promise<string[]> {
	return await fg("**/*", {
		cwd: rootPath,
		onlyFiles: true,
		dot: includeHidden,
		followSymbolicLinks: false,
		unique: true,
		suppressErrors: true,
		ignore: includeHidden ? DEFAULT_IGNORE_PATTERNS : FALLBACK_IGNORE_PATTERNS,
	});
}

async function buildSearchIndex({
	rootPath,
	includeHidden,
	runRipgrep,
}: BuildSearchIndexOptions): Promise<FileSearchIndex> {
	const normalizedRootPath = normalizeAbsolutePath(rootPath);
	const runner = runRipgrep ?? defaultRunRipgrep;

	let entries = await listFilesWithRipgrep({
		rootPath: normalizedRootPath,
		includeHidden,
		runRipgrep: runner,
	});
	if (!entries) {
		entries = await listFilesWithFastGlob({
			rootPath: normalizedRootPath,
			includeHidden,
		});
	}

	const items: SearchIndexEntry[] = entries.map((relativePath) =>
		createSearchIndexEntry(normalizedRootPath, relativePath),
	);

	return createFileSearchIndex(items);
}

async function getSearchIndex(
	options: BuildSearchIndexOptions,
): Promise<FileSearchIndex> {
	const cacheKey = getSearchCacheKey(options);
	const cached = searchIndexCache.get(cacheKey);
	const now = Date.now();
	const inFlight = searchIndexBuilds.get(cacheKey);

	if (cached && now - cached.builtAt < SEARCH_INDEX_TTL_MS) {
		return cached.index;
	}

	if (cached && !inFlight) {
		const buildVersion = getSearchIndexVersion(cacheKey);
		const buildPromise = buildSearchIndex(options)
			.then((index) => {
				if (getSearchIndexVersion(cacheKey) === buildVersion) {
					searchIndexCache.set(cacheKey, { index, builtAt: Date.now() });
				}
				searchIndexBuilds.delete(cacheKey);
				return index;
			})
			.catch((error) => {
				searchIndexBuilds.delete(cacheKey);
				throw error;
			});
		searchIndexBuilds.set(cacheKey, buildPromise);
		return cached.index;
	}

	if (cached) {
		return cached.index;
	}

	if (inFlight) {
		return await inFlight;
	}

	const buildVersion = getSearchIndexVersion(cacheKey);
	const buildPromise = buildSearchIndex(options)
		.then((index) => {
			if (getSearchIndexVersion(cacheKey) === buildVersion) {
				searchIndexCache.set(cacheKey, { index, builtAt: Date.now() });
			}
			searchIndexBuilds.delete(cacheKey);
			return index;
		})
		.catch((error) => {
			searchIndexBuilds.delete(cacheKey);
			throw error;
		});
	searchIndexBuilds.set(cacheKey, buildPromise);

	return await buildPromise;
}

function safeSearchLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(limit ?? 20, MAX_SEARCH_RESULTS));
}

function isBinaryContent(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
	for (let index = 0; index < checkLength; index++) {
		if (buffer[index] === 0) {
			return true;
		}
	}
	return false;
}

function formatPreviewLine(line: string): string {
	const normalized = line.trim();
	if (!normalized) {
		return "";
	}
	if (normalized.length <= MAX_PREVIEW_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

function rankContentMatches(
	matches: InternalContentMatch[],
	_query: string,
	limit: number,
	_isRegex = false,
): InternalContentMatch[] {
	if (matches.length === 0) {
		return [];
	}

	return matches.slice(0, safeSearchLimit(limit));
}

async function defaultRunRipgrep(
	args: string[],
	options: RunRipgrepOptions,
): Promise<{ stdout: string }> {
	const result = await execFileAsync("rg", args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer,
		windowsHide: true,
		signal: options.signal,
	});

	return { stdout: result.stdout };
}

async function searchContentWithRipgrep({
	rootPath,
	query,
	includeHidden,
	includePattern,
	excludePattern,
	limit,
	isRegex,
	caseSensitive,
	useSmartCase,
	runRipgrep,
}: Required<Omit<SearchContentOptions, "runRipgrep">> & {
	useSmartCase: boolean;
	runRipgrep: NonNullable<SearchContentOptions["runRipgrep"]>;
}): Promise<InternalContentMatch[]> {
	const prevController = activeSearchControllers.get(rootPath);
	if (prevController) {
		prevController.abort();
	}
	const controller = new AbortController();
	activeSearchControllers.set(rootPath, controller);

	const safeLimit = safeSearchLimit(limit);
	const maxCandidates = safeLimit * KEYWORD_SEARCH_CANDIDATE_MULTIPLIER;
	const args = [
		"--json",
		"--line-number",
		"--column",
		"--no-messages",
		"--max-filesize",
		`${Math.floor(MAX_KEYWORD_FILE_SIZE_BYTES / 1024)}K`,
		"--max-count",
		String(KEYWORD_SEARCH_MAX_COUNT_PER_FILE),
	];

	if (isRegex) {
		if (caseSensitive) {
			args.push("--case-sensitive");
		} else {
			args.push("--ignore-case");
		}
	} else {
		if (caseSensitive) {
			args.push("--case-sensitive");
		} else if (useSmartCase) {
			args.push("--smart-case");
		} else {
			args.push("--ignore-case");
		}
		args.push("--fixed-strings");
	}

	if (includeHidden) {
		args.push("--hidden", "--no-ignore");
	}

	for (const pattern of DEFAULT_IGNORE_PATTERNS) {
		args.push("--glob", `!${pattern}`);
	}

	for (const pattern of parseGlobPatterns(includePattern)) {
		args.push("--glob", normalizePathForGlob(pattern));
	}

	for (const pattern of parseGlobPatterns(excludePattern)) {
		args.push("--glob", `!${normalizePathForGlob(pattern)}`);
	}

	args.push(query, ".");

	try {
		const { stdout } = await runRipgrep(args, {
			cwd: normalizeAbsolutePath(rootPath),
			maxBuffer: KEYWORD_SEARCH_RIPGREP_BUFFER_BYTES,
			signal: controller.signal,
		});
		const matches: InternalContentMatch[] = [];
		const seen = new Set<string>();
		const lines = stdout.split(/\r?\n/);

		for (const rawLine of lines) {
			if (!rawLine || matches.length >= maxCandidates) {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(rawLine);
			} catch {
				continue;
			}

			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("type" in parsed) ||
				parsed.type !== "match" ||
				!("data" in parsed)
			) {
				continue;
			}

			const data = parsed.data;
			if (typeof data !== "object" || data === null) {
				continue;
			}

			const pathData = "path" in data ? data.path : null;
			const relativePath =
				typeof pathData === "object" &&
				pathData !== null &&
				"text" in pathData &&
				typeof pathData.text === "string"
					? pathData.text
					: null;

			if (!relativePath) {
				continue;
			}

			const lineNumber =
				"line_number" in data && typeof data.line_number === "number"
					? data.line_number
					: 1;

			const linesData = "lines" in data ? data.lines : null;
			const lineText =
				typeof linesData === "object" &&
				linesData !== null &&
				"text" in linesData &&
				typeof linesData.text === "string"
					? linesData.text
					: "";

			const submatches = "submatches" in data ? data.submatches : null;
			let column = 1;
			if (Array.isArray(submatches) && submatches.length > 0) {
				const firstSubmatch = submatches[0];
				if (
					typeof firstSubmatch === "object" &&
					firstSubmatch !== null &&
					"start" in firstSubmatch &&
					typeof firstSubmatch.start === "number"
				) {
					column = firstSubmatch.start + 1;
				}
			}

			const absolutePath = path.join(
				normalizeAbsolutePath(rootPath),
				relativePath,
			);
			const id = `${absolutePath}:${lineNumber}:${column}`;
			if (seen.has(id)) {
				continue;
			}
			seen.add(id);

			matches.push({
				absolutePath,
				relativePath,
				name: path.basename(relativePath),
				line: lineNumber,
				column,
				preview: formatPreviewLine(lineText.replace(/\r?\n$/, "")),
			});
		}

		if (activeSearchControllers.get(rootPath) === controller) {
			activeSearchControllers.delete(rootPath);
		}

		return rankContentMatches(matches, query, safeLimit, isRegex);
	} catch (error) {
		if (activeSearchControllers.get(rootPath) === controller) {
			activeSearchControllers.delete(rootPath);
		}

		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}

		const err = error as NodeJS.ErrnoException & {
			code?: string | number | null;
		};
		const exitCode =
			typeof err.code === "number"
				? err.code
				: typeof err.code === "string" && /^\d+$/.test(err.code)
					? Number.parseInt(err.code, 10)
					: null;
		if (exitCode === 1) {
			return [];
		}
		throw error;
	}
}

async function searchContentWithScan({
	index,
	query,
	pattern,
	pathMatcher,
	limit,
}: {
	index: FileSearchIndex;
	query: string;
	pattern: CompiledSearchPattern;
	pathMatcher: PathFilterMatcher;
	limit: number;
}): Promise<InternalContentMatch[]> {
	const safeLimit = safeSearchLimit(limit);
	const maxCandidates = safeLimit * KEYWORD_SEARCH_CANDIDATE_MULTIPLIER;
	const matches: InternalContentMatch[] = [];

	for (const item of index.items) {
		if (matches.length >= maxCandidates) {
			break;
		}
		if (!matchesPathFilters(item.relativePath, pathMatcher)) {
			continue;
		}

		try {
			const stats = await fs.stat(item.absolutePath);
			if (
				!stats.isFile() ||
				stats.size === 0 ||
				stats.size > MAX_KEYWORD_FILE_SIZE_BYTES
			) {
				continue;
			}

			const buffer = await fs.readFile(item.absolutePath);
			if (isBinaryContent(buffer)) {
				continue;
			}

			const lines = buffer.toString("utf8").split(/\r?\n/);
			for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
				if (matches.length >= maxCandidates) {
					break;
				}

				const line = lines[lineIndex] ?? "";
				for (const match of collectLineSearchMatches(line, pattern)) {
					if (matches.length >= maxCandidates) {
						break;
					}
					matches.push({
						absolutePath: item.absolutePath,
						relativePath: item.relativePath,
						name: item.name,
						line: lineIndex + 1,
						column: match.index + 1,
						preview: formatPreviewLine(line),
					});
				}
			}
		} catch {}
	}

	return rankContentMatches(matches, query, safeLimit, pattern.isRegex);
}

function isHiddenRelativePath(relativePath: string): boolean {
	return normalizePathForGlob(relativePath)
		.split("/")
		.some((segment) => segment.startsWith(".") && segment.length > 1);
}

function shouldIndexRelativePath(
	relativePath: string,
	includeHidden: boolean,
): boolean {
	const normalizedPath = normalizePathForGlob(relativePath);
	if (!includeHidden && isHiddenRelativePath(normalizedPath)) {
		return false;
	}

	return !defaultIgnoreMatchers.some((matcher) => matcher.test(normalizedPath));
}

function applySearchPatchEvent({
	itemsByPath,
	rootPath,
	includeHidden,
	event,
}: {
	itemsByPath: Map<string, SearchIndexEntry>;
	rootPath: string;
	includeHidden: boolean;
	event: SearchPatchEvent;
}): void {
	if (event.kind === "rename" && event.oldAbsolutePath) {
		itemsByPath.delete(normalizeAbsolutePath(event.oldAbsolutePath));
		const nextRelativePath = toRelativePath(rootPath, event.absolutePath);
		if (
			event.isDirectory ||
			!shouldIndexRelativePath(nextRelativePath, includeHidden)
		) {
			return;
		}

		const nextAbsolutePath = normalizeAbsolutePath(event.absolutePath);
		itemsByPath.set(
			nextAbsolutePath,
			createSearchIndexEntry(rootPath, nextRelativePath),
		);
		return;
	}

	const absolutePath = normalizeAbsolutePath(event.absolutePath);
	const relativePath = toRelativePath(rootPath, absolutePath);
	const shouldRemove =
		event.kind === "delete" ||
		event.isDirectory ||
		!shouldIndexRelativePath(relativePath, includeHidden);

	if (shouldRemove) {
		itemsByPath.delete(absolutePath);
		return;
	}

	itemsByPath.set(absolutePath, createSearchIndexEntry(rootPath, relativePath));
}

export function invalidateSearchIndex(options: SearchIndexKeyOptions): void {
	const cacheKey = getSearchCacheKey(options);
	advanceSearchIndexVersion(cacheKey);
	searchIndexCache.delete(cacheKey);
	searchIndexBuilds.delete(cacheKey);
}

export function invalidateSearchIndexesForRoot(rootPath: string): void {
	for (const includeHidden of [true, false]) {
		invalidateSearchIndex({ rootPath, includeHidden });
	}
}

export function invalidateAllSearchIndexes(): void {
	for (const cacheKey of new Set([
		...searchIndexCache.keys(),
		...searchIndexBuilds.keys(),
		...searchIndexVersions.keys(),
	])) {
		advanceSearchIndexVersion(cacheKey);
	}
	searchIndexCache.clear();
	searchIndexBuilds.clear();
}

export function patchSearchIndexesForRoot(
	rootPath: string,
	events: SearchPatchEvent[],
): void {
	if (events.length === 0) {
		return;
	}

	if (events.some((event) => event.isDirectory)) {
		invalidateSearchIndexesForRoot(rootPath);
		return;
	}

	const normalizedRootPath = normalizeAbsolutePath(rootPath);

	for (const includeHidden of [true, false]) {
		const cacheKey = getSearchCacheKey({
			rootPath: normalizedRootPath,
			includeHidden,
		});
		const cached = searchIndexCache.get(cacheKey);
		const hasInFlightBuild = searchIndexBuilds.has(cacheKey);
		if (!cached && !hasInFlightBuild) {
			continue;
		}

		advanceSearchIndexVersion(cacheKey);
		searchIndexBuilds.delete(cacheKey);

		if (!cached) {
			continue;
		}

		const nextItemsByPath = new Map(
			cached.index.items.map((item) => [item.absolutePath, item]),
		);
		for (const event of events) {
			applySearchPatchEvent({
				itemsByPath: nextItemsByPath,
				rootPath: normalizedRootPath,
				includeHidden,
				event,
			});
		}
		const nextItems = Array.from(nextItemsByPath.values());

		searchIndexCache.set(cacheKey, {
			index: createFileSearchIndex(nextItems),
			builtAt: Date.now(),
		});
	}
}

const searchEntryAccessor: IItemAccessor<SearchIndexEntry> = {
	getItemLabel(item) {
		return item.name;
	},
	getItemDescription(item) {
		return item.description;
	},
	getItemPath(item) {
		return item.relativePath;
	},
};

function buildRecencyLookup(paths: readonly string[] | undefined): {
	has: (absolutePath: string) => boolean;
	indexOf: (absolutePath: string) => number;
} {
	if (!paths || paths.length === 0) {
		return {
			has: () => false,
			indexOf: () => -1,
		};
	}
	const lookup = new Map<string, number>();
	for (let index = 0; index < paths.length; index++) {
		const entry = paths[index];
		if (typeof entry === "string" && entry.length > 0) {
			const normalized = normalizeAbsolutePath(entry);
			if (!lookup.has(normalized)) {
				lookup.set(normalized, index);
			}
		}
	}
	return {
		has: (absolutePath: string) => lookup.has(absolutePath),
		indexOf: (absolutePath: string) => lookup.get(absolutePath) ?? -1,
	};
}

export async function warmupSearchIndex(
	options: WarmupSearchIndexOptions,
): Promise<void> {
	await getSearchIndex({
		rootPath: options.rootPath,
		includeHidden: options.includeHidden ?? false,
		runRipgrep: options.runRipgrep,
	});
}

export async function searchFiles({
	rootPath,
	query,
	includeHidden = false,
	includePattern = "",
	excludePattern = "",
	limit = 20,
	openFilePaths,
	recentFilePaths,
	runRipgrep,
	signal,
}: SearchFilesOptions): Promise<FsSearchMatch[]> {
	const trimmedQuery = query.trim().replace(/^\.\//, "");
	if (!trimmedQuery) {
		return [];
	}

	// Replace any in-flight scoring loop for the same workspace so renderer
	// keystrokes don't pile up on a large index. We don't reuse the
	// caller-supplied signal directly because multiple concurrent queries on
	// the same root should still interrupt each other.
	const normalizedRootPath = normalizeAbsolutePath(rootPath);
	const prevController = activeFileSearchControllers.get(normalizedRootPath);
	prevController?.abort();
	const controller = new AbortController();
	activeFileSearchControllers.set(normalizedRootPath, controller);
	const onExternalAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", onExternalAbort, { once: true });
		}
	}

	const cleanup = () => {
		signal?.removeEventListener("abort", onExternalAbort);
		if (activeFileSearchControllers.get(normalizedRootPath) === controller) {
			activeFileSearchControllers.delete(normalizedRootPath);
		}
	};

	try {
		const index = await getSearchIndex({
			rootPath: normalizedRootPath,
			includeHidden,
			runRipgrep,
		});
		if (controller.signal.aborted) {
			return [];
		}

		const pathMatcher = createPathFilterMatcher({
			includePattern,
			excludePattern,
		});
		const safeLimit = safeSearchLimit(limit);

		const searchableItems = pathMatcher.hasFilters
			? index.items.filter((item) =>
					matchesPathFilters(item.relativePath, pathMatcher),
				)
			: index.items;

		if (searchableItems.length === 0) {
			return [];
		}

		const openLookup = buildRecencyLookup(openFilePaths);
		const recentLookup = buildRecencyLookup(recentFilePaths);

		// VS Code fuzzy scorer covers exact + fuzzy in one unified pass. Score
		// additions below implement Quick Open's MRU/open-file boost: currently
		// open files float up the most, then recently viewed files, with MRU
		// position used as the tiebreaker between otherwise-equal scores.
		const prepared = prepareQuery(trimmedQuery);
		const cache: FuzzyScorerCache = {};

		type ScoredMatch = {
			item: SearchIndexEntry;
			baseScore: number;
			boostedScore: number;
			recencyIndex: number;
		};
		const scored: ScoredMatch[] = [];

		for (let index2 = 0; index2 < searchableItems.length; index2++) {
			if (
				index2 > 0 &&
				index2 % SCORE_YIELD_INTERVAL === 0 &&
				controller.signal.aborted
			) {
				return [];
			}

			const item = searchableItems[index2];
			if (!item) {
				continue;
			}

			const itemScore = scoreItemFuzzy(
				item,
				prepared,
				true,
				searchEntryAccessor,
				cache,
			);
			if (itemScore.score <= 0) {
				continue;
			}

			let boosted = itemScore.score;
			if (openLookup.has(item.absolutePath)) {
				boosted += OPEN_FILE_SCORE_BOOST;
			}
			const recencyIndex = recentLookup.indexOf(item.absolutePath);
			if (recencyIndex >= 0) {
				boosted += MRU_SCORE_BOOST;
			}

			scored.push({
				item,
				baseScore: itemScore.score,
				boostedScore: boosted,
				recencyIndex,
			});
		}

		if (controller.signal.aborted) {
			return [];
		}

		scored.sort((a, b) => {
			if (a.boostedScore !== b.boostedScore) {
				return b.boostedScore - a.boostedScore;
			}
			// Recency tiebreaker: lower index (more recent) wins, unseen (-1)
			// always loses to a listed entry.
			if (a.recencyIndex !== b.recencyIndex) {
				if (a.recencyIndex < 0) {
					return 1;
				}
				if (b.recencyIndex < 0) {
					return -1;
				}
				return a.recencyIndex - b.recencyIndex;
			}
			return compareItemsByFuzzyScore(
				a.item,
				b.item,
				prepared,
				true,
				searchEntryAccessor,
				cache,
			);
		});

		return scored.slice(0, safeLimit).map((result) => ({
			absolutePath: result.item.absolutePath,
			relativePath: result.item.relativePath,
			name: result.item.name,
			kind: "file" as const,
			score: result.boostedScore,
		}));
	} finally {
		cleanup();
	}
}

export async function searchContent({
	rootPath,
	query,
	includeHidden = true,
	includePattern = "",
	excludePattern = "",
	limit = 20,
	isRegex = false,
	caseSensitive,
	runRipgrep = defaultRunRipgrep,
}: SearchContentOptions): Promise<FsContentMatch[]> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return [];
	}

	let internalMatches: InternalContentMatch[];
	try {
		const pattern = compileSearchPattern({
			query: trimmedQuery,
			isRegex,
			caseSensitive,
		});

		internalMatches = await searchContentWithRipgrep({
			rootPath,
			query: trimmedQuery,
			includeHidden,
			includePattern,
			excludePattern,
			limit,
			isRegex,
			caseSensitive: pattern.caseSensitive,
			useSmartCase: !isRegex && caseSensitive === undefined,
			runRipgrep,
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return [];
		}

		const pattern = compileSearchPattern({
			query: trimmedQuery,
			isRegex,
			caseSensitive,
		});
		const index = await getSearchIndex({
			rootPath,
			includeHidden,
		});
		const pathMatcher = createPathFilterMatcher({
			includePattern,
			excludePattern,
		});

		internalMatches = await searchContentWithScan({
			index,
			query: trimmedQuery,
			pattern,
			pathMatcher,
			limit,
		});
	}

	return internalMatches.map(
		({ absolutePath, relativePath, line, column, preview }) => ({
			absolutePath,
			relativePath,
			line,
			column,
			preview,
		}),
	);
}

export async function replaceContent({
	rootPath,
	query,
	replacement,
	includeHidden = true,
	includePattern = "",
	excludePattern = "",
	isRegex = false,
	caseSensitive,
	paths,
}: ReplaceContentOptions): Promise<FsReplaceContentResult> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return {
			replacements: 0,
			filesUpdated: 0,
			updated: [],
			conflicts: [],
			failed: [],
		};
	}

	const normalizedRootPath = normalizeAbsolutePath(rootPath);
	const pattern = compileSearchPattern({
		query: trimmedQuery,
		isRegex,
		caseSensitive,
	});
	const index = await getSearchIndex({
		rootPath: normalizedRootPath,
		includeHidden,
	});
	const pathMatcher = createPathFilterMatcher({
		includePattern,
		excludePattern,
	});
	const allowedPaths =
		paths && paths.length > 0
			? new Set(
					paths
						.map((item) => normalizeAbsolutePath(item))
						.filter((item) => isPathWithinRoot(normalizedRootPath, item)),
				)
			: null;
	const candidates = index.items.filter((item) => {
		if (!matchesPathFilters(item.relativePath, pathMatcher)) {
			return false;
		}
		if (allowedPaths) {
			return allowedPaths.has(item.absolutePath);
		}
		return true;
	});

	const updated: FsReplaceContentResult["updated"] = [];
	const conflicts: FsReplaceContentResult["conflicts"] = [];
	const failed: FsReplaceContentResult["failed"] = [];
	let replacementCount = 0;

	for (const candidate of candidates) {
		try {
			const readResult = await readFsFile({
				rootPath: normalizedRootPath,
				absolutePath: candidate.absolutePath,
				maxBytes: MAX_KEYWORD_FILE_SIZE_BYTES,
			});
			if (readResult.kind !== "bytes" || readResult.exceededLimit) {
				continue;
			}

			const buffer = Buffer.from(readResult.content);
			if (isBinaryContent(buffer)) {
				continue;
			}

			const content = buffer.toString("utf8");
			const matchesInFile = countMatchesInText(content, pattern);
			if (matchesInFile === 0) {
				continue;
			}

			const nextContent = replaceTextContent(content, pattern, replacement);
			if (nextContent === content) {
				continue;
			}

			const writeResult = await writeFsFile({
				rootPath: normalizedRootPath,
				absolutePath: candidate.absolutePath,
				content: nextContent,
				encoding: "utf-8",
				precondition: { ifMatch: readResult.revision },
			});

			if (!writeResult.ok) {
				if (writeResult.reason === "conflict") {
					conflicts.push({
						absolutePath: candidate.absolutePath,
						relativePath: candidate.relativePath,
						currentRevision: writeResult.currentRevision,
					});
					continue;
				}

				failed.push({
					absolutePath: candidate.absolutePath,
					relativePath: candidate.relativePath,
					message: `Replace failed: ${writeResult.reason}`,
				});
				continue;
			}

			replacementCount += matchesInFile;
			updated.push({
				absolutePath: candidate.absolutePath,
				relativePath: candidate.relativePath,
				replacements: matchesInFile,
				revision: writeResult.revision,
			});
		} catch (error) {
			failed.push({
				absolutePath: candidate.absolutePath,
				relativePath: candidate.relativePath,
				message:
					error instanceof Error
						? error.message
						: "Replace failed unexpectedly",
			});
		}
	}

	return {
		replacements: replacementCount,
		filesUpdated: updated.length,
		updated,
		conflicts,
		failed,
	};
}
