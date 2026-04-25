import type {
	ServiceStatusFormat,
	ServiceStatusIconType,
} from "shared/service-status-types";

/**
 * Curated catalog of well-known external services that publish a status API
 * we can consume. Users pick entries out of this list via the "プリセットから追加"
 * dialog; the dialog simply forwards the fields to `serviceStatus.createDefinition`,
 * so adding a new preset is a pure data change.
 *
 * URLs were verified against the published status pages at the time of
 * writing. Providers occasionally move their feeds (AWS has done this
 * several times historically) — the backend parsers fail gracefully to
 * `unknown` if a URL goes stale, so a broken preset shows as "ステータス不明"
 * rather than crashing the dashboard.
 *
 * Icon choices:
 *   - `simple-icon` when the slug exists in the renderer's SIMPLE_ICON_REGISTRY
 *     (curated ~50 brand marks from `react-icons/si`).
 *   - `favicon` otherwise — the renderer proxies `www.google.com/s2/favicons`
 *     through main and renders the site's favicon. Used for providers whose
 *     brand mark isn't in Simple Icons (AWS, Azure, Groq, Cohere, Fireworks).
 */

export type PresetCategory =
	| "cloud"
	| "ai"
	| "dev-infra"
	| "hosting"
	| "communication"
	| "productivity"
	| "payment";

export const PRESET_CATEGORY_LABEL: Record<PresetCategory, string> = {
	cloud: "Cloud",
	ai: "AI",
	"dev-infra": "Dev Infra",
	hosting: "Hosting / CDN",
	communication: "Communication",
	productivity: "Productivity",
	payment: "Payment / SaaS",
};

// Category ordering for the picker grid.
export const PRESET_CATEGORY_ORDER: readonly PresetCategory[] = [
	"cloud",
	"ai",
	"dev-infra",
	"hosting",
	"communication",
	"productivity",
	"payment",
];

export interface ServicePreset {
	/** Stable slug — used as React key; not persisted as DB id. */
	slug: string;
	label: string;
	category: PresetCategory;
	statusUrl: string;
	apiUrl: string;
	format: ServiceStatusFormat;
	iconType: ServiceStatusIconType;
	/** For `simple-icon` this is the SIMPLE_ICON_REGISTRY key. */
	iconValue: string | null;
}

