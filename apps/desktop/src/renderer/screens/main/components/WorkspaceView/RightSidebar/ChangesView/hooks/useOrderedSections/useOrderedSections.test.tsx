import { describe, expect, test } from "bun:test";
import React from "react";
import type {
	ChangeCategory,
	ChangedFile,
	CommitInfo,
} from "shared/changes-types";
import { useOrderedSections } from "./useOrderedSections";

// biome-ignore lint/suspicious/noExplicitAny: accessing React internals for test dispatcher setup
type ReactInternalsType = { H: unknown };
// biome-ignore lint/suspicious/noExplicitAny: accessing React internals for test dispatcher setup
const ReactInternals = (React as any)
	.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as ReactInternalsType;

/** Minimal fake dispatcher so useMemo/useCallback work outside a component. */
const fakeDispatcher: Record<string, (...args: unknown[]) => unknown> = {
	useMemo: (fn) => (fn as () => unknown)(),
	useCallback: (fn) => fn,
	useRef: (init) => ({ current: init }),
	useEffect: () => undefined,
	useState: (init) => [init, () => undefined],
	useLayoutEffect: () => undefined,
	useContext: () => undefined,
	useReducer: (_reducer, init) => [init, () => undefined],
};

function renderHook(fn: () => unknown) {
	const prev = ReactInternals.H;
	ReactInternals.H = fakeDispatcher;
	let value: unknown;
	try {
		value = fn();
	} finally {
		ReactInternals.H = prev;
	}
	return { result: { current: value } };
}

const emptyFile = (): ChangedFile => ({
	path: "src/example.ts",
	status: "modified",
	additions: 0,
	deletions: 0,
});

const emptyArgs = {
	sectionOrder: [
		"conflicted",
		"against-base",
		"committed",
		"staged",
		"unstaged",
	] satisfies ChangeCategory[],
	effectiveBaseBranch: "main",
	expandedSections: {
		conflicted: true,
		"against-base": true,
		committed: true,
		staged: true,
		unstaged: true,
	},
	toggleSection: () => {},
	fileListViewMode: "tree" as const,
	selectedFile: null,
	selectedCommitHash: null,
	worktreePath: "/tmp/repo",
	projectId: undefined,
	isExpandedView: false,
	conflictedFiles: [] as ChangedFile[],
	onConflictedFileSelect: () => {},
	againstBaseFiles: [] as ChangedFile[],
	onAgainstBaseFileSelect: () => {},
	commitsWithFiles: [] as CommitInfo[],
	expandedCommits: new Set<string>(),
	onCommitToggle: () => {},
	onCommitFileSelect: () => {},
	stagedFiles: [] as ChangedFile[],
	onStagedFileSelect: () => {},
	onUnstageFile: () => {},
	onUnstageFiles: () => {},
	onShowDiscardStagedDialog: () => {},
	onUnstageAll: () => {},
	isDiscardAllStagedPending: false,
	isUnstageAllPending: false,
	isStagedActioning: false,
	unstagedFiles: [] as ChangedFile[],
	onUnstagedFileSelect: () => {},
	onStageFile: () => {},
	onStageFiles: () => {},
	onDiscardFile: () => {},
	onShowDiscardUnstagedDialog: () => {},
	onStageAll: () => {},
	isDiscardAllUnstagedPending: false,
	isStageAllPending: false,
	isUnstagedActioning: false,
};

describe("useOrderedSections", () => {
	test("keeps the commits section visible when commit files are lazy-loaded", () => {
		const { result } = renderHook(() =>
			useOrderedSections({
				...emptyArgs,
				commitsWithFiles: [
					{
						hash: "abc123",
						shortHash: "abc123",
						message: "feat: lazy commit files",
						author: "Test User",
						date: new Date("2026-03-06T12:00:00.000Z"),
						files: [],
					},
				],
			}),
		);
		const sections = result.current;

		const committedSection = sections.find(
			(section) => section.id === "committed",
		);

		expect(committedSection).toBeDefined();
		expect(committedSection?.count).toBe(1);
	});

	test("does not change other section counts", () => {
		const { result } = renderHook(() =>
			useOrderedSections({
				...emptyArgs,
				againstBaseFiles: [emptyFile()],
				stagedFiles: [emptyFile(), emptyFile()],
				unstagedFiles: [emptyFile(), emptyFile(), emptyFile()],
			}),
		);
		const sections = result.current;

		expect(
			sections.find((section) => section.id === "against-base")?.count,
		).toBe(1);
		expect(sections.find((section) => section.id === "staged")?.count).toBe(2);
		expect(sections.find((section) => section.id === "unstaged")?.count).toBe(
			3,
		);
	});
});
