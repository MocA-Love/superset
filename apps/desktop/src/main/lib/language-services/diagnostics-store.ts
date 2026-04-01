import { EventEmitter } from "node:events";
import type {
	LanguageServiceDiagnostic,
	LanguageServiceWorkspaceSnapshot,
} from "./types";

const MAX_PROBLEMS = 500;

function diagnosticSortValue(severity: string): number {
	switch (severity) {
		case "error":
			return 0;
		case "warning":
			return 1;
		case "info":
			return 2;
		default:
			return 3;
	}
}

type WorkspaceDiagnostics = Map<string, LanguageServiceDiagnostic[]>;

export class LanguageDiagnosticsStore {
	private readonly workspaces = new Map<string, WorkspaceDiagnostics>();

	private readonly versions = new Map<string, number>();

	private readonly emitter = new EventEmitter();

	setFileDiagnostics(
		workspaceId: string,
		fileKey: string,
		diagnostics: LanguageServiceDiagnostic[],
	): void {
		const workspaceDiagnostics =
			this.workspaces.get(workspaceId) ??
			new Map<string, LanguageServiceDiagnostic[]>();
		workspaceDiagnostics.set(fileKey, diagnostics);
		this.workspaces.set(workspaceId, workspaceDiagnostics);
		this.bump(workspaceId);
	}

	clearFileDiagnostics(workspaceId: string, fileKey: string): void {
		const workspaceDiagnostics = this.workspaces.get(workspaceId);
		if (!workspaceDiagnostics) {
			return;
		}

		if (!workspaceDiagnostics.delete(fileKey)) {
			return;
		}

		if (workspaceDiagnostics.size === 0) {
			this.workspaces.delete(workspaceId);
		}

		this.bump(workspaceId);
	}

	clearWorkspace(workspaceId: string): void {
		if (!this.workspaces.delete(workspaceId)) {
			return;
		}

		this.bump(workspaceId);
	}

	clearProviderDiagnostics(providerId: string, workspaceId?: string): void {
		const fileKeyPrefix = `${providerId}::`;
		const targetWorkspaceIds = workspaceId
			? [workspaceId]
			: Array.from(this.workspaces.keys());

		for (const targetWorkspaceId of targetWorkspaceIds) {
			const workspaceDiagnostics = this.workspaces.get(targetWorkspaceId);
			if (!workspaceDiagnostics) {
				continue;
			}

			let changed = false;
			for (const fileKey of Array.from(workspaceDiagnostics.keys())) {
				if (!fileKey.startsWith(fileKeyPrefix)) {
					continue;
				}

				workspaceDiagnostics.delete(fileKey);
				changed = true;
			}

			if (!changed) {
				continue;
			}

			if (workspaceDiagnostics.size === 0) {
				this.workspaces.delete(targetWorkspaceId);
			}

			this.bump(targetWorkspaceId);
		}
	}

	getVersion(workspaceId: string): number {
		return this.versions.get(workspaceId) ?? 0;
	}

	subscribe(
		workspaceId: string,
		listener: (payload: { version: number }) => void,
	) {
		const eventName = this.eventName(workspaceId);
		this.emitter.on(eventName, listener);
		return () => {
			this.emitter.off(eventName, listener);
		};
	}

	createSnapshot(args: {
		workspaceId: string;
		workspacePath: string;
		providers: LanguageServiceWorkspaceSnapshot["providers"];
	}): LanguageServiceWorkspaceSnapshot {
		const flattened = Array.from(
			this.workspaces.get(args.workspaceId)?.values() ?? [],
		)
			.flat()
			.sort((left, right) => {
				const severityDelta =
					diagnosticSortValue(left.severity) -
					diagnosticSortValue(right.severity);
				if (severityDelta !== 0) {
					return severityDelta;
				}

				const pathDelta = (left.relativePath ?? "").localeCompare(
					right.relativePath ?? "",
				);
				if (pathDelta !== 0) {
					return pathDelta;
				}

				const lineDelta = (left.line ?? 0) - (right.line ?? 0);
				if (lineDelta !== 0) {
					return lineDelta;
				}

				return (left.column ?? 0) - (right.column ?? 0);
			});

		const problems = flattened.slice(0, MAX_PROBLEMS);
		return {
			status: "ready",
			workspaceId: args.workspaceId,
			workspacePath: args.workspacePath,
			providers: args.providers,
			problems,
			totalCount: flattened.length,
			truncated: flattened.length > problems.length,
			summary: {
				errorCount: flattened.filter((problem) => problem.severity === "error")
					.length,
				warningCount: flattened.filter(
					(problem) => problem.severity === "warning",
				).length,
				infoCount: flattened.filter((problem) => problem.severity === "info")
					.length,
				hintCount: flattened.filter((problem) => problem.severity === "hint")
					.length,
			},
		};
	}

	private bump(workspaceId: string): void {
		const version = (this.versions.get(workspaceId) ?? 0) + 1;
		this.versions.set(workspaceId, version);
		this.emitter.emit(this.eventName(workspaceId), { version });
	}

	private eventName(workspaceId: string): string {
		return `workspace:${workspaceId}`;
	}
}

export const languageDiagnosticsStore = new LanguageDiagnosticsStore();
