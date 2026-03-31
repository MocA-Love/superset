import type {
	ChangedFile,
	CommitGraphData,
	GitChangesStatus,
} from "shared/changes-types";

export interface GitTaskPayloadMap {
	getStatus: {
		worktreePath: string;
		defaultBranch: string;
	};
	getCommitFiles: {
		worktreePath: string;
		commitHash: string;
	};
	getCommitGraph: {
		worktreePath: string;
		maxCount?: number;
	};
}

export interface GitTaskResultMap {
	getStatus: GitChangesStatus;
	getCommitFiles: ChangedFile[];
	getCommitGraph: CommitGraphData;
}

export type GitTaskType = keyof GitTaskPayloadMap;
