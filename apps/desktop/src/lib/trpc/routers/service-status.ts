import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import {
	type DefinitionsChangedEvent,
	serviceStatusService,
} from "main/lib/service-status";
import { isCustomIconPath } from "main/lib/service-status/icon-storage";
import type {
	ServiceStatusDefinition,
	ServiceStatusSnapshot,
} from "shared/service-status-types";
import { z } from "zod";
import { publicProcedure, router } from "..";

const iconTypeSchema = z.enum([
	"simple-icon",
	"favicon",
	"custom-url",
	"custom-file",
]);

// 2KB max iconValue — fits URLs, simple-icon slugs, and filesystem paths, and
// prevents accidental base64 blobs from landing in the definition row itself.
const iconValueSchema = z.string().max(2048).nullable();

/**
 * Reject private / loopback hosts so user-supplied URLs can't be abused to
 * reach cloud metadata endpoints (169.254.169.254), internal admin panels,
 * or other LAN services from the main process via `net.request`.
 *
 * `URL.hostname` needs normalization before matching:
 *   - IPv6 literals come back bracketed (`http://[::1]` → `[::1]`), so the
 *     `::1` / `fe80::` / `fc00::` patterns would silently miss them.
 *   - DNS allows a trailing dot (`localhost.` resolves to loopback on most
 *     resolvers) and it survives `URL` parsing.
 *   - The IPv4-mapped IPv6 form `::ffff:127.0.0.1` routes to loopback but
 *     wouldn't match the raw IPv4 regex.
 */
function isPublicHttpsHost(hostname: string): boolean {
	let host = hostname.toLowerCase();
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1);
	}
	if (!host) return false;
	if (host === "localhost") return false;
	if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0")
		return false;
	if (/^127\./.test(host)) return false;
	if (/^10\./.test(host)) return false;
	if (/^192\.168\./.test(host)) return false;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
	if (/^169\.254\./.test(host)) return false;
	// IPv4-mapped IPv6 addresses are a textbook SSRF-bypass surface: the
	// WHATWG URL parser normalizes `http://[::ffff:127.0.0.1]/` to two
	// different forms depending on the implementation —
	//   1) dotted:       `::ffff:127.0.0.1`
	//   2) hex-compressed: `::ffff:7f00:1`   (= 0x7f00.0x0001 = 127.0.0.1)
	// — and the hex form slips past any regex that only looks for dotted
	// quads. We extract the embedded IPv4 from both shapes so the private-
	// range checks below can reuse a single code path.
	const embeddedV4 = extractV4MappedToIPv6(host);
	if (embeddedV4) {
		if (embeddedV4 === "127.0.0.1" || embeddedV4 === "0.0.0.0") return false;
		if (/^127\./.test(embeddedV4)) return false;
		if (/^10\./.test(embeddedV4)) return false;
		if (/^192\.168\./.test(embeddedV4)) return false;
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(embeddedV4)) return false;
		if (/^169\.254\./.test(embeddedV4)) return false;
	}
	// Unique local addresses fc00::/7 (fc.. or fd..) and link-local fe80::/10.
	if (/^f[cd][0-9a-f]{2}:/.test(host)) return false;
	if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
	return true;
}

/**
 * Extract the embedded IPv4 address from a v4-mapped IPv6 literal, in either
 * of the two shapes WHATWG URL parsers emit. Returns `null` for anything
 * that isn't a v4-mapped v6 address (including pure v4 strings — callers
 * still run their own v4 regex set on the original host).
 */
function extractV4MappedToIPv6(host: string): string | null {
	const dotted = host.match(
		/^(?:0{1,4}:){0,5}:?:?ffff:((?:\d{1,3}\.){3}\d{1,3})$/i,
	);
	if (dotted?.[1]) return dotted[1];
	const hex = host.match(
		/^(?:0{1,4}:){0,5}:?:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i,
	);
	if (hex?.[1] && hex[2]) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		if (high > 0xffff || low > 0xffff) return null;
		return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
	}
	return null;
}

const safeHttpUrlSchema = z
	.string()
	.trim()
	.min(1, "URL is required")
	.refine(
		(value) => {
			try {
				const parsed = new URL(value);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return false;
				}
				return isPublicHttpsHost(parsed.hostname);
			} catch {
				return false;
			}
		},
		{
			message:
				"Public http(s) URL required (private / loopback hosts are blocked)",
		},
	);

const createInputSchema = z.object({
	label: z.string().trim().min(1).max(80),
	statusUrl: safeHttpUrlSchema,
	apiUrl: safeHttpUrlSchema,
	iconType: iconTypeSchema,
	iconValue: iconValueSchema,
});

const updateInputSchema = z.object({
	id: z.string().min(1),
	label: z.string().trim().min(1).max(80).optional(),
	statusUrl: safeHttpUrlSchema.optional(),
	apiUrl: safeHttpUrlSchema.optional(),
	iconType: iconTypeSchema.optional(),
	iconValue: iconValueSchema.optional(),
	// When non-null, the previous `custom-file` path (captured by the caller
	// before calling update) is removed from disk after the DB row switches
	// to the new icon.
	deleteReplacedIconPath: z.string().nullable().optional(),
});

