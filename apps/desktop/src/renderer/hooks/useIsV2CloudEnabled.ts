import { useV2LocalOverrideStore } from "renderer/stores/v2-local-override";

const IS_DEV = process.env.NODE_ENV === "development";

/**
 * Returns effective v2 state: remote PostHog flag AND local opt-in.
 * Also returns the raw remote flag so the toggle can be shown conditionally.
 *
 * FORK NOTE: keeps the upstream-style `optInV2 === true` strict check
 * (since `optInV2` is now nullable per #4176) but preserves the fork's
 * object-shape return value with the extra `isRemoteV2Enabled` flag.
 */
export function useIsV2CloudEnabled() {
	const remoteV2Enabled =
		useFeatureFlagEnabled(FEATURE_FLAGS.V2_CLOUD) ?? false;
	const optInV2 = useV2LocalOverrideStore((s) => s.optInV2 === true);

	if (IS_DEV) {
		return {
			isV2CloudEnabled: optInV2,
			isRemoteV2Enabled: true,
		};
	}

	return {
		/** The effective value — use this wherever you previously checked the flag directly. */
		isV2CloudEnabled: remoteV2Enabled && optInV2,
		/** Whether the remote PostHog flag is on (for showing the toggle). */
		isRemoteV2Enabled: remoteV2Enabled,
	};
}
