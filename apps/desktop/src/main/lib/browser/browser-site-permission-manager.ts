import { EventEmitter } from "node:events";
import {
	browserSitePermissions,
	type SitePermissionKind,
	type SitePermissionValue,
} from "@superset/local-db";
import { and, eq } from "drizzle-orm";
import { session } from "electron";
import { localDb } from "../local-db";
import { browserManager } from "./browser-manager";

const APP_BROWSER_PARTITION = "persist:superset";

const DEFAULT_SITE_PERMISSIONS: Record<
	SitePermissionKind,
	SitePermissionValue
> = {
	microphone: "ask",
	camera: "ask",
};

interface SitePermissionRequestEvent {
	paneId: string;
	origin: string;
	permissions: SitePermissionKind[];
}

function normalizeOrigin(value: string): string | null {
	if (!value || value === "about:blank") {
		return null;
	}

	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.origin;
	} catch {
		return null;
	}
}

function mediaTypeToPermissionKind(
	mediaType: "audio" | "video" | "unknown",
): SitePermissionKind | null {
	if (mediaType === "audio") {
		return "microphone";
	}
	if (mediaType === "video") {
		return "camera";
	}
	return null;
}

class BrowserSitePermissionManager extends EventEmitter {
	private initialized = false;
	private lastRequestNotificationAt = new Map<string, number>();

	initialize(): void {
		if (this.initialized) {
			return;
		}

		this.initialized = true;

		const browserSession = session.fromPartition(APP_BROWSER_PARTITION);

		browserSession.setPermissionCheckHandler(
			(webContents, permission, requestingOrigin, details) => {
				if (permission !== "media") {
					return false;
				}

				const origin =
					normalizeOrigin(
						(details as { securityOrigin?: string }).securityOrigin ?? "",
					) ??
					normalizeOrigin(requestingOrigin) ??
					normalizeOrigin(webContents?.getURL() ?? "");

				if (!origin) {
					return false;
				}

				const permissionKind = mediaTypeToPermissionKind(
					details.mediaType ?? "unknown",
				);
				if (!permissionKind) {
					return false;
				}

				return this.getPermission(origin, permissionKind) === "allow";
			},
		);

		browserSession.setPermissionRequestHandler(
			(webContents, permission, callback, details) => {
				if (permission !== "media") {
					callback(true);
					return;
				}

				const origin =
					normalizeOrigin(
						(details as { securityOrigin?: string }).securityOrigin ?? "",
					) ??
					normalizeOrigin(details.requestingUrl ?? "") ??
					normalizeOrigin(webContents.getURL());

				if (!origin) {
					callback(false);
					return;
				}

				const requestedPermissions = [
					...new Set(
						(
							(details as { mediaTypes?: ("audio" | "video" | "unknown")[] })
								.mediaTypes ?? []
						)
							.map((mediaType) => mediaTypeToPermissionKind(mediaType))
							.filter((value): value is SitePermissionKind => value !== null),
					),
				];

				if (requestedPermissions.length === 0) {
					callback(false);
					return;
				}

				const blocked = requestedPermissions.some(
					(permissionKind) =>
						this.getPermission(origin, permissionKind) === "block",
				);
				if (blocked) {
					callback(false);
					return;
				}

				const unresolvedPermissions = requestedPermissions.filter(
					(permissionKind) =>
						this.getPermission(origin, permissionKind) !== "allow",
				);

				if (unresolvedPermissions.length === 0) {
					callback(true);
					return;
				}

				const paneId = browserManager.getPaneIdForWebContents(webContents.id);
				if (paneId) {
					this.emitPermissionRequested({
						paneId,
						origin,
						permissions: unresolvedPermissions,
					});
				}

				callback(false);
			},
		);
	}

	getPermissionsForUrl(url: string): {
		origin: string;
		permissions: Record<SitePermissionKind, SitePermissionValue>;
	} | null {
		const origin = normalizeOrigin(url);
		if (!origin) {
			return null;
		}

		return {
			origin,
			permissions: this.getPermissionsForOrigin(origin),
		};
	}

	getPermissionsForOrigin(
		origin: string,
	): Record<SitePermissionKind, SitePermissionValue> {
		const normalizedOrigin = normalizeOrigin(origin);
		if (!normalizedOrigin) {
			return { ...DEFAULT_SITE_PERMISSIONS };
		}

		const rows = localDb
			.select()
			.from(browserSitePermissions)
			.where(eq(browserSitePermissions.origin, normalizedOrigin))
			.all();

		const permissions = { ...DEFAULT_SITE_PERMISSIONS };
		for (const row of rows) {
			permissions[row.kind] = row.value;
		}

		return permissions;
	}

	setPermission(
		origin: string,
		kind: SitePermissionKind,
		value: SitePermissionValue,
	): {
		origin: string;
		permissions: Record<SitePermissionKind, SitePermissionValue>;
	} {
		const normalizedOrigin = normalizeOrigin(origin);
		if (!normalizedOrigin) {
			throw new Error(
				"Site settings are only available for http and https pages",
			);
		}

		localDb
			.insert(browserSitePermissions)
			.values({
				origin: normalizedOrigin,
				kind,
				value,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: [browserSitePermissions.origin, browserSitePermissions.kind],
				set: {
					value,
					updatedAt: Date.now(),
				},
			})
			.run();

		return {
			origin: normalizedOrigin,
			permissions: this.getPermissionsForOrigin(normalizedOrigin),
		};
	}

	resetPermissions(origin: string): void {
		const normalizedOrigin = normalizeOrigin(origin);
		if (!normalizedOrigin) {
			throw new Error(
				"Site settings are only available for http and https pages",
			);
		}

		localDb
			.delete(browserSitePermissions)
			.where(eq(browserSitePermissions.origin, normalizedOrigin))
			.run();
	}

	private getPermission(
		origin: string,
		kind: SitePermissionKind,
	): SitePermissionValue {
		const normalizedOrigin = normalizeOrigin(origin);
		if (!normalizedOrigin) {
			return "ask";
		}

		const row = localDb
			.select()
			.from(browserSitePermissions)
			.where(
				and(
					eq(browserSitePermissions.origin, normalizedOrigin),
					eq(browserSitePermissions.kind, kind),
				),
			)
			.get();

		return row?.value ?? "ask";
	}

	private emitPermissionRequested(event: SitePermissionRequestEvent): void {
		const dedupeKey = `${event.paneId}:${event.origin}:${[...event.permissions].sort().join(",")}`;
		const now = Date.now();
		const previous = this.lastRequestNotificationAt.get(dedupeKey) ?? 0;
		if (now - previous < 1500) {
			return;
		}

		this.lastRequestNotificationAt.set(dedupeKey, now);
		this.emit(`permission-requested:${event.paneId}`, event);
	}
}

export const browserSitePermissionManager = new BrowserSitePermissionManager();
