import type { IconType } from "react-icons";
import {
	SiAnthropic,
	SiApple,
	SiAsana,
	SiAtlassian,
	SiAuth0,
	SiBitbucket,
	SiCircleci,
	SiClaude,
	SiCloudflare,
	SiDatadog,
	SiDigitalocean,
	SiDiscord,
	SiDocker,
	SiDropbox,
	SiFastly,
	SiFigma,
	SiFirebase,
	SiGit,
	SiGithub,
	SiGitlab,
	SiGoogle,
	SiGooglecloud,
	SiHeroku,
	SiHuggingface,
	SiIntercom,
	SiJira,
	SiLinear,
	SiMongodb,
	SiNetlify,
	SiNewrelic,
	SiNotion,
	SiNpm,
	SiOkta,
	SiOpenai,
	SiPagerduty,
	SiPostgresql,
	SiRedis,
	SiSentry,
	SiShopify,
	SiSlack,
	SiSnowflake,
	SiStripe,
	SiSupabase,
	SiTwilio,
	SiVercel,
	SiZendesk,
	SiZoom,
} from "react-icons/si";

/**
 * Curated list of Simple Icons available as `iconType: "simple-icon"`.
 *
 * Dynamic import-by-name across all of `react-icons/si` would defeat
 * tree-shaking and inflate the bundle by several MB. Curating ~50 popular
 * providers keeps bundle impact minimal while covering the services that
 * actually publish Statuspage.io status pages. Users who need something
 * outside this list can switch to `favicon` (auto) or `custom-url` /
 * `custom-file`.
 */
export const SIMPLE_ICON_REGISTRY: Record<string, IconType> = {
	anthropic: SiAnthropic,
	apple: SiApple,
	asana: SiAsana,
	atlassian: SiAtlassian,
	auth0: SiAuth0,
	bitbucket: SiBitbucket,
	circleci: SiCircleci,
	claude: SiClaude,
	cloudflare: SiCloudflare,
	datadog: SiDatadog,
	digitalocean: SiDigitalocean,
	discord: SiDiscord,
	docker: SiDocker,
	dropbox: SiDropbox,
	fastly: SiFastly,
	figma: SiFigma,
	firebase: SiFirebase,
	git: SiGit,
	github: SiGithub,
	gitlab: SiGitlab,
	google: SiGoogle,
	googlecloud: SiGooglecloud,
	heroku: SiHeroku,
	huggingface: SiHuggingface,
	intercom: SiIntercom,
	jira: SiJira,
	linear: SiLinear,
	mongodb: SiMongodb,
	netlify: SiNetlify,
	newrelic: SiNewrelic,
	notion: SiNotion,
	npm: SiNpm,
	okta: SiOkta,
	openai: SiOpenai,
	pagerduty: SiPagerduty,
	postgresql: SiPostgresql,
	redis: SiRedis,
	sentry: SiSentry,
	shopify: SiShopify,
	slack: SiSlack,
	snowflake: SiSnowflake,
	stripe: SiStripe,
	supabase: SiSupabase,
	twilio: SiTwilio,
	vercel: SiVercel,
	zendesk: SiZendesk,
	zoom: SiZoom,
};

export interface SimpleIconOption {
	slug: string;
	label: string;
	Icon: IconType;
}

/**
 * Ordered list for rendering a picker UI. Labels are kept short for a grid
 * of brand buttons. Values mirror keys in `SIMPLE_ICON_REGISTRY`.
 */
export const SIMPLE_ICON_OPTIONS: SimpleIconOption[] = Object.entries(
	SIMPLE_ICON_REGISTRY,
)
	.map(([slug, Icon]) => ({
		slug,
		label: slug.charAt(0).toUpperCase() + slug.slice(1),
		Icon,
	}))
	.sort((a, b) => a.label.localeCompare(b.label));

export function resolveSimpleIcon(slug: string | null): IconType | null {
	if (!slug) return null;
	return SIMPLE_ICON_REGISTRY[slug.toLowerCase()] ?? null;
}
