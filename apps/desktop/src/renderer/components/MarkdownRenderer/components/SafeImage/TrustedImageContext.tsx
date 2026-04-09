import { createContext, type PropsWithChildren, useContext } from "react";

interface TrustedImageContextValue {
	workspaceId?: string;
	trustedImageRootPath?: string | null;
}

const TrustedImageContext = createContext<TrustedImageContextValue>({});

export function TrustedImageProvider({
	children,
	trustedImageRootPath,
	workspaceId,
}: PropsWithChildren<TrustedImageContextValue>) {
	return (
		<TrustedImageContext.Provider value={{ workspaceId, trustedImageRootPath }}>
			{children}
		</TrustedImageContext.Provider>
	);
}

export function useTrustedImageContext(): TrustedImageContextValue {
	return useContext(TrustedImageContext);
}
