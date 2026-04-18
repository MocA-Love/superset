import { createSimpleGitWithEnv } from "./simple-git";
import type { GitCredentialProvider, GitFactory } from "./types";
import { getRemoteUrl } from "./utils";

export function createGitFactory(provider: GitCredentialProvider): GitFactory {
	return async (repoPath: string) => {
		const initialCredentials = await provider.getCredentials(null);
		const git = createSimpleGitWithEnv({
			baseDir: repoPath,
			env: initialCredentials.env,
		});
		const remoteUrl = await getRemoteUrl(git);
		const credentials = await provider.getCredentials(remoteUrl);
		const env = {
			...initialCredentials.env,
			...credentials.env,
			GIT_OPTIONAL_LOCKS: "0",
		};

		return createSimpleGitWithEnv({
			baseDir: repoPath,
			env,
		});
	};
}
