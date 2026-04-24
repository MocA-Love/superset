import type { StatuspageIndicator } from "shared/service-status-types";

/**
 * Common output shape every format adapter must return. The main service
 * layer maps `indicator` to a `ServiceStatusLevel` via `indicatorToLevel` so
 * individual parsers only have to produce the indicator string that best
 * represents the provider's current state.
 */
export interface ParsedStatus {
	indicator: StatuspageIndicator | null;
	description: string;
}
