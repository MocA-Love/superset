import { createFileRoute } from "@tanstack/react-router";
import { DiffTestPage } from "./DiffTestPage";

export const Route = createFileRoute(
	// biome-ignore lint/suspicious/noExplicitAny: route registered after dev server starts
	"/_authenticated/_dashboard/diff-test" as any,
)({
	component: DiffTestPage,
});
