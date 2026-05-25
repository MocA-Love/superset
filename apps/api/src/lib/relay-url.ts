import { FEATURE_FLAGS } from "@superset/shared/constants";
import { env } from "@/env";
import { posthog } from "@/lib/analytics";

interface RelayUrlPayload {
	url?: string;
}

/**
 * Resolve the relay base URL for a user, matching the desktop and CLI
 * relay-url override behavior.
 */
export async function getRelayUrl(userId: string): Promise<string> {
	const fallback = env.RELAY_URL;
	try {
		const payload = (await posthog.getFeatureFlagPayload(
			FEATURE_FLAGS.RELAY_URL_OVERRIDE,
			userId,
		)) as RelayUrlPayload | null | undefined;
		const override = payload?.url;
		if (typeof override === "string" && override.length > 0) {
			return override;
		}
	} catch (error) {
		console.warn("[relay-url] PostHog payload fetch failed:", error);
	}
	return fallback;
}
