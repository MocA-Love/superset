interface Env {
	DEEP_LINK_SCHEME?: string;
	FALLBACK_URL?: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function buildDeepLink(requestUrl: URL, env: Env): string {
	const scheme = env.DEEP_LINK_SCHEME?.trim() || "superset";
	const deepLink = new URL(`${scheme}://open`);

	for (const [key, value] of requestUrl.searchParams.entries()) {
		deepLink.searchParams.append(key, value);
	}

	return deepLink.toString();
}

function buildHtml(args: {
	deepLink: string;
	fallbackUrl: string;
	queryPreview: string;
}): string {
	const deepLink = escapeHtml(args.deepLink);
	const fallbackUrl = escapeHtml(args.fallbackUrl);
	const queryPreview = escapeHtml(args.queryPreview);

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Open in Superset</title>
		<style>
			:root {
				color-scheme: light;
				font-family:
					Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
					"Segoe UI", sans-serif;
				background: #f4f1ea;
				color: #1f1a17;
			}

			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				background:
					radial-gradient(circle at top left, rgba(227, 175, 104, 0.35), transparent 38%),
					radial-gradient(circle at bottom right, rgba(48, 139, 112, 0.18), transparent 42%),
					#f4f1ea;
				padding: 24px;
			}

			main {
				width: min(560px, 100%);
				box-sizing: border-box;
				background: rgba(255, 252, 247, 0.92);
				border: 1px solid rgba(31, 26, 23, 0.08);
				border-radius: 24px;
				padding: 28px;
				box-shadow: 0 18px 50px rgba(31, 26, 23, 0.08);
			}

			h1 {
				margin: 0 0 10px;
				font-size: 28px;
				line-height: 1.1;
			}

			p {
				margin: 0 0 14px;
				line-height: 1.55;
			}

			pre {
				margin: 18px 0 0;
				padding: 14px 16px;
				border-radius: 16px;
				background: #191512;
				color: #f6efe7;
				font-size: 13px;
				overflow-x: auto;
			}

			.actions {
				display: flex;
				flex-wrap: wrap;
				gap: 12px;
				margin-top: 22px;
			}

			.button {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				border-radius: 999px;
				padding: 11px 16px;
				font-weight: 600;
				text-decoration: none;
				border: 1px solid transparent;
			}

			.button-primary {
				background: #1f1a17;
				color: #fffaf5;
			}

			.button-secondary {
				background: transparent;
				color: #1f1a17;
				border-color: rgba(31, 26, 23, 0.18);
			}

			.muted {
				color: rgba(31, 26, 23, 0.68);
				font-size: 14px;
			}
		</style>
	</head>
	<body>
		<main>
			<h1>Open in Superset</h1>
			<p>Redirecting to the desktop app.</p>
			<p class="muted">If nothing happens, use the button below. The desktop app must be installed and registered for this deep link scheme.</p>
			<div class="actions">
				<a class="button button-primary" href="${deepLink}">Open desktop app</a>
				<a class="button button-secondary" href="${fallbackUrl}">Open fallback URL</a>
			</div>
			<pre>${queryPreview}</pre>
		</main>
		<script>
			window.location.href = ${JSON.stringify(args.deepLink)};
		</script>
	</body>
</html>`;
}

const worker = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const isHead = request.method === "HEAD";

		if (request.method !== "GET" && !isHead) {
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname === "/healthz") {
			return new Response(isHead ? null : "ok");
		}

		if (url.pathname !== "/" && url.pathname !== "/open") {
			return new Response("Not found", { status: 404 });
		}

		const deepLink = buildDeepLink(url, env);
		const fallbackUrl = env.FALLBACK_URL?.trim() || "https://github.com/MocA-Love/superset";
		const queryPreview = url.search ? `${url.pathname}${url.search}` : url.pathname;
		const html = buildHtml({ deepLink, fallbackUrl, queryPreview });

		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	},
};

export default worker;
