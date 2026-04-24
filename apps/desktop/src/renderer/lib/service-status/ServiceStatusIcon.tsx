import { HiOutlineGlobeAlt } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ServiceStatusSnapshot } from "shared/service-status-types";
import { resolveSimpleIcon } from "./simple-icons-map";

export type ServiceStatusIconSource = Pick<
	ServiceStatusSnapshot,
	"iconType" | "iconValue" | "statusUrl" | "label"
>;

interface ServiceStatusIconProps {
	source: ServiceStatusIconSource;
	/**
	 * Tailwind class sized like `size-4` / `size-[15px]`. Applied to both the
	 * simple-icon SVG and the img wrapper so callers control dimensions in
	 * one place.
	 */
	className?: string;
}

/**
 * Turns an absolute filesystem path into a URL that the renderer can load
 * via the `superset-service-icon` custom protocol.
 *
 * Inlined here (instead of importing from main/) to keep the renderer
 * bundle free of Electron Node-side modules.
 */
function encodeCustomFileUrl(absolutePath: string): string {
	return `superset-service-icon:///${encodeURIComponent(absolutePath)}`;
}

export function ServiceStatusIcon({
	source,
	className = "size-4",
}: ServiceStatusIconProps) {
	const favicon = useFaviconDataUrl(source);

	if (source.iconType === "simple-icon") {
		const Icon = resolveSimpleIcon(source.iconValue);
		if (Icon) {
			return <Icon className={className} aria-hidden="true" />;
		}
	}

	if (source.iconType === "custom-url" && source.iconValue) {
		return (
			<img
				src={source.iconValue}
				alt=""
				aria-hidden="true"
				className={`${className} object-contain`}
				draggable={false}
			/>
		);
	}

	if (source.iconType === "custom-file" && source.iconValue) {
		return (
			<img
				src={encodeCustomFileUrl(source.iconValue)}
				alt=""
				aria-hidden="true"
				className={`${className} object-contain`}
				draggable={false}
			/>
		);
	}

	if (favicon) {
		return (
			<img
				src={favicon}
				alt=""
				aria-hidden="true"
				className={`${className} object-contain`}
				draggable={false}
			/>
		);
	}

	return <HiOutlineGlobeAlt className={className} aria-hidden="true" />;
}

/**
 * Lazily fetches the favicon data URL when the source is `iconType: favicon`,
 * or when a `simple-icon` source didn't resolve to a usable icon so we fall
 * back to the site's favicon instead of the globe placeholder. React Query
 * dedupes and caches across mounts for the same statusUrl.
 */
function useFaviconDataUrl(source: ServiceStatusIconSource): string | null {
	const wantFavicon =
		source.iconType === "favicon" ||
		(source.iconType === "simple-icon" && !resolveSimpleIcon(source.iconValue));

	const query = electronTrpc.serviceStatus.fetchFaviconDataUrl.useQuery(
		{ statusUrl: source.statusUrl },
		{
			enabled: wantFavicon && Boolean(source.statusUrl),
			staleTime: 60 * 60 * 1000,
			retry: 1,
		},
	);
	return query.data?.dataUrl ?? null;
}
