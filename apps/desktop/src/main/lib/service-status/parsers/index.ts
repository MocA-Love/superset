import type { ServiceStatusFormat } from "shared/service-status-types";
import { fetchAwsHealth } from "./aws-health";
import { fetchAzureRss } from "./azure-rss";
import { fetchGcpIncidents } from "./gcp-incidents";
import { fetchStatuspageV2 } from "./statuspage-v2";
import type { ParsedStatus } from "./types";

export type { ParsedStatus } from "./types";

/**
 * Dispatch a status fetch to the adapter that matches the definition's
 * declared format. The caller (ServiceStatusService.refreshOne) is the only
 * place that needs to know a definition has a format; everything downstream
 * reads `ParsedStatus.indicator` directly.
 *
 * All adapters throw on network / parsing errors. The caller wraps the call
 * in try/catch and converts any throw into an "unknown" snapshot.
 */
export function fetchStatusPayload(
	format: ServiceStatusFormat,
	apiUrl: string,
): Promise<ParsedStatus> {
	switch (format) {
		case "statuspage-v2":
			return fetchStatuspageV2(apiUrl);
		case "gcp-incidents":
			return fetchGcpIncidents(apiUrl);
		case "aws-health":
			return fetchAwsHealth(apiUrl);
		case "azure-rss":
			return fetchAzureRss(apiUrl);
		default: {
			// TypeScript exhaustiveness check; a runtime hit here means someone
			// added a new ServiceStatusFormat without wiring in an adapter.
			const exhaustive: never = format;
			return Promise.reject(
				new Error(
					`[service-status] No adapter registered for format "${exhaustive as string}"`,
				),
			);
		}
	}
}
