import type { SitePermissionValue } from "@superset/local-db";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import { TbSettings } from "react-icons/tb";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface SitePermissionsMenuProps {
	paneId: string;
	currentUrl: string;
	hasPage: boolean;
}

interface PendingPermissionRequest {
	origin: string;
	permissions: ("microphone" | "camera")[];
}

const PERMISSION_LABELS = {
	microphone: "Microphone",
	camera: "Camera",
} as const;

const VALUE_LABELS: Record<SitePermissionValue, string> = {
	ask: "Ask",
	allow: "Allow",
	block: "Block",
};

function normalizeSiteOrigin(value: string): string | null {
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

function formatPermissionList(
	permissions: ("microphone" | "camera")[],
): string {
	return permissions
		.map((permission) => PERMISSION_LABELS[permission])
		.join(" and ");
}

export function SitePermissionsMenu({
	paneId,
	currentUrl,
	hasPage,
}: SitePermissionsMenuProps) {
	const utils = electronTrpc.useUtils();
	const [pendingRequest, setPendingRequest] =
		useState<PendingPermissionRequest | null>(null);
	const siteOrigin = useMemo(
		() => normalizeSiteOrigin(currentUrl),
		[currentUrl],
	);

	const { data: sitePermissions } =
		electronTrpc.browser.getSitePermissions.useQuery(
			{ url: currentUrl },
			{ enabled: hasPage && siteOrigin !== null },
		);
	const setSitePermissionMutation =
		electronTrpc.browser.setSitePermission.useMutation();
	const resetSitePermissionsMutation =
		electronTrpc.browser.resetSitePermissions.useMutation();

	electronTrpc.browser.onSitePermissionRequested.useSubscription(
		{ paneId },
		{
			onData: (event) => {
				setPendingRequest({
					origin: event.origin,
					permissions: event.permissions,
				});
				toast.info(
					`${event.origin} requested ${formatPermissionList(event.permissions)}`,
					{
						description:
							"Use site settings in the browser toolbar to allow access.",
					},
				);
			},
		},
	);

	useEffect(() => {
		setPendingRequest((current) => {
			if (!current) {
				return null;
			}
			return current.origin === siteOrigin ? current : null;
		});
	}, [siteOrigin]);

	const permissions = sitePermissions?.permissions;
	const hasPendingRequest =
		pendingRequest !== null &&
		pendingRequest.origin === sitePermissions?.origin;
	const isBusy =
		setSitePermissionMutation.isPending ||
		resetSitePermissionsMutation.isPending;

	const handlePermissionChange = (
		kind: "microphone" | "camera",
		value: string,
	) => {
		if (!sitePermissions?.origin) {
			return;
		}

		setSitePermissionMutation.mutate(
			{
				origin: sitePermissions.origin,
				kind,
				value: value as SitePermissionValue,
			},
			{
				onSuccess: (data) => {
					utils.browser.getSitePermissions.setData({ url: currentUrl }, () => ({
						origin: data.origin,
						permissions: data.permissions,
					}));
					void utils.permissions.getStatus.invalidate();
					if (pendingRequest?.origin === sitePermissions.origin) {
						setPendingRequest((current) => {
							if (!current) {
								return current;
							}

							const remainingPermissions = current.permissions.filter(
								(permission) => permission !== kind,
							);
							if (remainingPermissions.length === 0) {
								return null;
							}

							return {
								...current,
								permissions: remainingPermissions,
							};
						});
					}

					if (data.mediaAccess && !data.mediaAccess.granted) {
						toast.info(
							`${PERMISSION_LABELS[kind]} access still needs to be enabled for Superset in macOS Settings.`,
							{
								description: data.mediaAccess.openedSystemSettings
									? "System Settings was opened to the relevant privacy panel."
									: undefined,
							},
						);
					}
				},
			},
		);
	};

	const handleReset = () => {
		if (!sitePermissions?.origin) {
			return;
		}

		resetSitePermissionsMutation.mutate(
			{ origin: sitePermissions.origin },
			{
				onSuccess: () => {
					utils.browser.getSitePermissions.setData(
						{ url: currentUrl },
						(current) =>
							current
								? {
										origin: current.origin,
										permissions: {
											microphone: "ask",
											camera: "ask",
											geolocation: "ask",
											notifications: "ask",
											"clipboard-read": "ask",
										},
									}
								: current,
					);
					setPendingRequest(null);
				},
			},
		);
	};

	const settingsUnavailable = !hasPage || siteOrigin === null;

	return (
		<DropdownMenu modal={false}>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							disabled={settingsUnavailable}
							className={`rounded p-1 transition-colors ${
								hasPendingRequest
									? "text-amber-500 hover:text-amber-400"
									: "text-muted-foreground/50 hover:text-foreground"
							} ${settingsUnavailable ? "opacity-30 pointer-events-none" : ""}`}
						>
							<TbSettings className="size-3.5" />
						</button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					{hasPendingRequest ? "Site requested access" : "Site Settings"}
				</TooltipContent>
			</Tooltip>

			<DropdownMenuContent align="end" className="w-56">
				{settingsUnavailable || !sitePermissions ? (
					<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
						Site settings are only available for http and https pages.
					</DropdownMenuLabel>
				) : (
					<>
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground break-all">
							{sitePermissions.origin}
						</DropdownMenuLabel>
						{hasPendingRequest && pendingRequest ? (
							<DropdownMenuLabel className="pt-0 text-xs font-normal text-amber-500">
								Requested: {formatPermissionList(pendingRequest.permissions)}
							</DropdownMenuLabel>
						) : null}
						<DropdownMenuSeparator />

						<DropdownMenuLabel className="pb-0 text-xs">
							Microphone
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={permissions?.microphone ?? "ask"}
							onValueChange={(value) =>
								handlePermissionChange("microphone", value)
							}
						>
							{(["ask", "allow", "block"] as const).map((value) => (
								<DropdownMenuRadioItem
									key={value}
									value={value}
									disabled={isBusy}
								>
									{VALUE_LABELS[value]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>

						<DropdownMenuLabel className="pt-2 pb-0 text-xs">
							Camera
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={permissions?.camera ?? "ask"}
							onValueChange={(value) => handlePermissionChange("camera", value)}
						>
							{(["ask", "allow", "block"] as const).map((value) => (
								<DropdownMenuRadioItem
									key={value}
									value={value}
									disabled={isBusy}
								>
									{VALUE_LABELS[value]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>

						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={handleReset}
							disabled={isBusy}
							className="gap-2"
						>
							Reset Site Settings
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