export const SERVICE_PRESETS: readonly ServicePreset[] = [
	// --- Cloud (Big 3) — each needs a dedicated format adapter -----------
	{
		slug: "aws",
		label: "AWS",
		category: "cloud",
		statusUrl: "https://status.aws.amazon.com/",
		apiUrl: "https://status.aws.amazon.com/data.json",
		format: "aws-health",
		iconType: "favicon",
		iconValue: null,
	},
	{
		slug: "gcp",
		label: "Google Cloud",
		category: "cloud",
		statusUrl: "https://status.cloud.google.com/",
		apiUrl: "https://status.cloud.google.com/incidents.json",
		format: "gcp-incidents",
		iconType: "simple-icon",
		iconValue: "googlecloud",
	},
	{
		slug: "azure",
		label: "Microsoft Azure",
		category: "cloud",
		statusUrl: "https://azure.status.microsoft/",
		apiUrl: "https://azure.status.microsoft/en-us/status/feed/",
		format: "azure-rss",
		iconType: "favicon",
		iconValue: null,
	},

	// --- AI ---------------------------------------------------------------
	{
		slug: "claude",
		label: "Claude",
		category: "ai",
		statusUrl: "https://status.claude.com/",
		apiUrl: "https://status.claude.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "claude",
	},
	{
		slug: "openai",
		label: "OpenAI",
		category: "ai",
		statusUrl: "https://status.openai.com/",
		apiUrl: "https://status.openai.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "openai",
	},
	{
		slug: "anthropic",
		label: "Anthropic",
		category: "ai",
		statusUrl: "https://status.anthropic.com/",
		apiUrl: "https://status.anthropic.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "anthropic",
	},
	{
		slug: "groq",
		label: "Groq",
		category: "ai",
		statusUrl: "https://groqstatus.com/",
		apiUrl: "https://groqstatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "favicon",
		iconValue: null,
	},
	{
		slug: "cohere",
		label: "Cohere",
		category: "ai",
		statusUrl: "https://status.cohere.com/",
		apiUrl: "https://status.cohere.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "favicon",
		iconValue: null,
	},
	{
		slug: "replicate",
		label: "Replicate",
		category: "ai",
		statusUrl: "https://www.replicatestatus.com/",
		apiUrl: "https://www.replicatestatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "replicate",
	},
	{
		slug: "perplexity",
		label: "Perplexity",
		category: "ai",
		// Perplexity migrated to Instatus; the legacy /api/v2/status.json path
		// 404s but summary.json gives us the page-level status.
		statusUrl: "https://status.perplexity.com/",
		apiUrl: "https://status.perplexity.com/summary.json",
		format: "instatus-summary",
		iconType: "simple-icon",
		iconValue: "perplexity",
	},
	// --- Dev Infra --------------------------------------------------------
	{
		slug: "github",
		label: "GitHub",
		category: "dev-infra",
		statusUrl: "https://www.githubstatus.com/",
		apiUrl: "https://www.githubstatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "github",
	},
	{
		slug: "gitlab",
		label: "GitLab",
		category: "dev-infra",
		// GitLab status page is hosted on status.io, not Atlassian Statuspage.
		// API responds at api.status.io/1.0/status/<page_id>.
		statusUrl: "https://status.gitlab.com/",
		apiUrl: "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7",
		format: "status-io",
		iconType: "simple-icon",
		iconValue: "gitlab",
	},
	{
		slug: "bitbucket",
		label: "Bitbucket",
		category: "dev-infra",
		statusUrl: "https://bitbucket.status.atlassian.com/",
		apiUrl: "https://bitbucket.status.atlassian.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "bitbucket",
	},
	{
		slug: "npm",
		label: "npm",
		category: "dev-infra",
		statusUrl: "https://status.npmjs.org/",
		apiUrl: "https://status.npmjs.org/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "npm",
	},
	{
		slug: "docker-hub",
		label: "Docker Hub",
		category: "dev-infra",
		// Docker Hub uses status.io (same backend as GitLab).
		statusUrl: "https://www.dockerstatus.com/",
		apiUrl: "https://api.status.io/1.0/status/533c6539221ae15e3f000031",
		format: "status-io",
		iconType: "simple-icon",
		iconValue: "docker",
	},
	{
		slug: "circleci",
		label: "CircleCI",
		category: "dev-infra",
		statusUrl: "https://status.circleci.com/",
		apiUrl: "https://status.circleci.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "circleci",
	},
	{
		slug: "sentry",
		label: "Sentry",
		category: "dev-infra",
		statusUrl: "https://status.sentry.io/",
		apiUrl: "https://status.sentry.io/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "sentry",
	},
	{
		slug: "datadog",
		label: "Datadog",
		category: "dev-infra",
		statusUrl: "https://status.datadoghq.com/",
		apiUrl: "https://status.datadoghq.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "datadog",
	},

	// --- Hosting / CDN ----------------------------------------------------
	{
		slug: "cloudflare",
		label: "Cloudflare",
		category: "hosting",
		statusUrl: "https://www.cloudflarestatus.com/",
		apiUrl: "https://www.cloudflarestatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "cloudflare",
	},
	{
		slug: "vercel",
		label: "Vercel",
		category: "hosting",
		statusUrl: "https://www.vercel-status.com/",
		apiUrl: "https://www.vercel-status.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "vercel",
	},
	{
		slug: "netlify",
		label: "Netlify",
		category: "hosting",
		statusUrl: "https://www.netlifystatus.com/",
		apiUrl: "https://www.netlifystatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "netlify",
	},
	{
		slug: "digitalocean",
		label: "DigitalOcean",
		category: "hosting",
		statusUrl: "https://status.digitalocean.com/",
		apiUrl: "https://status.digitalocean.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "digitalocean",
	},
	// --- Communication ----------------------------------------------------
	{
		slug: "slack",
		label: "Slack",
		category: "communication",
		// Slack moved off Atlassian Statuspage to a custom feed at slack-status.com.
		statusUrl: "https://slack-status.com/",
		apiUrl: "https://slack-status.com/api/v2.0.0/current",
		format: "slack-v2",
		iconType: "simple-icon",
		iconValue: "slack",
	},
	{
		slug: "discord",
		label: "Discord",
		category: "communication",
		statusUrl: "https://discordstatus.com/",
		apiUrl: "https://discordstatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "discord",
	},
	{
		slug: "zoom",
		label: "Zoom",
		category: "communication",
		statusUrl: "https://status.zoom.us/",
		apiUrl: "https://status.zoom.us/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "zoom",
	},
	{
		slug: "intercom",
		label: "Intercom",
		category: "communication",
		statusUrl: "https://www.intercomstatus.com/",
		apiUrl: "https://www.intercomstatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "intercom",
	},

	// --- Productivity -----------------------------------------------------
	{
		slug: "linear",
		label: "Linear",
		category: "productivity",
		// Linear moved its statuspage off status.linear.app (now a custom HTML
		// page) onto linearstatus.com which keeps the statuspage v2 schema.
		statusUrl: "https://linearstatus.com/",
		apiUrl: "https://linearstatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "linear",
	},
	{
		slug: "atlassian",
		label: "Atlassian",
		category: "productivity",
		statusUrl: "https://status.atlassian.com/",
		apiUrl: "https://status.atlassian.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "atlassian",
	},
	{
		slug: "notion",
		label: "Notion",
		category: "productivity",
		// Notion's status.notion.so now serves a custom HTML page; the actual
		// statuspage v2 feed lives on www.notion-status.com.
		statusUrl: "https://www.notion-status.com/",
		apiUrl: "https://www.notion-status.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "notion",
	},
	{
		slug: "figma",
		label: "Figma",
		category: "productivity",
		statusUrl: "https://status.figma.com/",
		apiUrl: "https://status.figma.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "figma",
	},

	// --- Payment / SaaS ---------------------------------------------------
	{
		slug: "stripe",
		label: "Stripe",
		category: "payment",
		// Stripe migrated from status.stripe.com to www.stripestatus.com (2024).
		// Old host returns 404 for /api/v2/*.
		statusUrl: "https://www.stripestatus.com/",
		apiUrl: "https://www.stripestatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "stripe",
	},
	{
		slug: "twilio",
		label: "Twilio",
		category: "payment",
		statusUrl: "https://status.twilio.com/",
		apiUrl: "https://status.twilio.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "twilio",
	},
	{
		slug: "supabase",
		label: "Supabase",
		category: "payment",
		statusUrl: "https://status.supabase.com/",
		apiUrl: "https://status.supabase.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "supabase",
	},
	{
		slug: "mongodb",
		label: "MongoDB Atlas",
		category: "payment",
		statusUrl: "https://status.mongodb.com/",
		apiUrl: "https://status.mongodb.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "mongodb",
	},
	{
		slug: "shopify",
		label: "Shopify",
		category: "payment",
		statusUrl: "https://www.shopifystatus.com/",
		apiUrl: "https://www.shopifystatus.com/api/v2/status.json",
		format: "statuspage-v2",
		iconType: "simple-icon",
		iconValue: "shopify",
	},
];

