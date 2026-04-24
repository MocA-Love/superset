import { createFileRoute } from "@tanstack/react-router";
import { ScratchView } from "renderer/screens/scratch/ScratchView";

/**
 * Q1:B — the scratch route intentionally carries no URL-encoded state. All
 * open file paths live in the renderer-only `useScratchTabsStore` zustand
 * store, which is NOT persisted. Reload / app restart therefore resets to an
 * empty scratch view (ScratchEmpty then redirects to /workspace).
 *
 * The main process pushes paths through IPC (`file-intake:open-scratch-batch`)
 * rather than query params, so we never leak absolute filesystem paths into
 * the persistent router history stored in localStorage.
 */
export const Route = createFileRoute("/_authenticated/_dashboard/scratch/")({
	component: ScratchPage,
});

function ScratchPage() {
	return <ScratchView />;
}
