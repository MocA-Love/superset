import type {
	shell as electronShell,
	systemPreferences as electronSystemPreferences,
} from "electron";
import {
	MEDIA_ACCESS_SETTINGS_URLS,
	requestMediaAccess,
} from "lib/electron/request-media-access";
import { checkFullDiskAccess } from "./full-disk-access";

export const PERMISSION_SETTINGS_URLS = {
	fullDiskAccess:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
	accessibility:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	microphone: MEDIA_ACCESS_SETTINGS_URLS.microphone,
	camera: MEDIA_ACCESS_SETTINGS_URLS.camera,
	appleEvents:
		"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
	localNetwork:
		"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork",
} as const;

type ShellApi = Pick<typeof electronShell, "openExternal">;
type SystemPreferencesApi = Pick<
	typeof electronSystemPreferences,
	"askForMediaAccess" | "getMediaAccessStatus" | "isTrustedAccessibilityClient"
>;

function getElectronShell(): ShellApi {
	return (require("electron") as Partial<typeof import("electron")>)
		.shell as ShellApi;
}

function getElectronSystemPreferences(): SystemPreferencesApi | undefined {
	return (require("electron") as Partial<typeof import("electron")>)
		.systemPreferences;
}

export function checkAccessibility({
	systemPreferencesApi = getElectronSystemPreferences(),
}: {
	systemPreferencesApi?: Pick<
		SystemPreferencesApi,
		"isTrustedAccessibilityClient"
	>;
} = {}): boolean {
	return systemPreferencesApi?.isTrustedAccessibilityClient(false) ?? false;
}

function checkMediaPermission(
	kind: "microphone" | "camera",
	{
		systemPreferencesApi = getElectronSystemPreferences(),
	}: {
		systemPreferencesApi?: Pick<SystemPreferencesApi, "getMediaAccessStatus">;
	} = {},
): boolean {
	try {
		return systemPreferencesApi?.getMediaAccessStatus(kind) === "granted";
	} catch {
		return false;
	}
}

export function checkMicrophone(options?: {
	systemPreferencesApi?: Pick<SystemPreferencesApi, "getMediaAccessStatus">;
}): boolean {
	return checkMediaPermission("microphone", options);
}

export function checkCamera(options?: {
	systemPreferencesApi?: Pick<SystemPreferencesApi, "getMediaAccessStatus">;
}): boolean {
	return checkMediaPermission("camera", options);
}

export function getPermissionStatus() {
	return {
		fullDiskAccess: checkFullDiskAccess(),
		accessibility: checkAccessibility(),
		microphone: checkMicrophone(),
		camera: checkCamera(),
	};
}

export async function requestFullDiskAccess({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.fullDiskAccess);
}

export async function requestAccessibility({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.accessibility);
}

type RequestMediaPermissionOptions = {
	shellApi?: ShellApi;
	systemPreferencesApi?: Pick<
		SystemPreferencesApi,
		"askForMediaAccess" | "getMediaAccessStatus"
	>;
};

export async function requestMicrophone(
	options: RequestMediaPermissionOptions = {},
) {
	return requestMediaAccess("microphone", options);
}

export async function requestCamera(
	options: RequestMediaPermissionOptions = {},
) {
	return requestMediaAccess("camera", options);
}

export async function requestAppleEvents({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.appleEvents);
}

export async function requestLocalNetwork({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.localNetwork);
}
