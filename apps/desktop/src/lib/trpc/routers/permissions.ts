import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shell, systemPreferences } from "electron";
import { requestMediaAccess } from "lib/electron/request-media-access";
import { publicProcedure, router } from "..";

function checkFullDiskAccess(): boolean {
	try {
		// Safari bookmarks are TCC-protected — readable only with Full Disk Access
		const tccProtectedPath = path.join(
			homedir(),
			"Library/Safari/Bookmarks.plist",
		);
		fs.accessSync(tccProtectedPath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function checkAccessibility(): boolean {
	return systemPreferences.isTrustedAccessibilityClient(false);
}

function checkMicrophone(): boolean {
	try {
		return systemPreferences.getMediaAccessStatus("microphone") === "granted";
	} catch {
		return false;
	}
}

function checkCamera(): boolean {
	try {
		return systemPreferences.getMediaAccessStatus("camera") === "granted";
	} catch {
		return false;
	}
}

export const createPermissionsRouter = () => {
	return router({
		getStatus: publicProcedure.query(() => {
			return {
				fullDiskAccess: checkFullDiskAccess(),
				accessibility: checkAccessibility(),
				microphone: checkMicrophone(),
				camera: checkCamera(),
			};
		}),

		requestFullDiskAccess: publicProcedure.mutation(async () => {
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
			);
		}),

		requestAccessibility: publicProcedure.mutation(async () => {
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
			);
		}),

		requestMicrophone: publicProcedure.mutation(async () => {
			return requestMediaAccess("microphone");
		}),

		requestCamera: publicProcedure.mutation(async () => {
			return requestMediaAccess("camera");
		}),

		requestAppleEvents: publicProcedure.mutation(async () => {
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
			);
		}),

		// No deep link exists for Local Network — open the general Privacy & Security pane
		requestLocalNetwork: publicProcedure.mutation(async () => {
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
			);
		}),
	});
};

export type PermissionsRouter = ReturnType<typeof createPermissionsRouter>;
