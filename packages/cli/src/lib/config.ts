import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "./env";

export type SupersetConfig = {
	auth?: {
		accessToken: string;
		refreshToken?: string;
		expiresAt: number;
	};
	apiKey?: string;
	apiUrl?: string;
	organizationId?: string;
};

export type DeviceConfig = {
	deviceId: string;
	deviceName: string;
};

export const LEGACY_SUPERSET_HOME_DIR = join(homedir(), "superset");
export const SUPERSET_HOME_DIR =
	process.env.SUPERSET_HOME_DIR ?? join(homedir(), ".superset");
export const SUPERSET_CONFIG_PATH = join(SUPERSET_HOME_DIR, "config.json");
const LEGACY_CONFIG_PATH = join(LEGACY_SUPERSET_HOME_DIR, "config.json");
const DEVICE_PATH = join(SUPERSET_HOME_DIR, "device.json");
const LEGACY_DEVICE_PATH = join(LEGACY_SUPERSET_HOME_DIR, "device.json");

function canReadLegacyHome(): boolean {
	return (
		!process.env.SUPERSET_HOME_DIR &&
		LEGACY_SUPERSET_HOME_DIR !== SUPERSET_HOME_DIR
	);
}

function ensureDir() {
	if (!existsSync(SUPERSET_HOME_DIR)) {
		mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
	}
	try {
		const stat = statSync(SUPERSET_HOME_DIR);
		if ((stat.mode & 0o077) !== 0) chmodSync(SUPERSET_HOME_DIR, 0o700);
	} catch {}
}

function readableConfigPath(): string | null {
	if (existsSync(SUPERSET_CONFIG_PATH)) return SUPERSET_CONFIG_PATH;
	if (canReadLegacyHome() && existsSync(LEGACY_CONFIG_PATH)) {
		return LEGACY_CONFIG_PATH;
	}
	return null;
}

export function getAuthConfigPath(): string {
	return readableConfigPath() ?? SUPERSET_CONFIG_PATH;
}

export function readConfig(): SupersetConfig {
	const configPath = readableConfigPath();
	if (!configPath) return {};
	try {
		const stat = statSync(configPath);
		if ((stat.mode & 0o077) !== 0) chmodSync(configPath, 0o600);
	} catch {}
	return JSON.parse(readFileSync(configPath, "utf-8"));
}

export function writeConfig(config: SupersetConfig): void {
	ensureDir();
	const tempPath = join(
		SUPERSET_HOME_DIR,
		`.${randomUUID()}.${process.pid}.config.tmp`,
	);
	writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
	try {
		chmodSync(tempPath, 0o600);
	} catch {}
	try {
		renameSync(tempPath, SUPERSET_CONFIG_PATH);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {}
		throw error;
	}
	try {
		chmodSync(SUPERSET_CONFIG_PATH, 0o600);
	} catch {}
}

export function readDeviceConfig(): DeviceConfig | null {
	if (existsSync(DEVICE_PATH)) {
		return JSON.parse(readFileSync(DEVICE_PATH, "utf-8"));
	}
	if (canReadLegacyHome() && existsSync(LEGACY_DEVICE_PATH)) {
		return JSON.parse(readFileSync(LEGACY_DEVICE_PATH, "utf-8"));
	}
	return null;
}

export function getApiUrl(config: SupersetConfig): string {
	return config.apiUrl ?? env.SUPERSET_API_URL;
}
