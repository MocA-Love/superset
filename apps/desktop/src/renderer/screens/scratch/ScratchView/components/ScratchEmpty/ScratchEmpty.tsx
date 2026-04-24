import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

interface ScratchEmptyProps {
	redirectToWorkspaceOnEmpty?: boolean;
}

/**
 * Q1:B — scratch tabs do not persist. Closing the last tab redirects the user
 * back to the normal workspace entry point so the UI never sits in a blank
 * scratch state between sessions.
 */
export function ScratchEmpty({
	redirectToWorkspaceOnEmpty = true,
}: ScratchEmptyProps) {
	const navigate = useNavigate();
	useEffect(() => {
		if (!redirectToWorkspaceOnEmpty) return;
		navigate({ to: "/workspace", replace: true });
	}, [navigate, redirectToWorkspaceOnEmpty]);

	// Empty placeholder: effect above fires synchronously on mount to redirect,
	// so we render nothing visible to avoid a one-frame flash.
	return <div className="h-full" aria-hidden />;
}
