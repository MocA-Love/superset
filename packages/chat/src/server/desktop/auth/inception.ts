import { createAuthStorage } from "mastracode";
import { INCEPTION_AUTH_PROVIDER_ID } from "./provider-ids";

interface InceptionAuthStorageLike {
	reload: () => void;
	get: (providerId: string) => unknown;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export interface InceptionCredentials {
	apiKey: string;
	providerId: typeof INCEPTION_AUTH_PROVIDER_ID;
	source: "auth-storage";
	kind: "apiKey";
}

export function getInceptionCredentialsFromAuthStorage(
	authStorage: InceptionAuthStorageLike = createAuthStorage(),
): InceptionCredentials | null {
	try {
		authStorage.reload();
		const credential = authStorage.get(INCEPTION_AUTH_PROVIDER_ID);
		if (
			isObjectRecord(credential) &&
			credential.type === "api_key" &&
			typeof credential.key === "string" &&
			credential.key.trim().length > 0
		) {
			return {
				apiKey: credential.key.trim(),
				providerId: INCEPTION_AUTH_PROVIDER_ID,
				source: "auth-storage",
				kind: "apiKey",
			};
		}
	} catch (error) {
		console.warn("[inception/auth] Failed to read auth storage:", error);
	}

	return null;
}

export function getInceptionCredentialsFromAnySource(): InceptionCredentials | null {
	return getInceptionCredentialsFromAuthStorage();
}
