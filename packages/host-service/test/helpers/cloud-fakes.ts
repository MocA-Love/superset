import { randomUUID } from "node:crypto";
import type { FakeApiOverrides } from "./fakes";

interface CloudWorkspace {
	id: string;
	projectId: string;
	branch: string;
	name: string;
	type?: "main" | "feature";
}

export const cloudOk = {
	hostEnsure:
		(machineId = "test-machine-1") =>
		() => ({ machineId }),

	workspaceCreate:
		(overrides: Partial<CloudWorkspace> = {}) =>
		(input: unknown): CloudWorkspace => {
			const i = input as { branch: string; name: string; projectId: string };
			return {
				id: randomUUID(),
				projectId: i.projectId,
				branch: i.branch,
				name: i.name,
				...overrides,
			};
		},

	workspaceDelete: () => () => ({ success: true }),

	workspaceGetFromHost:
		(workspace: { type?: "main" | "feature" } = { type: "feature" }) =>
		() =>
			workspace,

	v2ProjectFindByGitHubRemote:
		(candidates: Array<{ id: string; name: string }> = []) =>
		() => ({ candidates }),
};

export const cloudFlows = {
	workspaceCreateOk(overrides: Partial<CloudWorkspace> = {}): FakeApiOverrides {
		return {
			"host.ensure.mutate": cloudOk.hostEnsure(),
			"v2Workspace.create.mutate": cloudOk.workspaceCreate(overrides),
		};
	},

	workspaceDeleteOk(
		options: { type?: "main" | "feature" } = { type: "feature" },
	): FakeApiOverrides {
		return {
			"v2Workspace.getFromHost.query": cloudOk.workspaceGetFromHost(options),
			"v2Workspace.delete.mutate": cloudOk.workspaceDelete(),
		};
	},
};
