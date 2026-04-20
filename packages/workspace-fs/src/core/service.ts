import type {
	FsContentMatch,
	FsEntry,
	FsMetadata,
	FsReadResult,
	FsReplaceContentResult,
	FsSearchMatch,
	FsWatchEvent,
	FsWriteResult,
} from "../types";

export interface FsContentStreamInput {
	query: string;
	includeHidden?: boolean;
	includePattern?: string;
	excludePattern?: string;
	limit?: number;
	isRegex?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	multiline?: boolean;
	scopeId?: string;
}

export interface FsContentStreamEvent {
	match: FsContentMatch;
}

export interface FsService {
	listDirectory(input: {
		absolutePath: string;
	}): Promise<{ entries: FsEntry[] }>;

	readFile(input: {
		absolutePath: string;
		offset?: number;
		maxBytes?: number;
		encoding?: string;
	}): Promise<FsReadResult>;

	getMetadata(input: { absolutePath: string }): Promise<FsMetadata | null>;

	writeFile(input: {
		absolutePath: string;
		content: string | Uint8Array;
		encoding?: string;
		options?: { create: boolean; overwrite: boolean };
		precondition?: { ifMatch: string };
	}): Promise<FsWriteResult>;

	createDirectory(input: {
		absolutePath: string;
		recursive?: boolean;
	}): Promise<{ absolutePath: string; kind: "directory" }>;

	deletePath(input: {
		absolutePath: string;
		permanent?: boolean;
	}): Promise<{ absolutePath: string }>;

	movePath(input: {
		sourceAbsolutePath: string;
		destinationAbsolutePath: string;
	}): Promise<{ fromAbsolutePath: string; toAbsolutePath: string }>;

	copyPath(input: {
		sourceAbsolutePath: string;
		destinationAbsolutePath: string;
	}): Promise<{ fromAbsolutePath: string; toAbsolutePath: string }>;

	searchFiles(input: {
		query: string;
		includeHidden?: boolean;
		includePattern?: string;
		excludePattern?: string;
		limit?: number;
		openFilePaths?: string[];
		recentFilePaths?: string[];
		scopeId?: string;
	}): Promise<{ matches: FsSearchMatch[] }>;

	warmupSearchIndex(input: { includeHidden?: boolean }): Promise<{ ok: true }>;

	searchContent(input: {
		query: string;
		includeHidden?: boolean;
		includePattern?: string;
		excludePattern?: string;
		limit?: number;
		isRegex?: boolean;
		caseSensitive?: boolean;
		wholeWord?: boolean;
		multiline?: boolean;
		scopeId?: string;
	}): Promise<{ matches: FsContentMatch[] }>;

	replaceContent(input: {
		query: string;
		replacement: string;
		includeHidden?: boolean;
		includePattern?: string;
		excludePattern?: string;
		isRegex?: boolean;
		caseSensitive?: boolean;
		wholeWord?: boolean;
		multiline?: boolean;
		paths?: string[];
	}): Promise<FsReplaceContentResult>;

	watchPath(input: {
		absolutePath: string;
		recursive?: boolean;
	}): AsyncIterable<{ events: FsWatchEvent[] }>;

	searchContentStream(
		input: FsContentStreamInput,
	): AsyncIterable<FsContentStreamEvent>;
}

export interface FsRequestMap {
	listDirectory: {
		input: { absolutePath: string };
		output: { entries: FsEntry[] };
	};
	readFile: {
		input: {
			absolutePath: string;
			offset?: number;
			maxBytes?: number;
			encoding?: string;
		};
		output: FsReadResult;
	};
	getMetadata: {
		input: { absolutePath: string };
		output: FsMetadata | null;
	};
	writeFile: {
		input: {
			absolutePath: string;
			content: string | Uint8Array;
			encoding?: string;
			options?: { create: boolean; overwrite: boolean };
			precondition?: { ifMatch: string };
		};
		output: FsWriteResult;
	};
	createDirectory: {
		input: { absolutePath: string; recursive?: boolean };
		output: { absolutePath: string; kind: "directory" };
	};
	deletePath: {
		input: { absolutePath: string; permanent?: boolean };
		output: { absolutePath: string };
	};
	movePath: {
		input: {
			sourceAbsolutePath: string;
			destinationAbsolutePath: string;
		};
		output: { fromAbsolutePath: string; toAbsolutePath: string };
	};
	copyPath: {
		input: {
			sourceAbsolutePath: string;
			destinationAbsolutePath: string;
		};
		output: { fromAbsolutePath: string; toAbsolutePath: string };
	};
	searchFiles: {
		input: {
			query: string;
			includeHidden?: boolean;
			includePattern?: string;
			excludePattern?: string;
			limit?: number;
			openFilePaths?: string[];
			recentFilePaths?: string[];
			scopeId?: string;
		};
		output: { matches: FsSearchMatch[] };
	};
	warmupSearchIndex: {
		input: {
			includeHidden?: boolean;
		};
		output: { ok: true };
	};
	searchContent: {
		input: {
			query: string;
			includeHidden?: boolean;
			includePattern?: string;
			excludePattern?: string;
			limit?: number;
			isRegex?: boolean;
			caseSensitive?: boolean;
			wholeWord?: boolean;
			multiline?: boolean;
			scopeId?: string;
		};
		output: { matches: FsContentMatch[] };
	};
	replaceContent: {
		input: {
			query: string;
			replacement: string;
			includeHidden?: boolean;
			includePattern?: string;
			excludePattern?: string;
			isRegex?: boolean;
			caseSensitive?: boolean;
			wholeWord?: boolean;
			multiline?: boolean;
			paths?: string[];
		};
		output: FsReplaceContentResult;
	};
}

export interface FsSubscriptionMap {
	watchPath: {
		input: { absolutePath: string; recursive?: boolean };
		event: { events: FsWatchEvent[] };
	};
	searchContentStream: {
		input: FsContentStreamInput;
		event: FsContentStreamEvent;
	};
}
