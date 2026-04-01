import { Label } from "@superset/ui/label";
import { Switch } from "@superset/ui/switch";
import { useTerminalSuggestionsStore } from "renderer/stores/terminal-suggestions";

export function SuggestionsSetting() {
	const enabled = useTerminalSuggestionsStore((s) => s.enabled);
	const setEnabled = useTerminalSuggestionsStore((s) => s.setEnabled);

	return (
		<div className="flex items-center justify-between">
			<div className="space-y-0.5">
				<Label htmlFor="terminal-suggestions" className="text-sm font-medium">
					Shell history suggestions
				</Label>
				<p className="text-xs text-muted-foreground">
					Show shell history suggestions when pressing ↑ at the prompt
				</p>
			</div>
			<Switch
				id="terminal-suggestions"
				checked={enabled}
				onCheckedChange={setEnabled}
			/>
		</div>
	);
}
