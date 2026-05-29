import { describe, expect, it, mock } from "bun:test";

mock.module("electron", () => ({
	shell: {
		openExternal: mock(async () => {}),
	},
	systemPreferences: {
		askForMediaAccess: mock(async () => false),
		getMediaAccessStatus: mock(() => "not-determined"),
		isTrustedAccessibilityClient: mock(() => false),
	},
}));

const {
	checkAccessibility,
	checkCamera,
	checkMicrophone,
	PERMISSION_SETTINGS_URLS,
	requestAccessibility,
	requestAppleEvents,
	requestCamera,
	requestFullDiskAccess,
	requestLocalNetwork,
	requestMicrophone,
} = await import("./native-permissions");

function createShellRecorder() {
	const openedUrls: string[] = [];

	return {
		openedUrls,
		shellApi: {
			openExternal: async (url: string) => {
				openedUrls.push(url);
			},
		},
	};
}

function expectMediaResult(
	result: { granted: boolean; openedSystemSettings: boolean },
	openedUrls: string[],
	url: string,
	expectedOnDarwin: { granted: boolean; openedSystemSettings: boolean },
) {
	if (process.platform === "darwin") {
		expect(result).toEqual(expectedOnDarwin);
		expect(openedUrls).toEqual(
			expectedOnDarwin.openedSystemSettings ? [url] : [],
		);
		return;
	}

	expect(result).toEqual({
		granted: true,
		openedSystemSettings: false,
	});
	expect(openedUrls).toEqual([]);
}

describe("native permissions", () => {
	it("checks Accessibility with the native trusted-client API", () => {
		expect(
			checkAccessibility({
				systemPreferencesApi: {
					isTrustedAccessibilityClient: (prompt) => prompt === false,
				},
			}),
		).toBe(true);
	});

	it("checks Microphone granted status", () => {
		expect(
			checkMicrophone({
				systemPreferencesApi: {
					getMediaAccessStatus: () => "granted",
				},
			}),
		).toBe(true);

		expect(
			checkMicrophone({
				systemPreferencesApi: {
					getMediaAccessStatus: () => "denied",
				},
			}),
		).toBe(false);
	});

	it("checks Camera granted status", () => {
		expect(
			checkCamera({
				systemPreferencesApi: {
					getMediaAccessStatus: () => "granted",
				},
			}),
		).toBe(true);

		expect(
			checkCamera({
				systemPreferencesApi: {
					getMediaAccessStatus: () => "denied",
				},
			}),
		).toBe(false);
	});

	it("treats media status errors as not granted", () => {
		const systemPreferencesApi = {
			getMediaAccessStatus: () => {
				throw new Error("unavailable");
			},
		};

		expect(checkMicrophone({ systemPreferencesApi })).toBe(false);
		expect(checkCamera({ systemPreferencesApi })).toBe(false);
	});

	it("opens Full Disk Access settings", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		await requestFullDiskAccess({ shellApi });

		expect(openedUrls).toEqual([PERMISSION_SETTINGS_URLS.fullDiskAccess]);
	});

	it("opens Accessibility settings", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		await requestAccessibility({ shellApi });

		expect(openedUrls).toEqual([PERMISSION_SETTINGS_URLS.accessibility]);
	});

	it("returns granted when native Microphone access is already granted", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		const result = await requestMicrophone({
			shellApi,
			systemPreferencesApi: {
				askForMediaAccess: async () => false,
				getMediaAccessStatus: () => "granted",
			},
		});

		expect(result).toEqual({
			granted: true,
			openedSystemSettings: false,
		});
		expect(openedUrls).toEqual([]);
	});

	it("returns granted when the native Microphone prompt grants access", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		const result = await requestMicrophone({
			shellApi,
			systemPreferencesApi: {
				askForMediaAccess: async () => true,
				getMediaAccessStatus: () => "not-determined",
			},
		});

		expect(result).toEqual({
			granted: true,
			openedSystemSettings: false,
		});
		expect(openedUrls).toEqual([]);
	});

	it("opens Microphone settings when the native prompt does not grant access", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		const result = await requestMicrophone({
			shellApi,
			systemPreferencesApi: {
				askForMediaAccess: async () => false,
				getMediaAccessStatus: () => "not-determined",
			},
		});

		expectMediaResult(result, openedUrls, PERMISSION_SETTINGS_URLS.microphone, {
			granted: false,
			openedSystemSettings: true,
		});
	});

	it("opens Microphone settings when the native prompt fails", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		const result = await requestMicrophone({
			shellApi,
			systemPreferencesApi: {
				askForMediaAccess: async () => {
					throw new Error("unavailable");
				},
				getMediaAccessStatus: () => "not-determined",
			},
		});

		expectMediaResult(result, openedUrls, PERMISSION_SETTINGS_URLS.microphone, {
			granted: false,
			openedSystemSettings: true,
		});
	});

	it("opens Camera settings when the native prompt does not grant access", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		const result = await requestCamera({
			shellApi,
			systemPreferencesApi: {
				askForMediaAccess: async () => false,
				getMediaAccessStatus: () => "not-determined",
			},
		});

		expectMediaResult(result, openedUrls, PERMISSION_SETTINGS_URLS.camera, {
			granted: false,
			openedSystemSettings: true,
		});
	});

	it("opens Automation settings", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		await requestAppleEvents({ shellApi });

		expect(openedUrls).toEqual([PERMISSION_SETTINGS_URLS.appleEvents]);
	});

	it("opens Local Network settings", async () => {
		const { openedUrls, shellApi } = createShellRecorder();

		await requestLocalNetwork({ shellApi });

		expect(openedUrls).toEqual([PERMISSION_SETTINGS_URLS.localNetwork]);
	});
});
