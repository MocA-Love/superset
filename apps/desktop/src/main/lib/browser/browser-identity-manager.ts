import { session } from "electron";

const APP_BROWSER_PARTITION = "persist:superset";

function getChromeVersion(): string {
	return process.versions.chrome ?? "140.0.0.0";
}

function getChromeMajorVersion(): string {
	return getChromeVersion().split(".")[0] ?? "140";
}

function getChromeLikeUserAgent(userAgent: string): string {
	return userAgent.replace(/\sElectron\/[^\s]+/g, "").trim();
}

function getClientHintPlatform(): string {
	switch (process.platform) {
		case "darwin":
			return "macOS";
		case "win32":
			return "Windows";
		default:
			return "Linux";
	}
}

function setHeader(
	headers: Record<string, string | string[]>,
	name: string,
	value: string,
): void {
	const existingKey = Object.keys(headers).find(
		(headerName) => headerName.toLowerCase() === name.toLowerCase(),
	);
	if (existingKey) {
		headers[existingKey] = value;
		return;
	}

	headers[name] = value;
}

let initialized = false;

export function initializeBrowserIdentityManager(): void {
	if (initialized) {
		return;
	}

	initialized = true;

	const browserSession = session.fromPartition(APP_BROWSER_PARTITION);
	const chromeVersion = getChromeVersion();
	const chromeMajorVersion = getChromeMajorVersion();
	const clientHintPlatform = getClientHintPlatform();
	const secChUa = `"Google Chrome";v="${chromeMajorVersion}", "Chromium";v="${chromeMajorVersion}", "Not_A Brand";v="24"`;
	const secChUaFullVersionList = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not_A Brand";v="24.0.0.0"`;

	browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
		const headers = { ...details.requestHeaders };
		const originalUserAgent =
			headers["User-Agent"] ??
			headers["user-agent"] ??
			`Mozilla/5.0 Chrome/${chromeVersion}`;

		setHeader(headers, "User-Agent", getChromeLikeUserAgent(originalUserAgent));
		setHeader(headers, "Sec-CH-UA", secChUa);
		setHeader(headers, "Sec-CH-UA-Mobile", "?0");
		setHeader(headers, "Sec-CH-UA-Platform", `"${clientHintPlatform}"`);
		setHeader(headers, "Sec-CH-UA-Full-Version", `"${chromeVersion}"`);
		setHeader(headers, "Sec-CH-UA-Full-Version-List", secChUaFullVersionList);

		callback({ requestHeaders: headers });
	});
}
