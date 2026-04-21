import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { LuCheck, LuChevronDown, LuInfo } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { ServerCommand } from "renderer/stores/browser-automation";

interface McpInstallPanelProps {
	serverCommand?: ServerCommand;
}

/**
 * One-click installer for the bundled `superset-browser-mcp` into Claude
 * Code and/or Codex. The canonical command comes from the app itself
 * (getMcpStatus.serverCommand) so we never hand the user a stub command
 * that would fail to start. Re-installing corrects stale registrations
 * whose command paths no longer match the current bundled binary.
 */
export function McpInstallPanel({ serverCommand }: McpInstallPanelProps) {
	const utils = electronTrpc.useUtils();
	const { data: state, isLoading } =
		electronTrpc.browserAutomation.getMcpInstallState.useQuery(undefined, {
			refetchOnWindowFocus: true,
			refetchInterval: 30_000,
		});
	const installMutation =
		electronTrpc.browserAutomation.installMcp.useMutation();

	const canInstallClaude = state?.claude.cliFound ?? false;
	const canInstallCodex = state?.codex.cliFound ?? false;

	const [claudeChecked, setClaudeChecked] = useState(true);
	const [codexChecked, setCodexChecked] = useState(false);
	const [expanded, setExpanded] = useState(false);

	// Collapse to a single "all good" banner when every CLI-found runtime is
	// already installed with a matching command. Showing the full install UI
	// in that case reads as "something is wrong" even though nothing is.
	const claudeReady =
		!state?.claude.cliFound ||
		(state.claude.installed && state.claude.matchesExpected);
	const codexReady =
		!state?.codex.cliFound ||
		(state.codex.installed && state.codex.matchesExpected);
	const anyCliFound = canInstallClaude || canInstallCodex;
	const allInstalled = anyCliFound && claudeReady && codexReady;
	const readyLabels = [
		canInstallClaude ? "Claude Code" : null,
		canInstallCodex ? "Codex" : null,
	].filter((v): v is string => v !== null);

	if (serverCommand && !serverCommand.available) {
		return (
			<div className="rounded-xl border p-3 bg-card/60">
				<div className="text-xs font-semibold">
					Browser MCP binary is not available in this build
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					The bundled <code>superset-browser-mcp</code> executable is missing
					from this install (expected at{" "}
					<code className="rounded bg-muted px-1">{serverCommand.command}</code>
					). Use a dev build or wait for the next desktop release.
				</div>
			</div>
		);
	}

	const targets = [
		claudeChecked && canInstallClaude ? ("claude" as const) : null,
		codexChecked && canInstallCodex ? ("codex" as const) : null,
	].filter((t): t is "claude" | "codex" => t !== null);

	const handleInstall = async () => {
		try {
			const result = await installMutation.mutateAsync({ targets });
			const okTargets = Object.entries(result)
				.filter(([_, v]) => v.ok)
				.map(([k]) => k);
			const failedTargets = Object.entries(result)
				.filter(([_, v]) => v.ok === false && v.error)
				.map(([k, v]) => `${k}: ${v.error ?? "unknown"}`);
			if (okTargets.length > 0) {
				toast.success(
					`Registered superset-browser in ${okTargets.join(" + ")}. Restart the agent (or run /mcp in Claude) to pick it up.`,
				);
			}
			if (failedTargets.length > 0) {
				toast.error(`Install failed for: ${failedTargets.join("; ")}`);
			}
			await utils.browserAutomation.getMcpInstallState.invalidate();
			await utils.browserAutomation.getMcpStatus.invalidate();
		} catch (error) {
			toast.error(
				`Install failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	if (allInstalled && !expanded) {
		return (
			<div className="flex flex-col gap-3">
				<div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 flex items-center gap-2">
					<LuCheck className="size-4 text-emerald-300 shrink-0" />
					<div className="flex-1 min-w-0">
						<div className="text-[12px] font-medium text-emerald-300">
							Browser MCP is installed — ready to connect
						</div>
						{readyLabels.length > 0 && (
							<div className="text-[10px] text-muted-foreground">
								{readyLabels.join(" · ")}
							</div>
						)}
					</div>
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
					>
						Manage
						<LuChevronDown className="size-3" />
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-xl border p-3 bg-card/60">
				<div className="text-xs font-semibold">
					Install Superset Browser MCP
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					Pick which LLM runtime(s) should be able to drive the browser pane.
					Installing is a one-shot operation; after this you just bind panes
					from the Connect dialog. Already-installed runtimes are kept
					idempotent — re-installing corrects stale paths.
				</div>

				<div className="mt-3 flex flex-col gap-2">
					<TargetRow
						label="Claude Code"
						subLabel={
							state?.claude.cliFound
								? state.claude.installed
									? state.claude.matchesExpected
										? "✓ installed and up to date"
										: "⚠ installed with a different command — re-install to correct"
									: "claude CLI found, not yet installed"
								: "claude CLI not found on PATH"
						}
						checked={claudeChecked && canInstallClaude}
						disabled={!canInstallClaude || isLoading}
						onChange={setClaudeChecked}
					/>
					<TargetRow
						label="Codex"
						subLabel={
							state?.codex.cliFound
								? state.codex.installed
									? state.codex.matchesExpected
										? "✓ installed and up to date"
										: "⚠ installed with a different command — re-install to correct"
									: "codex CLI found, not yet installed"
								: "codex CLI not found on PATH"
						}
						checked={codexChecked && canInstallCodex}
						disabled={!canInstallCodex || isLoading}
						onChange={setCodexChecked}
					/>
				</div>

				<div className="mt-3 flex gap-2">
					<Button
						size="sm"
						disabled={targets.length === 0 || installMutation.isPending}
						onClick={handleInstall}
					>
						{installMutation.isPending ? "Installing..." : "Install"}
					</Button>
				</div>

				{serverCommand && (
					<div className="mt-3 text-[10px] text-muted-foreground">
						<LuInfo className="inline size-3 align-middle mr-1" />
						Will register the command{" "}
						<code className="rounded bg-muted px-1">
							{[serverCommand.command, ...serverCommand.args].join(" ")}
						</code>
						.
					</div>
				)}
			</div>
		</div>
	);
}

function TargetRow({
	label,
	subLabel,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	subLabel: string;
	checked: boolean;
	disabled: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div
			className={`flex items-start gap-2 rounded-md border p-2 ${
				disabled ? "opacity-60" : ""
			}`}
		>
			<Checkbox
				checked={checked}
				disabled={disabled}
				onCheckedChange={(v) => onChange(v === true)}
				className="mt-0.5"
				aria-label={label}
			/>
			<span className="flex flex-col gap-0.5">
				<span className="text-xs font-medium">{label}</span>
				<span className="text-[11px] text-muted-foreground">{subLabel}</span>
			</span>
		</div>
	);
}
