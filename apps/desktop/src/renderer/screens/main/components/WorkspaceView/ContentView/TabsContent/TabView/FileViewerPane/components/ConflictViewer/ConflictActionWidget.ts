import { WidgetType } from "@codemirror/view";

export type ConflictResolution = "current" | "incoming" | "both";

export interface ConflictActionWidgetOptions {
	regionIndex: number;
	onResolve: (regionIndex: number, resolution: ConflictResolution) => void;
}

export class ConflictActionWidget extends WidgetType {
	constructor(private readonly options: ConflictActionWidgetOptions) {
		super();
	}

	eq(other: ConflictActionWidget): boolean {
		return other.options.regionIndex === this.options.regionIndex;
	}

	toDOM(): HTMLElement {
		const container = document.createElement("span");
		container.className = "cm-conflict-action-widget";
		container.setAttribute("aria-label", "Conflict resolution options");

		const actions: { label: string; resolution: ConflictResolution; extraClass?: string }[] = [
			{ label: "Accept Current Change", resolution: "current", extraClass: "cm-conflict-action-btn-current" },
			{ label: "Accept Incoming Change", resolution: "incoming", extraClass: "cm-conflict-action-btn-incoming" },
			{ label: "Accept Both Changes", resolution: "both" },
		];

		for (let i = 0; i < actions.length; i++) {
			const action = actions[i];
			if (!action) continue;

			if (i > 0) {
				const sep = document.createElement("span");
				sep.className = "cm-conflict-action-separator";
				sep.textContent = "|";
				container.appendChild(sep);
			}

			const btn = document.createElement("span");
			btn.className = `cm-conflict-action-btn${action.extraClass ? ` ${action.extraClass}` : ""}`;
			btn.textContent = action.label;
			btn.setAttribute("role", "button");
			btn.setAttribute("tabindex", "0");

			const { resolution, regionIndex } = {
				resolution: action.resolution,
				regionIndex: this.options.regionIndex,
			};
			const { onResolve } = this.options;

			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				onResolve(regionIndex, resolution);
			});

			btn.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onResolve(regionIndex, resolution);
				}
			});

			container.appendChild(btn);
		}

		return container;
	}

	ignoreEvent(): boolean {
		return false;
	}
}
