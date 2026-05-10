import { observable } from "@trpc/server/observable";
import {
	type BrowserActionEvent,
	menuEmitter,
	type OpenSettingsEvent,
	type OpenWorkspaceEvent,
	type SettingsSection,
} from "main/lib/menu-events";
import type { BrowserShortcutAction } from "shared/browser-shortcuts";
import { publicProcedure, router } from "..";

type MenuEvent =
	| { type: "open-settings"; data: OpenSettingsEvent }
	| { type: "open-workspace"; data: OpenWorkspaceEvent }
	| { type: "browser-action"; data: BrowserActionEvent }
	| { type: "open-project" };

export const createMenuRouter = () => {
	return router({
		subscribe: publicProcedure.subscription(() => {
			return observable<MenuEvent>((emit) => {
				const onOpenSettings = (section?: SettingsSection) => {
					emit.next({ type: "open-settings", data: { section } });
				};

				const onOpenWorkspace = (workspaceId: string) => {
					emit.next({ type: "open-workspace", data: { workspaceId } });
				};

				const onBrowserAction = (action: BrowserShortcutAction) => {
					emit.next({ type: "browser-action", data: { action } });
				};

				const onOpenProject = () => {
					emit.next({ type: "open-project" });
				};

				menuEmitter.on("open-settings", onOpenSettings);
				menuEmitter.on("open-workspace", onOpenWorkspace);
				menuEmitter.on("browser-action", onBrowserAction);
				menuEmitter.on("open-project", onOpenProject);

				return () => {
					menuEmitter.off("open-settings", onOpenSettings);
					menuEmitter.off("open-workspace", onOpenWorkspace);
					menuEmitter.off("browser-action", onBrowserAction);
					menuEmitter.off("open-project", onOpenProject);
				};
			});
		}),
	});
};
