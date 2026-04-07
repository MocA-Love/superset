import { JSONFilePreset } from "lowdb/node";
import {
	APP_STATE_PATH,
	ensureSupersetHomeDirExists,
} from "../app-environment";
import type { AppState } from "./schemas";
import { defaultAppState } from "./schemas";

type AppStateDB = Awaited<ReturnType<typeof JSONFilePreset<AppState>>>;

let _appState: AppStateDB | null = null;

function isMissingPathError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function withWriteRetry(appStateDb: AppStateDB): AppStateDB {
	const originalWrite = appStateDb.write.bind(appStateDb);

	appStateDb.write = async () => {
		// The Superset home directory can disappear after startup. Recreate it before
		// each write and retry once on ENOENT so app-state persistence self-heals.
		ensureSupersetHomeDirExists();

		try {
			await originalWrite();
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}

			ensureSupersetHomeDirExists();
			await originalWrite();
		}
	};

	return appStateDb;
}

/**
 * Ensures loaded data has the correct shape by merging with defaults.
 * Handles legacy app-state.json files that may have a different structure
 * (e.g., from old electron-store format with keys like "tabs-storage").
 */
function ensureValidShape(data: Partial<AppState>): AppState {
	return {
		tabsState: {
			...defaultAppState.tabsState,
			...(data.tabsState ?? {}),
		},
		themeState: {
			...defaultAppState.themeState,
			...(data.themeState ?? {}),
		},
		hotkeysState: {
			...defaultAppState.hotkeysState,
			...(data.hotkeysState ?? {}),
			byPlatform: {
				...defaultAppState.hotkeysState.byPlatform,
				...(data.hotkeysState?.byPlatform ?? {}),
			},
		},
	};
}

export async function initAppState(): Promise<void> {
	if (_appState) return;

	ensureSupersetHomeDirExists();
	_appState = withWriteRetry(
		await JSONFilePreset<AppState>(APP_STATE_PATH, defaultAppState),
	);

	// Reshape data to ensure it has the correct structure (handles legacy formats)
	_appState.data = ensureValidShape(_appState.data);

	console.log(`App state initialized at: ${APP_STATE_PATH}`);
}

export const appState = new Proxy({} as AppStateDB, {
	get(_target, prop) {
		if (!_appState) {
			throw new Error("App state not initialized. Call initAppState() first.");
		}
		const value = _appState[prop as keyof AppStateDB];
		// Bind methods to the real instance to preserve correct `this` context
		if (typeof value === "function") {
			return value.bind(_appState);
		}
		return value;
	},
});
