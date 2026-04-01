import { EventEmitter } from "node:events";
import type { BrowserShortcutAction } from "shared/browser-shortcuts";
export type SettingsSection =
	| "project"
	| "workspace"
	| "appearance"
	| "keyboard"
	| "behavior"
	| "git"
	| "terminal"
	| "integrations";

export interface OpenSettingsEvent {
	section?: SettingsSection;
}

export interface OpenWorkspaceEvent {
	workspaceId: string;
}

export interface BrowserActionEvent {
	action: BrowserShortcutAction;
}

export const menuEmitter = new EventEmitter();
