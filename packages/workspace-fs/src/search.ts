import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import Fuse from "fuse.js";
import { readFile as readFsFile, writeFile as writeFsFile } from "./fs";
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

const activeSearchControllers = new Map<string, AbortController>();

export const DEFAULT_IGNORE_PATTERNS = [
	"**/node_modules/**",
	"**/.git/**",
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
	lowerName: string;
	lowerRelativePath: string;
	compactName: string;
	compactRelativePath: string;
}

interface FileSearchIndex {
	items: SearchIndexEntry[];
	fuse: Fuse<SearchIndexEntry>;
	itemsByLowerName: Map<string, SearchIndexEntry[]>;
	itemsByCompactName: Map<string, SearchIndexEntry[]>;
	itemsByLowerRelativePath: Map<string, SearchIndexEntry[]>;
	itemsByCompactRelativePath: Map<string, SearchIndexEntry[]>;
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

function createFileSearchFuse(
	items: SearchIndexEntry[],
): Fuse<SearchIndexEntry> {
	return new Fuse(items, {
		keys: [
			{ name: "name", weight: 2 },
			{ name: "relativePath", weight: 1 },
			{ name: "compactName", weight: 1.8 },
			{ name: "compactRelativePath", weight: 0.9 },
		],
		threshold: 0.4,
		includeScore: true,
		ignoreLocation: true,
	});
}

function normalizeSearchText(input: string): string {
	return input.toLowerCase().replace(/[\\/\s._-]+/g, "");
}

function createSearchIndexEntry(
	rootPath: string,
	relativePath: string,
): SearchIndexEntry {
	const normalizedRelativePath = normalizePathForGlob(relativePath);
	const absolutePath = normalizeAbsolutePath(
		path.join(rootPath, normalizedRelativePath),
	);
	const name = path.basename(normalizedRelativePath);
	const lowerName = name.toLowerCase();
	const lowerRelativePath = normalizedRelativePath.toLowerCase();

	return {
		absolutePath,
		relativePath: normalizedRelativePath,
		name,
		lowerName,
		lowerRelativePath,
		compactName: normalizeSearchText(name),
		compactRelativePath: normalizeSearchText(normalizedRelativePath),
	};
}

function addSearchIndexMapEntry(
	index: Map<string, SearchIndexEntry[]>,
	key: string,
	item: SearchIndexEntry,
): void {
	const existing = index.get(key);
	if (existing) {
		existing.push(item);
		return;
	}

	index.set(key, [item]);
}

function createFileSearchIndex(items: SearchIndexEntry[]): FileSearchIndex {
	const itemsByLowerName = new Map<string, SearchIndexEntry[]>();
	const itemsByCompactName = new Map<string, SearchIndexEntry[]>();
	const itemsByLowerRelativePath = new Map<string, SearchIndexEntry[]>();
	const itemsByCompactRelativePath = new Map<string, SearchIndexEntry[]>();

	for (const item of items) {
		addSearchIndexMapEntry(itemsByLowerName, item.lowerName, item);
		addSearchIndexMapEntry(itemsByCompactName, item.compactName, item);
		addSearchIndexMapEntry(
			itemsByLowerRelativePath,
			item.lowerRelativePath,
			item,
		);
		addSearchIndexMapEntry(
			itemsByCompactRelativePath,
			item.compactRelativePath,
			item,
		);
	}

	return {
		items,
		fuse: createFileSearchFuse(items),
		itemsByLowerName,
		itemsByCompactName,
		itemsByLowerRelativePath,
		itemsByCompactRelativePath,
	};
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

async function buildSearchIndex({
	rootPath,
	includeHidden,
}: SearchIndexKeyOptions): Promise<FileSearchIndex> {
	const normalizedRootPath = normalizeAbsolutePath(rootPath);
	const entries = await fg("**/*", {
		cwd: normalizedRootPath,
		onlyFiles: true,
		dot: includeHidden,
		followSymbolicLinks: false,
		unique: true,
		suppressErrors: true,
		ignore: DEFAULT_IGNORE_PATTERNS,
	});

	const items: SearchIndexEntry[] = entries.map((relativePath) =>
		createSearchIndexEntry(normalizedRootPath, relativePath),
	);

	return createFileSearchIndex(items);
}

async function getSearchIndex(
	options: SearchIndexKeyOptions,
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

function compareFileSearchMatches(
	left: { item: SearchIndexEntry; score: number },
	right: { item: SearchIndexEntry; score: number },
): number {
	if (left.score !== right.score) {
		return right.score - left.score;
	}

	if (left.item.name.length !== right.item.name.length) {
		return left.item.name.length - right.item.name.length;
	}

	if (left.item.relativePath.length !== right.item.relativePath.length) {
		return left.item.relativePath.length - right.item.relativePath.length;
	}

	return left.item.relativePath.localeCompare(right.item.relativePath);
}

function collectExactFileSearchMatches({
	index,
	query,
	pathMatcher,
	limit,
}: {
	index: FileSearchIndex;
	query: string;
	pathMatcher: PathFilterMatcher;
	limit: number;
}): Array<{ item: SearchIndexEntry; score: number }> {
	const lowerQuery = query.toLowerCase();
	const normalizedPathQuery = normalizePathForGlob(lowerQuery);
	const compactQuery = normalizeSearchText(query);
	const matchesByPath = new Map<
		string,
		{ item: SearchIndexEntry; score: number }
	>();

	const addMatches = (
		items: SearchIndexEntry[] | undefined,
		score: number,
	): void => {
		const candidates = items ?? [];

		for (const item of candidates) {
			if (
				pathMatcher.hasFilters &&
				!matchesPathFilters(item.relativePath, pathMatcher)
			) {
				continue;
			}

			const existing = matchesByPath.get(item.absolutePath);
			if (!existing || existing.score < score) {
				matchesByPath.set(item.absolutePath, { item, score });
			}
		}
	};

	addMatches(index.itemsByLowerName.get(lowerQuery), 1);
	addMatches(index.itemsByLowerRelativePath.get(normalizedPathQuery), 0.995);

	if (compactQuery.length > 0) {
		addMatches(index.itemsByCompactName.get(compactQuery), 0.99);
		addMatches(index.itemsByCompactRelativePath.get(compactQuery), 0.985);
	}

	return Array.from(matchesByPath.values())
		.sort(compareFileSearchMatches)
		.slice(0, limit);
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

export async function searchFiles({
	rootPath,
	query,
	includeHidden = false,
	includePattern = "",
	excludePattern = "",
	limit = 20,
}: SearchFilesOptions): Promise<FsSearchMatch[]> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return [];
	}

	const index = await getSearchIndex({
		rootPath,
		includeHidden,
	});
	const pathMatcher = createPathFilterMatcher({
		includePattern,
		excludePattern,
	});
	const safeLimit = safeSearchLimit(limit);

	const exactMatches = collectExactFileSearchMatches({
		index,
		query: trimmedQuery,
		pathMatcher,
		limit: safeLimit,
	});
	if (exactMatches.length > 0) {
		return exactMatches.map((result) => ({
			absolutePath: result.item.absolutePath,
			relativePath: result.item.relativePath,
			name: result.item.name,
			kind: "file" as const,
			score: result.score,
		}));
	}

	const searchableItems = pathMatcher.hasFilters
		? index.items.filter((item) =>
				matchesPathFilters(item.relativePath, pathMatcher),
			)
		: index.items;

	if (searchableItems.length === 0) {
		return [];
	}

	const fuse = pathMatcher.hasFilters
		? createFileSearchFuse(searchableItems)
		: index.fuse;
	const results = fuse.search(trimmedQuery, {
		limit: safeLimit,
	});

	return results.map((result) => ({
		absolutePath: result.item.absolutePath,
		relativePath: result.item.relativePath,
		name: result.item.name,
		kind: "file" as const,
		score: 1 - (result.score ?? 0),
	}));
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
