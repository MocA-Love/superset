import { createFileRoute } from "@tanstack/react-router";
import { ExtensionsSettings } from "./components/ExtensionsSettings";

export const Route = createFileRoute(
	"/_authenticated/settings/extensions/",
)({
	component: ExtensionsSettingsPage,
});

function ExtensionsSettingsPage() {
	return <ExtensionsSettings />;
}
