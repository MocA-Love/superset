import { toast } from "@superset/ui/sonner";
import { useCallback, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { CreatePullRequestBaseRepoOption } from "renderer/screens/main/components/CreatePullRequestBaseRepoDialog";

interface UseCreateOrOpenPROptions {
	worktreePath?: string;
	onSuccess?: () => void;
}

interface UseCreateOrOpenPRResult {
	createOrOpenPR: () => void;
	isPending: boolean;
	baseRepoDialog: {
		open: boolean;
		options: CreatePullRequestBaseRepoOption[];
		onOpenChange: (open: boolean) => void;
		onConfirm: (repoUrl: string) => void;
	};
	openBaseRepoConfiguration: () => void;
	resetBaseRepoConfiguration: () => void;
}

export function useCreateOrOpenPR({
	worktreePath,
	onSuccess,
}: UseCreateOrOpenPROptions): UseCreateOrOpenPRResult {
	const { mutateAsync, isPending: isCreatePRPending } =
		electronTrpc.changes.createPR.useMutation();
	const {
		mutateAsync: resolveCreatePRBaseOptions,
		isPending: isResolvingOptions,
	} = electronTrpc.changes.resolveCreatePRBaseOptions.useMutation();
	const {
		mutateAsync: updatePullRequestBaseRepo,
		isPending: isUpdatingBaseRepo,
	} = electronTrpc.changes.updatePullRequestBaseRepo.useMutation();
	const [baseRepoDialogState, setBaseRepoDialogState] = useState<{
		open: boolean;
		options: CreatePullRequestBaseRepoOption[];
		mode: "create" | "configure";
	}>({
		open: false,
		options: [],
		mode: "create",
	});

	const runCreateOrOpenPR = useCallback(
		(baseRepoUrl?: string, allowOutOfDate = false) => {
			if (!worktreePath || isCreatePRPending) return;

			void (async () => {
				try {
					const result = await mutateAsync({
						worktreePath,
						allowOutOfDate,
						baseRepoUrl,
					});
					window.open(result.url, "_blank", "noopener,noreferrer");
					toast.success("Opening GitHub...");
					onSuccess?.();
					return;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					const isBehindUpstreamError = message.includes("behind upstream");
					if (!isBehindUpstreamError) {
						toast.error(`Failed: ${message}`);
						return;
					}

					const shouldContinue = window.confirm(
						`${message}\n\nCreate/open the pull request anyway?`,
					);
					if (!shouldContinue) {
						return;
					}
				}

				try {
					const result = await mutateAsync({
						worktreePath,
						allowOutOfDate: true,
						baseRepoUrl,
					});
					window.open(result.url, "_blank", "noopener,noreferrer");
					toast.success("Opening GitHub...");
					onSuccess?.();
				} catch (retryError) {
					const retryMessage =
						retryError instanceof Error
							? retryError.message
							: String(retryError);
					toast.error(`Failed: ${retryMessage}`);
				}
			})();
		},
		[isCreatePRPending, mutateAsync, onSuccess, worktreePath],
	);

	const createOrOpenPR = useCallback(() => {
		if (!worktreePath || isCreatePRPending || isResolvingOptions) return;

		void (async () => {
			try {
				const result = await resolveCreatePRBaseOptions({
					worktreePath,
				});
				if (result.requiresChoice) {
					setBaseRepoDialogState({
						open: true,
						options: result.baseRepoOptions,
						mode: "create",
					});
					return;
				}

				runCreateOrOpenPR(result.selectedBaseRepoUrl ?? undefined);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				toast.error(`Failed: ${message}`);
			}
		})();
	}, [
		isCreatePRPending,
		isResolvingOptions,
		resolveCreatePRBaseOptions,
		runCreateOrOpenPR,
		worktreePath,
	]);

	const openBaseRepoConfiguration = useCallback(() => {
		if (!worktreePath || isResolvingOptions || isUpdatingBaseRepo) return;

		void (async () => {
			try {
				const result = await resolveCreatePRBaseOptions({
					worktreePath,
				});
				if (result.baseRepoOptions.length <= 1) {
					toast.error("Only one pull request base repository is available.");
					return;
				}

				setBaseRepoDialogState({
					open: true,
					options: result.baseRepoOptions,
					mode: "configure",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				toast.error(`Failed: ${message}`);
			}
		})();
	}, [
		isResolvingOptions,
		isUpdatingBaseRepo,
		resolveCreatePRBaseOptions,
		worktreePath,
	]);

	const resetBaseRepoConfiguration = useCallback(() => {
		if (!worktreePath || isUpdatingBaseRepo) return;

		void (async () => {
			try {
				await updatePullRequestBaseRepo({
					worktreePath,
					baseRepoUrl: null,
				});
				toast.success("Pull request base repository reset");
				onSuccess?.();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				toast.error(`Failed: ${message}`);
			}
		})();
	}, [isUpdatingBaseRepo, onSuccess, updatePullRequestBaseRepo, worktreePath]);

	const isPending =
		isCreatePRPending || isResolvingOptions || isUpdatingBaseRepo;

	return {
		createOrOpenPR,
		isPending,
		baseRepoDialog: {
			open: baseRepoDialogState.open,
			options: baseRepoDialogState.options,
			onOpenChange: (open) => {
				setBaseRepoDialogState((state) => ({
					...state,
					open,
				}));
			},
			onConfirm: (repoUrl) => {
				const nextMode = baseRepoDialogState.mode;
				setBaseRepoDialogState({ open: false, options: [], mode: "create" });
				if (nextMode === "configure") {
					if (!worktreePath) {
						toast.error("Failed: workspace path is unavailable.");
						return;
					}
					void (async () => {
						try {
							await updatePullRequestBaseRepo({
								worktreePath,
								baseRepoUrl: repoUrl,
							});
							toast.success("Pull request base repository updated");
							onSuccess?.();
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							toast.error(`Failed: ${message}`);
						}
					})();
					return;
				}

				runCreateOrOpenPR(repoUrl);
			},
		},
		openBaseRepoConfiguration,
		resetBaseRepoConfiguration,
	};
}
