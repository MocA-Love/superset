let platformOverride: NodeJS.Platform | null = null;
let envOverride: NodeJS.ProcessEnv | null = null;

function getPlatform(): NodeJS.Platform {
	return platformOverride ?? process.platform;
}

function getEnv(): NodeJS.ProcessEnv {
	return envOverride ?? process.env;
}

export function setWindowStateEnvironmentForTesting(
	override: {
		platform?: NodeJS.Platform;
		env?: NodeJS.ProcessEnv;
	} | null,
): void {
	platformOverride = override?.platform ?? null;
	envOverride = override?.env ?? null;
}

export function isWindowPositionPersistenceEnabled(): boolean {
	if (getPlatform() !== "linux") return true;

	const env = getEnv();
	return env.XDG_SESSION_TYPE !== "wayland" && !env.WAYLAND_DISPLAY;
}
