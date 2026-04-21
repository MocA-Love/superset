import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { useEffect, useState } from "react";
import {
	LuChevronDown,
	LuChevronUp,
	LuCopy,
	LuExternalLink,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface CdpEndpointCardProps {
	sessionId: string;
	/**
	 * Increment to force the Example setup section open from outside
	 * (e.g., the summary-bar "Show setup commands" button). The card
	 * defaults to collapsed because once a session is bound the MCP
	 * registration is a one-shot task; keeping four command blocks
	 * permanently visible drowns out the actual status info.
	 */
	revealSetupToken?: number;
}

/**
 * Shows the filtered CDP endpoint for the pane bound to this LLM
 * session, plus copy-ready setup commands for the common external
 * browser-automation MCPs (chrome-devtools-mcp, browser-use,
 * playwright-mcp). The whole point of the pane↔session binding is to
 * delegate actual browser control to those tools, so this is the
 * primary success-state UI once a pane is attached.
 */
export function CdpEndpointCard({
	sessionId,
	revealSetupToken,
}: CdpEndpointCardProps) {
	const { data, isLoading } =
		electronTrpc.browserAutomation.getCdpEndpointForSession.useQuery(
			{ sessionId },
			{ refetchInterval: 5_000 },
		);

	// Setup commands stay hidden by default. They re-appear when the
	// user explicitly asks via the summary-bar button (revealSetupToken
	// bumps) or the inline toggle.
	const [setupOpen, setSetupOpen] = useState(false);
	useEffect(() => {
		if (revealSetupToken !== undefined && revealSetupToken > 0) {
			setSetupOpen(true);
		}
	}, [revealSetupToken]);

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
						? "Superset の browser MCP bridge がまだ起動していません。少し待って再試行してください。"
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

	const chromeDevtoolsCmdClaude = `claude mcp add chrome-devtools-mcp -s user -- npx -y chrome-devtools-mcp --browser-url ${data.httpBase}`;
	const chromeDevtoolsCmdCodex = `codex mcp add chrome-devtools-mcp -- npx -y chrome-devtools-mcp --browser-url ${data.httpBase}`;
	// browser-use's `--mcp` branch intentionally ignores `--cdp-url`
	// (skill_cli/main.py ~2280 routes straight to the MCP main without
	// forwarding the flag). The only officially supported injection
	// point is a config file referenced via BROWSER_USE_CONFIG_PATH
	// (see browser_use/config.py and mcp/server.py). The desktop app
	// writes that file per session at `data.browserUseConfigPath` and
	// we point browser-use at it here.
	const browserUseCmdClaude = `claude mcp add browser-use -s user -e BROWSER_USE_CONFIG_PATH=${data.browserUseConfigPath} -- uvx --from "browser-use[cli]" browser-use --mcp`;
	const browserUseCmdCodex = `codex mcp add browser-use --env BROWSER_USE_CONFIG_PATH=${data.browserUseConfigPath} -- uvx --from "browser-use[cli]" browser-use --mcp`;

	return (
		<div className="rounded-xl border p-3 bg-card/60 flex flex-col gap-3">
			<div>
				<div className="text-xs font-semibold">
					External browser MCP endpoint
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					Bound to pane{" "}
					<code className="rounded bg-muted px-1">{data.paneId}</code>. 以下の
					setup コマンドは **一度だけ** 実行すれば OK です。登録 URL
					は全セッション 共通で、接続ごとに呼び出し元のターミナル →
					LLMセッション → アタッチ中ペインを peer-PID
					解決してルーティングするため、 Superset / macOS
					の再起動、ペインの閉じ直し、別ターミナルから起動し直し等で MCP
					を登録し直す必要はありません。
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
				<button
					type="button"
					onClick={() => setSetupOpen((v) => !v)}
					className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
				>
					{setupOpen ? (
						<LuChevronUp className="size-3" />
					) : (
						<LuChevronDown className="size-3" />
					)}
					Example setup
					{!setupOpen && (
						<span className="ml-1 normal-case tracking-normal font-normal text-muted-foreground/60">
							(一度だけ実行すれば OK — 必要なら開いて参照)
						</span>
					)}
				</button>
				{setupOpen && (
					<div className="mt-1">
						<CommandBlock
							title="chrome-devtools-mcp (Claude Code)"
							cmd={chromeDevtoolsCmdClaude}
							onCopy={() =>
								copy(chromeDevtoolsCmdClaude, "chrome-devtools-mcp command")
							}
						/>
						<CommandBlock
							title="chrome-devtools-mcp (Codex)"
							cmd={chromeDevtoolsCmdCodex}
							onCopy={() =>
								copy(
									chromeDevtoolsCmdCodex,
									"chrome-devtools-mcp (codex) command",
								)
							}
						/>
						<CommandBlock
							title="browser-use (Claude Code)"
							cmd={browserUseCmdClaude}
							onCopy={() => copy(browserUseCmdClaude, "browser-use command")}
						/>
						<CommandBlock
							title="browser-use (Codex)"
							cmd={browserUseCmdCodex}
							onCopy={() =>
								copy(browserUseCmdCodex, "browser-use (codex) command")
							}
						/>
					</div>
				)}
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

/**
 * Standalone version of the "Example setup" section that works even
 * when no session is bound yet — the WebSocket/HTTP base are not
 * known until a binding exists, so the commands are rendered with
 * placeholder tokens that the user substitutes after binding.
 * Intended use: the "Show setup commands" button in the summary bar
 * wants to reveal setup instructions even before the user has bound
 * a session.
 */
export function PlaceholderSetupCommandsCard({
	revealToken,
	onDismiss,
}: {
	revealToken?: number;
	onDismiss?: () => void;
}) {
	const [open, setOpen] = useState(true);
	useEffect(() => {
		if (revealToken !== undefined && revealToken > 0) setOpen(true);
	}, [revealToken]);

	const copy = async (value: string, label: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied`);
		} catch {
			toast.error(`Failed to copy ${label.toLowerCase()}`);
		}
	};

	const HTTP = "http://127.0.0.1:<port>";
	const CFG = "<BROWSER_USE_CONFIG_PATH>";
	const chromeClaude = `claude mcp add chrome-devtools-mcp -s user -- npx -y chrome-devtools-mcp --browser-url ${HTTP}`;
	const chromeCodex = `codex mcp add chrome-devtools-mcp -- npx -y chrome-devtools-mcp --browser-url ${HTTP}`;
	const useClaude = `claude mcp add browser-use -s user -e BROWSER_USE_CONFIG_PATH=${CFG} -- uvx --from "browser-use[cli]" browser-use --mcp`;
	const useCodex = `codex mcp add browser-use --env BROWSER_USE_CONFIG_PATH=${CFG} -- uvx --from "browser-use[cli]" browser-use --mcp`;

	return (
		<div className="rounded-xl border border-dashed p-3 bg-card/40 flex flex-col gap-3">
			<div className="flex items-start gap-2">
				<div className="flex-1 min-w-0">
					<div className="text-xs font-semibold">Setup commands (template)</div>
					<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
						外部ブラウザ MCP (chrome-devtools-mcp / browser-use) を登録する
						ためのテンプレートです。プレースホルダ部分 (
						<code className="rounded bg-muted px-1">{HTTP}</code> /{" "}
						<code className="rounded bg-muted px-1">{CFG}</code>)
						は、セッションを bind すると実際の値に置き換わって CDP endpoint
						カードに表示されます。
					</div>
				</div>
				{onDismiss && (
					<button
						type="button"
						onClick={onDismiss}
						className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted/40"
					>
						×
					</button>
				)}
			</div>

			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
			>
				{open ? (
					<LuChevronUp className="size-3" />
				) : (
					<LuChevronDown className="size-3" />
				)}
				Example setup
			</button>
			{open && (
				<div>
					<CommandBlock
						title="chrome-devtools-mcp (Claude Code)"
						cmd={chromeClaude}
						onCopy={() => copy(chromeClaude, "chrome-devtools-mcp command")}
					/>
					<CommandBlock
						title="chrome-devtools-mcp (Codex)"
						cmd={chromeCodex}
						onCopy={() =>
							copy(chromeCodex, "chrome-devtools-mcp (codex) command")
						}
					/>
					<CommandBlock
						title="browser-use (Claude Code)"
						cmd={useClaude}
						onCopy={() => copy(useClaude, "browser-use command")}
					/>
					<CommandBlock
						title="browser-use (Codex)"
						cmd={useCodex}
						onCopy={() => copy(useCodex, "browser-use (codex) command")}
					/>
				</div>
			)}
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
