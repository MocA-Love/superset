import type { SitePermissionKind } from "@superset/local-db";
import { shell, systemPreferences } from "electron";

const MEDIA_ACCESS_SETTINGS_URLS: Record<SitePermissionKind, string> = {
	microphone:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
	camera:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
};

interface RequestMediaAccessResult {
	granted: boolean;
	openedSystemSettings: boolean;
}

export async function requestMediaAccess(
	kind: SitePermissionKind,
): Promise<RequestMediaAccessResult> {
	if (process.platform !== "darwin") {
		return {
			granted: true,
			openedSystemSettings: false,
		};
	}

	try {
		if (systemPreferences.getMediaAccessStatus(kind) === "granted") {
			return {
				granted: true,
				openedSystemSettings: false,
			};
		}

		const granted = await systemPreferences.askForMediaAccess(kind);
		if (granted) {
			return {
				granted: true,
				openedSystemSettings: false,
			};
		}
	} catch {
		// Fall through to opening System Settings.
	}

	await shell.openExternal(MEDIA_ACCESS_SETTINGS_URLS[kind]);
	return {
		granted: false,
		openedSystemSettings: true,
	};
}
