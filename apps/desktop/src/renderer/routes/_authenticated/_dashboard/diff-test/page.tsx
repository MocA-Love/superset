import { createFileRoute } from "@tanstack/react-router";
import { DiffTestPage } from "./DiffTestPage";

// biome-ignore lint/suspicious/noExplicitAny: route registered after dev server starts
export const Route = createFileRoute(
	"/_authenticated/_dashboard/diff-test" as any,
)({
	component: DiffTestPage,
});
