interface ProjectImportCandidate {
	source: string;
}

interface ProjectFindByPathLike<TCandidate extends ProjectImportCandidate> {
	candidates: TCandidate[];
	cloudErrors: unknown[];
}

export function getLocalPathCandidates<
	TCandidate extends ProjectImportCandidate,
>(findByPathResult: ProjectFindByPathLike<TCandidate> | undefined) {
	return (
		findByPathResult?.candidates.filter((c) => c.source === "local-path") ?? []
	);
}

export function getDefaultV1ProjectImportCandidate<
	TCandidate extends ProjectImportCandidate,
>(findByPathResult: ProjectFindByPathLike<TCandidate> | undefined) {
	return getLocalPathCandidates(findByPathResult)[0] ?? null;
}

export function shouldSkipV1ProjectImportAll<
	TCandidate extends ProjectImportCandidate,
>(findByPathResult: ProjectFindByPathLike<TCandidate>) {
	const localPathCandidateCount =
		getLocalPathCandidates(findByPathResult).length;
	if (localPathCandidateCount > 1) return true;
	return (
		localPathCandidateCount === 0 &&
		findByPathResult.candidates.length === 0 &&
		findByPathResult.cloudErrors.length > 0
	);
}

export function isProjectAlreadyImported<
	TCandidate extends ProjectImportCandidate,
>(findByPathResult: ProjectFindByPathLike<TCandidate> | undefined) {
	return getLocalPathCandidates(findByPathResult).length > 0;
}
