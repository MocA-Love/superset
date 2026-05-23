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

export type SupersetConfig = {
	auth?: {
		accessToken: string;
		expiresAt: number;
	};
	apiUrl?: string;
	organizationId?: string;
};

export type DeviceConfig = {
	deviceId: string;
	deviceName: string;
};

export const SUPERSET_HOME_DIR = join(homedir(), "superset");
export const SUPERSET_CONFIG_PATH = join(SUPERSET_HOME_DIR, "config.json");
const DEVICE_PATH = join(SUPERSET_HOME_DIR, "device.json");

function ensureDir() {
	if (!existsSync(SUPERSET_HOME_DIR)) {
		mkdirSync(SUPERSET_HOME_DIR, { recursive: true, mode: 0o700 });
	}
}

export function readConfig(): SupersetConfig {
	if (!existsSync(SUPERSET_CONFIG_PATH)) return {};
	try {
		const stat = statSync(SUPERSET_CONFIG_PATH);
		if ((stat.mode & 0o077) !== 0) chmodSync(SUPERSET_CONFIG_PATH, 0o600);
	} catch {}
	return JSON.parse(readFileSync(SUPERSET_CONFIG_PATH, "utf-8"));
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
	if (!existsSync(DEVICE_PATH)) return null;
	return JSON.parse(readFileSync(DEVICE_PATH, "utf-8"));
}

export function getApiUrl(config: SupersetConfig): string {
	return config.apiUrl ?? "https://api.superset.sh";
}