const deleteInputSchema = z.object({ id: z.string().min(1) });

const uploadCustomIconSchema = z.object({
	dataUrl: z
		.string()
		.min(1)
		.refine((v) => v.startsWith("data:"), {
			message: "Expected a data: URL payload",
		}),
});

const fetchFaviconSchema = z.object({ statusUrl: safeHttpUrlSchema });

const validateApiUrlSchema = z.object({ apiUrl: safeHttpUrlSchema });

/**
 * Rejects icon-path writes that escape the managed directory. Callers of
 * create/update mutations can pass any `iconValue`; for `custom-file` we
 * enforce here that the path came from a prior `uploadCustomIcon` call.
 */
function assertIconValueIsSafe(
	iconType: ServiceStatusDefinition["iconType"] | undefined,
	iconValue: string | null | undefined,
): void {
	if (iconType !== "custom-file") return;
	if (!iconValue) return;
	if (!isCustomIconPath(iconValue)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Icon path must live under the managed icons directory",
		});
	}
}

export const createServiceStatusRouter = () => {
	return router({
		// Definition CRUD --------------------------------------------------

		listDefinitions: publicProcedure.query((): ServiceStatusDefinition[] =>
			serviceStatusService.getDefinitions(),
		),

		createDefinition: publicProcedure
			.input(createInputSchema)
			.mutation(async ({ input }) => {
				assertIconValueIsSafe(input.iconType, input.iconValue);
				return serviceStatusService.createDefinition(input);
			}),

		updateDefinition: publicProcedure
			.input(updateInputSchema)
			.mutation(async ({ input }) => {
				const { id, deleteReplacedIconPath, ...patch } = input;
				assertIconValueIsSafe(patch.iconType, patch.iconValue);
				return serviceStatusService.updateDefinition(id, patch, {
					deleteReplacedIconPath,
				});
			}),

		deleteDefinition: publicProcedure
			.input(deleteInputSchema)
			.mutation(async ({ input }) => {
				return serviceStatusService.deleteDefinition(input.id);
			}),

		uploadCustomIcon: publicProcedure
			.input(uploadCustomIconSchema)
			.mutation(async ({ input }) => {
				const saved = await serviceStatusService.saveCustomIcon(input.dataUrl);
				return { absolutePath: saved.absolutePath };
			}),

		// Cleanup of "orphan" uploads that the Add / Edit dialog wrote to disk
		// but never attached to a definition (user cancelled or replaced the
		// file before saving). The backend helper rejects any path outside the
		// managed icons directory, so a compromised renderer can't use this to
		// delete arbitrary files.
		deleteUncommittedIcon: publicProcedure
			.input(z.object({ absolutePath: z.string().min(1).max(4096) }))
			.mutation(async ({ input }) => {
				serviceStatusService.deleteUncommittedIcon(input.absolutePath);
				return { ok: true };
			}),

		validateApiUrl: publicProcedure
			.input(validateApiUrlSchema)
			.query(async ({ input }) => {
				return serviceStatusService.validateApiUrl(input.apiUrl);
			}),

		fetchFaviconDataUrl: publicProcedure
			.input(fetchFaviconSchema)
			.query(async ({ input }) => {
				const dataUrl = await serviceStatusService.fetchFaviconDataUrl(
					input.statusUrl,
				);
				return { dataUrl };
			}),

		// --- Live subscriptions -------------------------------------------

		// No `getAll` query: the subscription emits the current state for every
		// snapshot on connect, so the client gets the initial value without a
		// separate round-trip (and we avoid the staleTime-Infinity / subscription
		// race where the query would later clobber fresh subscription data).
		onChange: publicProcedure.subscription(() => {
			return observable<ServiceStatusSnapshot | { removedId: string }>(
				(emit) => {
					const onChange = (snapshot: ServiceStatusSnapshot) => {
						emit.next(snapshot);
					};
					const onRemove = (removedId: string) => {
						emit.next({ removedId });
					};
					// Register listeners BEFORE emitting the initial snapshots so
					// that a `change` fired between the two steps (e.g. a polling
					// cycle completing while we iterate) isn't lost.
					serviceStatusService.on("change", onChange);
					serviceStatusService.on("remove", onRemove);
					for (const snapshot of serviceStatusService.getAll()) {
						emit.next(snapshot);
					}
					return () => {
						serviceStatusService.off("change", onChange);
						serviceStatusService.off("remove", onRemove);
					};
				},
			);
		}),

		onDefinitionsChange: publicProcedure.subscription(() => {
			return observable<DefinitionsChangedEvent>((emit) => {
				const handler = (event: DefinitionsChangedEvent) => {
					emit.next(event);
				};
				serviceStatusService.on("definitions", handler);
				// Initial value so subscribers hydrate without a separate query.
				emit.next({
					type: "definitions",
					definitions: serviceStatusService.getDefinitions(),
				});
				return () => {
					serviceStatusService.off("definitions", handler);
				};
			});
		}),
	});
};
