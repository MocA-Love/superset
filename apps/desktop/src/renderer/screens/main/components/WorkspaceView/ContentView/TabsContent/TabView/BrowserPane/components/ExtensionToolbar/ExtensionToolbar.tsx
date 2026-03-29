import { electronTrpc } from "renderer/lib/electron-trpc";
import { ExtensionIcon } from "./components/ExtensionIcon";

export function ExtensionToolbar() {
	const { data: extensions } =
		electronTrpc.extensions.listToolbarExtensions.useQuery(undefined, {
			// Re-fetch when window regains focus (e.g. after installing an extension in settings)
			refetchOnWindowFocus: true,
		});

	if (!extensions || extensions.length === 0) return null;

	return (
		<div className="flex items-center gap-0.5">
			{extensions.map((ext) => (
				<ExtensionIcon key={ext.id} extension={ext} />
			))}
		</div>
	);
}
