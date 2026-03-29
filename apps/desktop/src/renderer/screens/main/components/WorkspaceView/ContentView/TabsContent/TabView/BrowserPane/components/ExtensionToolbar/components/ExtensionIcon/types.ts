export interface ExtensionToolbarInfo {
	id: string;
	/** Electron-assigned extension ID (used for chrome-extension:// URLs) */
	electronId: string;
	name: string;
	enabled: boolean;
	hasPopup: boolean;
	popupPath: string | null;
	actionTitle: string | null;
}
