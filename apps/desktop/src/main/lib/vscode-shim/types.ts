/**
 * Shared types for the VS Code extension host shim.
 */

export interface ExtensionManifest {
	name: string;
	publisher: string;
	version: string;
	main?: string;
	activationEvents?: string[];
	contributes?: {
		commands?: Array<{
			command: string;
			title: string;
			category?: string;
			icon?: string | { light: string; dark: string };
			enablement?: string;
		}>;
		views?: Record<
			string,
			Array<{
				id: string;
				name: string;
				type?: string;
				when?: string;
			}>
		>;
		viewsContainers?: {
			activitybar?: Array<{
				id: string;
				title: string;
				icon: string;
			}>;
			panel?: Array<{
				id: string;
				title: string;
				icon: string;
			}>;
		};
		configuration?: ConfigurationSchema | ConfigurationSchema[];
		menus?: Record<
			string,
			Array<{ command: string; when?: string; group?: string }>
		>;
		keybindings?: Array<{
			command: string;
			key: string;
			mac?: string;
			when?: string;
		}>;
		jsonValidation?: Array<{ fileMatch: string; url: string }>;
		languages?: Array<{
			id: string;
			extensions?: string[];
			filenames?: string[];
		}>;
	};
	extensionDependencies?: string[];
	enabledApiProposals?: string[];
}

interface ConfigurationSchema {
	title?: string;
	properties?: Record<
		string,
		{
			type?: string;
			default?: unknown;
			description?: string;
			enum?: unknown[];
			enumDescriptions?: string[];
		}
	>;
}

export interface ExtensionInfo {
	id: string;
	extensionPath: string;
	manifest: ExtensionManifest;
	isActive: boolean;
}

export interface WebviewMessage {
	viewId: string;
	type: "html" | "message" | "title" | "options";
	data: unknown;
}
