import { CLIError } from "@superset/cli-framework";
import { getHostId } from "@superset/shared/host-info";
import { buildHostRoutingKey } from "@superset/shared/host-routing";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { ApiClient } from "../api-client";
import { isProcessAlive, readManifest } from "../host/manifest";
import { getRelayUrl } from "../host/relay-url";

export type PromptTransport = "argv" | "stdin";

export interface HostAgentConfig {
	id: string;
	presetId: string;
	label: string;
	command: string;
	args: string[];
	promptTransport: PromptTransport;
	promptArgs: string[];
	env: Record<string, string>;
	order: number;
}

export interface HostServiceClient {
	settings: {
		agentConfigs: {
			list: {
				query: () => Promise<HostAgentConfig[]>;
			};
		};
	};
}

export type ResolvedHostTarget =
	| {
			kind: "local";
			hostId: string;
			client: HostServiceClient;
	  }
	| {
			kind: "remote";
			hostId: string;
			client: HostServiceClient;
	  };

export interface ResolveHostTargetOptions {
	requestedHostId: string | undefined;
	organizationId: string;
	userJwt: string;
	api: ApiClient;
}

export async function resolveHostTarget(
	options: ResolveHostTargetOptions,
): Promise<ResolvedHostTarget> {
	const localHostId = getHostId();
	const targetHostId = options.requestedHostId ?? localHostId;

	if (targetHostId === localHostId) {
		const manifest = readManifest(options.organizationId);
		if (!manifest) {
			throw new CLIError(
				"Host service for this machine isn't running",
				"Run: superset host start",
			);
		}
		if (!isProcessAlive(manifest.pid)) {
			throw new CLIError(
				"Host service manifest is stale (recorded PID is dead)",
				"Run: superset host start",
			);
		}
		return {
			kind: "local",
			hostId: localHostId,
			client: createTRPCClient({
				links: [
					httpBatchLink({
						url: `${manifest.endpoint}/trpc`,
						transformer: SuperJSON,
						headers: { Authorization: `Bearer ${manifest.authToken}` },
					}),
				],
			}) as unknown as HostServiceClient,
		};
	}

	const relayUrl = await getRelayUrl(options.api);
	const routingKey = buildHostRoutingKey(options.organizationId, targetHostId);
	return {
		kind: "remote",
		hostId: targetHostId,
		client: createTRPCClient({
			links: [
				httpBatchLink({
					url: `${relayUrl}/hosts/${routingKey}/trpc`,
					transformer: SuperJSON,
					headers: { Authorization: `Bearer ${options.userJwt}` },
				}),
			],
		}) as unknown as HostServiceClient,
	};
}
