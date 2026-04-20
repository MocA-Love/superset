import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { LuCopy, LuExternalLink } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface CdpEndpointCardProps {
	sessionId: string;
}

/**
 * Shows the filtered CDP endpoint for the pane bound to this LLM
 * session, plus copy-ready setup commands for the common external
 * browser-automation MCPs (chrome-devtools-mcp, browser-use,
 * playwright-mcp). The whole point of the pane↔session binding is to
 * delegate actual browser control to those tools, so this is the
 * primary success-state UI once a pane is attached.
 */
export function CdpEndpointCard({ sessionId }: CdpEndpointCardProps) {
	const { data, isLoading } =
		electronTrpc.browserAutomation.getCdpEndpointForSession.useQuery(
			{ sessionId },
			{ refetchInterval: 5_000 },
		);

	const copy = async (value: string, label: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied`);
		} catch {
			toast.error(`Failed to copy ${label.toLowerCase()}`);
		}
	};

	if (isLoading) {
		return (
			<div className="rounded-xl border p-3 bg-card/60 text-xs text-muted-foreground">
				Resolving CDP endpoint…
			</div>
		);
	}
	if (!data || !data.available) {
		const reason =
			data?.reason === "target-not-ready"
				? "Chromium has not finished attaching to this pane yet. Reload the pane and retry."
				: data?.reason === "cdp-disabled"
					? "This build did not enable --remote-debugging-port."
					: data?.reason === "bridge-not-running"
						? "The browser-mcp bridge is not running yet."
						: "Bind a pane first to expose a CDP endpoint.";
		return (
			<div className="rounded-xl border p-3 bg-card/60">
				<div className="text-xs font-semibold">CDP endpoint unavailable</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					{reason}
				</div>
			</div>
		);
	}

	const chromeDevtoolsCmd = `claude mcp add chrome-devtools-mcp -s user -- npx -y chrome-devtools-mcp --browser-url ${data.httpBase}`;
	// browser-use ships its own MCP mode via `uvx --from "browser-use[cli]"`.
	// CDP endpoint is passed via the same `--cdp-url` flag that the CLI
	// accepts. Port + token are stable across Superset restarts (see
	// server.ts / cdp-filter-proxy.ts), so this registration only has to
	// be done once per install.
	const browserUseCmd = `claude mcp add browser-use -s user -- uvx --from "browser-use[cli]" browser-use --mcp --cdp-url ${data.wsEndpoint}`;

	return (
		<div className="rounded-xl border p-3 bg-card/60 flex flex-col gap-3">
			<div>
				<div className="text-xs font-semibold">
					External browser MCP endpoint
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					This session is bound to pane{" "}
					<code className="rounded bg-muted px-1">{data.paneId}</code>. Point
					any CDP-speaking browser MCP (chrome-devtools-mcp / browser-use /
					playwright-mcp) at the URL below — it only exposes this pane.
				</div>
			</div>

			<UrlRow
				label="WebSocket"
				value={data.wsEndpoint}
				onCopy={() => copy(data.wsEndpoint, "WebSocket URL")}
			/>
			<UrlRow
				label="HTTP base"
				value={data.httpBase}
				onCopy={() => copy(data.httpBase, "HTTP URL")}
			/>

			<div className="mt-1">
				<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
					Example setup
				</div>
				<CommandBlock
					title="chrome-devtools-mcp (Claude Code)"
					cmd={chromeDevtoolsCmd}
					onCopy={() => copy(chromeDevtoolsCmd, "chrome-devtools-mcp command")}
				/>
				<CommandBlock
					title="browser-use"
					cmd={browserUseCmd}
					onCopy={() => copy(browserUseCmd, "browser-use command")}
				/>
			</div>

			<div className="text-[10px] text-muted-foreground flex items-start gap-1">
				<LuExternalLink className="size-3 mt-0.5 shrink-0" />
				<span>
					Chrome DevTools Protocol is exposed via a per-session filter proxy, so
					external tools never see sibling panes or the workspace shell.
				</span>
			</div>
		</div>
	);
}

function UrlRow({
	label,
	value,
	onCopy,
}: {
	label: string;
	value: string;
	onCopy: () => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 w-20 shrink-0">
				{label}
			</span>
			<code className="flex-1 rounded bg-muted px-2 py-1 text-[11px] truncate">
				{value}
			</code>
			<Button size="sm" variant="outline" onClick={onCopy}>
				<LuCopy className="size-3" />
			</Button>
		</div>
	);
}

function CommandBlock({
	title,
	cmd,
	onCopy,
}: {
	title: string;
	cmd: string;
	onCopy: () => void;
}) {
	return (
		<div className="mt-2">
			<div className="text-[11px] font-medium">{title}</div>
			<div className="mt-1 flex items-center gap-2">
				<pre className="flex-1 min-w-0 max-w-full rounded-md border bg-black/40 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
					{cmd}
				</pre>
				<Button size="sm" variant="outline" onClick={onCopy}>
					<LuCopy className="size-3" />
				</Button>
			</div>
		</div>
	);
}
