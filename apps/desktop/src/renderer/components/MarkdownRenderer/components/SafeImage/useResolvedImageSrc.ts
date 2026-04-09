import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { resolveTrustedMemoImagePath } from "renderer/lib/workspace-memos";
import { getImageMimeType } from "shared/file-types";
import { useTrustedImageContext } from "./TrustedImageContext";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

interface ResolvedImageState {
	isBlocked: boolean;
	isLoading: boolean;
	src?: string;
}

export function useResolvedImageSrc(
	source: string | undefined,
): ResolvedImageState {
	const { trustedImageRootPath, workspaceId } = useTrustedImageContext();

	const trimmedSource = source?.trim();
	const dataUrl = trimmedSource?.toLowerCase().startsWith("data:")
		? trimmedSource
		: undefined;

	const trustedAbsolutePath = useMemo(() => {
		if (!trimmedSource || dataUrl || !trustedImageRootPath) {
			return null;
		}

		return resolveTrustedMemoImagePath(trustedImageRootPath, trimmedSource);
	}, [dataUrl, trimmedSource, trustedImageRootPath]);

	const mimeType = useMemo(() => {
		if (!trustedAbsolutePath) {
			return null;
		}
		return getImageMimeType(trustedAbsolutePath);
	}, [trustedAbsolutePath]);

	const imageQuery = electronTrpc.filesystem.readFile.useQuery(
		{
			workspaceId: workspaceId ?? "",
			absolutePath: trustedAbsolutePath ?? "",
			maxBytes: MAX_IMAGE_SIZE,
		},
		{
			enabled: Boolean(workspaceId && trustedAbsolutePath && mimeType),
			retry: false,
			refetchOnWindowFocus: false,
			staleTime: Infinity,
		},
	);

	if (dataUrl) {
		return {
			isBlocked: false,
			isLoading: false,
			src: dataUrl,
		};
	}

	if (!trimmedSource || !trustedAbsolutePath || !mimeType) {
		return {
			isBlocked: true,
			isLoading: false,
		};
	}

	if (imageQuery.isLoading) {
		return {
			isBlocked: false,
			isLoading: true,
		};
	}

	if (imageQuery.error || !imageQuery.data || imageQuery.data.exceededLimit) {
		return {
			isBlocked: true,
			isLoading: false,
		};
	}

	return {
		isBlocked: false,
		isLoading: false,
		src: `data:${mimeType};base64,${imageQuery.data.content}`,
	};
}
