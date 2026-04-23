/**
 * Minimal glob-to-regexp utilities for the VS Code workspace shim.
 * Handles the subset of glob syntax that VS Code extensions commonly use:
 * `*`, `**`, `?`, `[...]`, and `{a,b}` brace expansion.
 */

export function normalizeGlobPath(value: string): string {
	return value.split("/").join("/");
}

export function escapeRegexLiteral(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
	let source = "^";

	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];

		if (char === "\\") {
			const next = glob[index + 1];
			if (next) {
				source += escapeRegexLiteral(next);
				index += 1;
			} else {
				source += "\\\\";
			}
			continue;
		}

		if (char === "*") {
			if (glob[index + 1] === "*") {
				while (glob[index + 1] === "*") {
					index += 1;
				}
				if (glob[index + 1] === "/") {
					source += "(?:.*/)?";
					index += 1;
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			continue;
		}

		if (char === "[") {
			const closingIndex = glob.indexOf("]", index + 1);
			if (closingIndex === -1) {
				source += "\\[";
			} else {
				source += glob.slice(index, closingIndex + 1);
				index = closingIndex;
			}
			continue;
		}

		source += escapeRegexLiteral(char);
	}

	source += "$";
	return new RegExp(source);
}

export function findFirstBraceRange(
	pattern: string,
): { start: number; end: number; body: string } | null {
	let braceStart = -1;
	let depth = 0;

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "{") {
			if (depth === 0) {
				braceStart = index;
			}
			depth += 1;
			continue;
		}
		if (char === "}") {
			if (depth === 0 || braceStart < 0) {
				continue;
			}
			depth -= 1;
			if (depth === 0) {
				return {
					start: braceStart,
					end: index,
					body: pattern.slice(braceStart + 1, index),
				};
			}
		}
	}

	return null;
}

export function splitBraceOptions(body: string): string[] {
	const options: string[] = [];
	let depth = 0;
	let current = "";

	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char === "\\") {
			current += char;
			if (index + 1 < body.length) {
				current += body[index + 1];
				index += 1;
			}
			continue;
		}
		if (char === "{") {
			depth += 1;
			current += char;
			continue;
		}
		if (char === "}") {
			depth = Math.max(0, depth - 1);
			current += char;
			continue;
		}
		if (char === "," && depth === 0) {
			options.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	options.push(current);
	return options;
}

export function expandBracePatterns(pattern: string): string[] {
	const braceRange = findFirstBraceRange(pattern);
	if (!braceRange) {
		return [pattern];
	}

	const prefix = pattern.slice(0, braceRange.start);
	const suffix = pattern.slice(braceRange.end + 1);
	const options = splitBraceOptions(braceRange.body);

	return options.flatMap((option) =>
		expandBracePatterns(`${prefix}${option}${suffix}`),
	);
}

export function compileGlobPatterns(pattern: string | null | undefined): string[] {
	if (!pattern) {
		return [];
	}

	const normalized = pattern.trim();
	if (!normalized) {
		return [];
	}

	return expandBracePatterns(normalized)
		.map((entry) => normalizeGlobPath(entry.trim()))
		.filter(Boolean);
}

export function compileGlobMatchers(pattern: string | null | undefined): RegExp[] {
	return compileGlobPatterns(pattern).map((entry) => globToRegExp(entry));
}

export function matchesAnyGlob(matchers: RegExp[], targetPath: string): boolean {
	if (matchers.length === 0) {
		return false;
	}

	const normalizedTarget = normalizeGlobPath(targetPath);
	return matchers.some((matcher) => matcher.test(normalizedTarget));
}

export function splitGlobSegments(pattern: string): string[] {
	return normalizeGlobPath(pattern)
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean);
}

export function hasGlobMeta(segment: string): boolean {
	let escaped = false;

	for (const char of segment) {
		if (!escaped && char === "\\") {
			escaped = true;
			continue;
		}
		if (!escaped && (char === "*" || char === "?" || char === "[")) {
			return true;
		}
		escaped = false;
	}

	return false;
}

export function getStaticGlobPrefixSegments(pattern: string): string[] {
	const prefix: string[] = [];

	for (const segment of splitGlobSegments(pattern)) {
		if (segment === "**" || hasGlobMeta(segment)) {
			break;
		}
		prefix.push(segment);
	}

	return prefix;
}

export function directoryMayContainMatches(
	relativeDirectory: string,
	includePatterns: string[],
): boolean {
	if (includePatterns.length === 0) {
		return true;
	}

	const directorySegments = splitGlobSegments(relativeDirectory);

	return includePatterns.some((pattern) => {
		const prefixSegments = getStaticGlobPrefixSegments(pattern);
		if (prefixSegments.length === 0) {
			return true;
		}

		const commonLength = Math.min(
			directorySegments.length,
			prefixSegments.length,
		);
		for (let index = 0; index < commonLength; index += 1) {
			if (directorySegments[index] !== prefixSegments[index]) {
				return false;
			}
		}

		return true;
	});
}