/**
 * Normalize an apiUrl for "already added" dedup across minor textual variants:
 * case-insensitive host, trailing-slash, default-port elision. The resulting
 * string is not meant to be sent anywhere — it's only a compare key.
 *
 * Lives here (not in url-safety.ts) because it's a renderer-only concern and
 * url-safety is a main-process module.
 */
export function normalizeApiUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const port =
			(parsed.protocol === "http:" && parsed.port === "80") ||
			(parsed.protocol === "https:" && parsed.port === "443")
				? ""
				: parsed.port;
		const path = parsed.pathname.replace(/\/+$/, "") || "/";
		const search = parsed.search;
		return `${parsed.protocol}//${host}${port ? `:${port}` : ""}${path}${search}`;
	} catch {
		return url.toLowerCase();
	}
}

/**
 * Group presets by category for the picker grid. Empty categories are omitted
 * (useful when we later introduce per-user filtering of the list).
 */
export function groupPresetsByCategory(
	presets: readonly ServicePreset[] = SERVICE_PRESETS,
): Array<{ category: PresetCategory; items: ServicePreset[] }> {
	const byCategory = new Map<PresetCategory, ServicePreset[]>();
	for (const preset of presets) {
		const list = byCategory.get(preset.category);
		if (list) list.push(preset);
		else byCategory.set(preset.category, [preset]);
	}
	const ordered: Array<{ category: PresetCategory; items: ServicePreset[] }> =
		[];
	for (const category of PRESET_CATEGORY_ORDER) {
		const items = byCategory.get(category);
		if (items && items.length > 0) ordered.push({ category, items });
	}
	return ordered;
}
