import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const repoRoot = path.resolve(import.meta.dir, "../../..");

interface DesktopPackageJson {
	scripts: Record<string, string>;
	dependencies: Record<string, string>;
}

interface WorkflowStep {
	name?: string;
	run?: string;
	uses?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
	"working-directory"?: string;
}

interface WorkflowJob {
	if?: string;
	"runs-on"?: string;
	environment?: string;
	defaults?: unknown;
	steps: WorkflowStep[];
}

interface WorkflowFile {
	name: string;
	on: {
		push?: {
			tags?: string[];
		};
		workflow_dispatch?: {
			inputs?: Record<
				string,
				{
					description?: string;
					required?: boolean;
					type?: string;
				}
			>;
		};
	};
	permissions?: Record<string, string>;
	jobs: Record<string, WorkflowJob>;
}

function repoPath(relativePath: string): string {
	return path.join(repoRoot, relativePath);
}

function readRepoText(relativePath: string): string {
	return readFileSync(repoPath(relativePath), "utf8");
}

function readRepoJson<T>(relativePath: string): T {
	return JSON.parse(readRepoText(relativePath)) as T;
}

function readRepoYaml<T>(relativePath: string): T {
	return load(readRepoText(relativePath)) as T;
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
	const step = job.steps.find((item) => item.name === name);
	expect(step).toBeDefined();
	return step as WorkflowStep;
}

function expectRunContains(step: WorkflowStep, expected: string): void {
	expect(step.run ?? "").toContain(expected);
}

function getWorkflowTriggers(workflow: WorkflowFile): WorkflowFile["on"] {
	const raw = workflow as unknown as Record<string, WorkflowFile["on"]>;
	return workflow.on ?? raw.true;
}

function expectReleaseWorkflowBasics(
	workflow: WorkflowFile,
	jobName: string,
	expectedRunner: string,
): WorkflowJob {
	const triggers = getWorkflowTriggers(workflow);
	expect(triggers.push?.tags).toContain("v*-fork.*");
	expect(triggers.workflow_dispatch?.inputs?.tag?.required).toBe(true);
	expect(triggers.workflow_dispatch?.inputs?.tag?.type).toBe("string");
	expect(workflow.permissions?.contents).toBe("write");

	const job = workflow.jobs[jobName];
	expect(job).toBeDefined();
	expect(job.if).toBe("github.repository == 'MocA-Love/superset'");
	expect(job["runs-on"]).toBe(expectedRunner);
	expect(job.environment).toBe("production");

	const installStep = findStep(job, "Install workspace dependencies");
	expectRunContains(installStep, "bun install --frozen --ignore-scripts");

	const compileStep = findStep(job, "Compile app with electron-vite");
	expect(compileStep["working-directory"]).toBe("apps/desktop");
	expect(compileStep.env?.SUPERSET_WORKSPACE_NAME).toBe("superset");
	expect(compileStep.env).toHaveProperty("SENTRY_DSN_DESKTOP");
	expectRunContains(compileStep, "bun run compile:app");

	const browserMcpStep = findStep(
		job,
		"Build superset-browser-mcp single binary",
	);
	expect(browserMcpStep["working-directory"]).toBe("apps/desktop");
	expectRunContains(browserMcpStep, "bun run build:browser-mcp");

	const resolveTagStep = findStep(job, "Resolve target tag");
	expectRunContains(resolveTagStep, "inputs.tag");
	expectRunContains(resolveTagStep, "GITHUB_REF_NAME");

	return job;
}

describe("fork release and packaging invariants", () => {
	it("keeps desktop build scripts safe for fork releases", () => {
		const pkg = readRepoJson<DesktopPackageJson>("apps/desktop/package.json");

		expect(pkg.scripts["build:browser-mcp"]).toBe(
			"bun --cwd ../../packages/superset-browser-mcp run build:bin",
		);
		expect(pkg.scripts.prebuild).toContain("bun run build:browser-mcp");
		expect(pkg.scripts.prepackage).toContain("bun run build:browser-mcp");
		expect(pkg.scripts.build).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
		expect(pkg.scripts.build).toContain("electron-builder");
		expect(pkg.scripts.build).toContain("--publish never");
		expect(pkg.scripts["build:linux"]).toContain(
			"electron-builder --linux AppImage deb rpm --publish never",
		);
		expect(pkg.scripts["build:linux"]).toContain(
			"CSC_IDENTITY_AUTO_DISCOVERY=false",
		);
	});

	it("keeps electron-builder config aligned with fork distribution requirements", () => {
		const builder = readRepoText("apps/desktop/electron-builder.ts");

		expect(builder).toContain('size: "4g"');
		expect(builder).toContain(
			'from: "../../packages/superset-browser-mcp/dist"',
		);
		expect(builder).toContain('to: "resources/superset-browser-mcp"');
		expect(builder).toContain('"superset-browser-mcp"');
		expect(builder).toContain('"superset-browser-mcp.exe"');
		expect(builder).toContain('npmRebuild: process.platform !== "win32"');
		expect(builder).toContain('target: "nsis"');
		expect(builder).toContain('arch: ["x64"]');
		expect(builder).toContain('role: "Editor"');
		expect(builder).toContain('rank: "Alternate"');
	});

	it("keeps the Linux fork release workflow scoped and complete", () => {
		const workflow = readRepoYaml<WorkflowFile>(
			".github/workflows/release-desktop-linux-fork.yml",
		);
		const job = expectReleaseWorkflowBasics(
			workflow,
			"build-linux",
			"ubuntu-latest",
		);

		const packagingToolsStep = findStep(job, "Install packaging tools");
		expectRunContains(packagingToolsStep, "apt-get install");
		expectRunContains(packagingToolsStep, "rpm");

		const buildStep = findStep(
			job,
			"Build Linux packages (AppImage + deb + rpm)",
		);
		expect(buildStep["working-directory"]).toBe("apps/desktop");
		expect(buildStep.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
		expectRunContains(
			buildStep,
			"bunx electron-builder --linux AppImage deb rpm --publish never",
		);

		const verifyStep = findStep(job, "Verify Linux artifacts exist");
		for (const pattern of ["*.AppImage", "*.deb", "*.rpm", "*-linux.yml"]) {
			expectRunContains(verifyStep, pattern);
		}

		const releaseStep = findStep(
			job,
			"Attach Linux artifacts to GitHub Release",
		);
		const files = String(releaseStep.with?.files ?? "");
		expect(files).toContain("apps/desktop/release/*.AppImage");
		expect(files).toContain("apps/desktop/release/*.deb");
		expect(files).toContain("apps/desktop/release/*.rpm");
		expect(files).toContain("apps/desktop/release/*-linux.yml");
	});

	it("keeps the Windows fork release workflow scoped and complete", () => {
		const workflow = readRepoYaml<WorkflowFile>(
			".github/workflows/release-desktop-windows-fork.yml",
		);
		const job = expectReleaseWorkflowBasics(
			workflow,
			"build-windows",
			"windows-latest",
		);

		const longPathsStep = findStep(job, "Enable git long paths");
		expectRunContains(longPathsStep, "git config --global core.longpaths true");

		const buildStep = findStep(job, "Build Windows packages (NSIS)");
		expect(buildStep["working-directory"]).toBe("apps/desktop");
		expect(buildStep.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
		expectRunContains(
			buildStep,
			"bunx electron-builder --win --x64 --publish never",
		);

		const verifyStep = findStep(job, "Verify Windows artifacts exist");
		expectRunContains(verifyStep, "release/*.exe");
		expectRunContains(verifyStep, "release/latest.yml");

		const releaseStep = findStep(
			job,
			"Attach Windows artifacts to GitHub Release",
		);
		const files = String(releaseStep.with?.files ?? "");
		expect(files).toContain("apps/desktop/release/*.exe");
		expect(files).toContain("apps/desktop/release/*.exe.blockmap");
		expect(files).toContain("apps/desktop/release/latest.yml");
	});
});

describe("fork updater invariants", () => {
	it("keeps update checks pointed at MocA-Love/superset releases", () => {
		const updater = readRepoText("apps/desktop/src/main/lib/auto-updater.ts");
		const ownerTemplate = "$" + "{FORK_OWNER}";
		const repoTemplate = "$" + "{FORK_REPO}";

		expect(updater).toContain("const IS_FORK = true");
		expect(updater).toContain('const FORK_OWNER = "MocA-Love"');
		expect(updater).toContain('const FORK_REPO = "superset"');
		expect(updater).toContain(
			[
				"https://github.com/",
				ownerTemplate,
				"/",
				repoTemplate,
				"/releases",
			].join(""),
		);
		expect(updater).toContain(
			[
				"https://api.github.com/repos/",
				ownerTemplate,
				"/",
				repoTemplate,
				"/releases/latest",
			].join(""),
		);
		expect(updater).toContain("shell.openExternal(FORK_RELEASES_URL)");
		expect(updater).toContain("void checkForkForUpdates(false)");
		expect(updater).toContain("void checkForkForUpdates(true)");
		expect(updater).toContain("[auto-updater:fork] Initialized");
	});
});

describe("repo operation invariants", () => {
	it("keeps shared command and MCP config symlinks intact", () => {
		const expectedLinks = new Map([
			[".claude/commands", "../.agents/commands"],
			[".cursor/commands", "../.agents/commands"],
			[".cursor/mcp.json", "../.mcp.json"],
		]);

		for (const [relativePath, expectedTarget] of expectedLinks) {
			const absolutePath = repoPath(relativePath);
			expect(lstatSync(absolutePath).isSymbolicLink()).toBe(true);
			expect(readlinkSync(absolutePath)).toBe(expectedTarget);
		}
	});

	it("keeps Bun isolated linker enabled for this fork", () => {
		const bunfig = readRepoText("bunfig.toml");
		expect(bunfig).toContain('linker = "isolated"');
	});
});

describe("fork local database schema invariants", () => {
	it("keeps fork feature schema modules exported", () => {
		const requiredSchemaFiles = [
			"packages/local-db/src/schema/browser-automation-bindings.ts",
			"packages/local-db/src/schema/service-status-definitions.ts",
			"packages/local-db/src/schema/todo-prompt-presets.ts",
			"packages/local-db/src/schema/todo-schedules.ts",
			"packages/local-db/src/schema/todo-sessions.ts",
		];

		for (const relativePath of requiredSchemaFiles) {
			expect(existsSync(repoPath(relativePath))).toBe(true);
		}

		const indexFile = readRepoText("packages/local-db/src/schema/index.ts");
		for (const exportPath of [
			"./browser-automation-bindings",
			"./service-status-definitions",
			"./todo-prompt-presets",
			"./todo-schedules",
			"./todo-sessions",
		]) {
			expect(indexFile).toContain(exportPath);
		}
	});

	it("keeps settings columns used by fork features", () => {
		const schema = readRepoText("packages/local-db/src/schema/schema.ts");

		for (const column of [
			"aivis_enabled",
			"aivis_api_key",
			"aivis_model_uuid",
			"aivis_user_dictionary_uuid",
			"aivis_volume",
			"aivis_speaking_rate",
			"aivis_model_presets",
			"file_drag_behavior",
			"right_sidebar_open_view_width",
			"agent_preset_permissions_migrated_at",
		]) {
			expect(schema).toContain(column);
		}
	});
});

describe("fork host-service persistence invariants", () => {
	it("keeps Linux host-service spawns in a persistent systemd scope", () => {
		const coordinator = readRepoText(
			"apps/desktop/src/main/lib/host-service-coordinator.ts",
		);
		const persistence = readRepoText(
			"apps/desktop/src/main/lib/process-persistence.ts",
		);
		const organizationIdTemplate = "$" + "{organizationId}";
		const unitTemplate = "$" + "{unit}";

		expect(coordinator).toContain("killPersistentScope");
		expect(coordinator).toContain("spawnPersistent");
		expect(coordinator).toContain("scopeUnit: string | null");
		expect(coordinator).toContain("instance.scopeUnit = scopeUnit");
		expect(coordinator).toContain("detached: true");
		expect(coordinator).toContain("windowsHide: true");
		expect(coordinator).toContain(
			`unitLabel: \`superset-host-service-${organizationIdTemplate}\``,
		);
		expect(coordinator).toContain("result?.json?.version ?? result?.version");

		expect(persistence).toContain('"systemd-run"');
		expect(persistence).toContain('"--user"');
		expect(persistence).toContain('"--scope"');
		expect(persistence).toContain('"--collect"');
		expect(persistence).toContain('"systemctl"');
		expect(persistence).toContain('"kill"');
		expect(persistence).toContain(`scopeUnit: \`${unitTemplate}.scope\``);
	});
});

describe("fork ports integration invariants", () => {
	it("keeps fork port metadata compatible with local and remote port routing", () => {
		const sharedTypes = readRepoText("apps/desktop/src/shared/types/ports.ts");
		const desktopPortsRouter = readRepoText(
			"apps/desktop/src/lib/trpc/routers/ports/ports.ts",
		);
		const v1KillHook = readRepoText(
			"apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/PortsList/hooks/useKillPort.ts",
		);
		const v1Badge = readRepoText(
			"apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/PortsList/components/MergedPortBadge/MergedPortBadge.tsx",
		);
		const v1Group = readRepoText(
			"apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/PortsList/components/WorkspacePortGroup/WorkspacePortGroup.tsx",
		);

		for (const field of [
			"detected: boolean",
			"pid: number | null",
			"processName: string | null",
			"terminalId: string | null",
			"detectedAt: number | null",
			"address: string | null",
			"hostUrl: string | null",
		]) {
			expect(sharedTypes).toContain(field);
		}

		expect(desktopPortsRouter).toContain("buildLabelCache");
		expect(desktopPortsRouter).toContain("matchedStaticPorts");
		expect(desktopPortsRouter).toContain("detected: true");
		expect(desktopPortsRouter).toContain("detected: false");
		expect(desktopPortsRouter).toContain("terminalId: port.terminalId");
		expect(desktopPortsRouter).toContain("hostUrl: null");
		expect(desktopPortsRouter).toContain("workspaceId: z.string()");
		expect(desktopPortsRouter).toContain("terminalId: z.string()");

		expect(v1KillHook).toContain("FORK NOTE");
		expect(v1KillHook).toContain("workspaceId: port.workspaceId");
		expect(v1KillHook).toContain("terminalId: port.terminalId");
		expect(v1Badge).toContain("const isDetected = port.detected");
		expect(v1Badge).toContain("const canJumpToTerminal = !!port.terminalId");
		expect(v1Badge).toContain("Not detected");
		expect(v1Group).toContain("const detectedPorts = group.ports.filter");
		expect(v1Group).toContain("void killPorts(detectedPorts)");
	});

	it("keeps the shared port-scanner exports used by fork browser automation", () => {
		const pkg = readRepoJson<{ dependencies: Record<string, string> }>(
			"apps/desktop/package.json",
		);
		const portScannerIndex = readRepoText("packages/port-scanner/src/index.ts");
		const browserAutomation = readRepoText(
			"apps/desktop/src/lib/trpc/routers/browser-automation/index.ts",
		);
		const paneResolver = readRepoText(
			"apps/desktop/src/main/lib/browser-mcp-bridge/pane-resolver.ts",
		);
		const killTarget = readRepoText(
			"apps/desktop/src/renderer/hooks/ports/usePortKillActions/killPortTarget.ts",
		);

		expect(pkg.dependencies["@superset/port-scanner"]).toBe("workspace:*");
		for (const exportName of [
			"getListeningPortsForPids",
			"getProcessCommand",
			"getProcessName",
			"getProcessTree",
			"PortManager",
			"parseStaticPortsConfig",
		]) {
			expect(portScannerIndex).toContain(exportName);
		}
		expect(browserAutomation).toContain('from "@superset/port-scanner"');
		expect(paneResolver).toContain('from "@superset/port-scanner"');
		expect(paneResolver).toContain("getProcessCommand");
		expect(killTarget).toContain("getHostServiceClientByUrl");
		expect(killTarget).toContain("if (target.hostUrl)");
		expect(killTarget).toContain("ports.kill.mutate");
	});
});

describe("fork terminal vibrancy invariants", () => {
	it("keeps the WebGL rectangle alpha patch installed after renderer load", () => {
		const terminalAddons = readRepoText(
			"apps/desktop/src/renderer/lib/terminal/terminal-addons.ts",
		);
		const vibrancyStore = readRepoText(
			"apps/desktop/src/renderer/stores/vibrancy/store.ts",
		);

		expect(terminalAddons).toContain("installRectangleRendererAlphaPatch");
		expect(terminalAddons).toContain("terminal.loadAddon(webglAddon)");
		expect(terminalAddons).toContain(
			"installRectangleRendererAlphaPatch(webglAddon)",
		);
		expect(terminalAddons).toContain("options.onRendererChange?.()");
		expect(vibrancyStore).toContain("setRgbTransparencyForVibrancy");
		expect(vibrancyStore).toContain(
			"setRgbTransparencyForVibrancy(state.enabled)",
		);
		expect(vibrancyStore).toContain(
			'root.dataset.vibrancy = state.enabled ? "on" : "off"',
		);
		expect(vibrancyStore).toContain('--background", "transparent"');
	});
});

describe("fork language service invariants", () => {
	it("keeps TypeScript and Dart providers on real LSP backends", () => {
		const pkg = readRepoJson<DesktopPackageJson>("apps/desktop/package.json");
		const tsProvider = readRepoText(
			"apps/desktop/src/main/lib/language-services/providers/typescript/TypeScriptLanguageProvider.ts",
		);
		const dartProvider = readRepoText(
			"apps/desktop/src/main/lib/language-services/providers/dart/DartLanguageProvider.ts",
		);

		expect(pkg.dependencies["@vtsls/language-server"]).toBe("^0.3.0");
		expect(tsProvider).toContain("extends ExternalLspLanguageProvider");
		expect(tsProvider).toContain('packageName: "@vtsls/language-server"');
		expect(tsProvider).toContain('binName: "vtsls"');
		expect(tsProvider).toContain('args: ["--stdio"]');
		expect(tsProvider).toContain("maxTsServerMemory: 8192");

		expect(dartProvider).toContain("extends ExternalLspLanguageProvider");
		expect(dartProvider).toContain('"language-server"');
		expect(dartProvider).toContain('"--protocol=lsp"');
		expect(dartProvider).toContain("DART_SDK");
		expect(dartProvider).toContain("FLUTTER_ROOT");
	});

	it("keeps the expanded language-service capability surface wired through manager and tRPC", () => {
		const manager = readRepoText(
			"apps/desktop/src/main/lib/language-services/manager.ts",
		);
		const routerFile = readRepoText(
			"apps/desktop/src/lib/trpc/routers/language-services/index.ts",
		);
		const types = readRepoText(
			"apps/desktop/src/main/lib/language-services/types.ts",
		);

		for (const method of [
			"getTypeDefinition",
			"getImplementation",
			"getDocumentHighlights",
			"getCompletion",
			"resolveCompletionItem",
			"getSignatureHelp",
			"getCodeActions",
			"resolveCodeAction",
			"prepareRename",
			"rename",
			"applyWorkspaceEdit",
			"getInlayHints",
			"getSemanticTokens",
			"getSemanticTokensLegend",
			"getDocumentSymbols",
		]) {
			expect(manager).toContain(method);
			expect(routerFile).toContain(method);
			expect(types).toContain(method);
		}
		expect(manager).toContain("reject stale `TextDocumentEdit`");
		expect(manager).toContain("fs.rename");
	});
});

describe("fork vibrancy invariants", () => {
	it("keeps cross-platform vibrancy state, routing, and restart awareness wired", () => {
		const sharedTypes = readRepoText(
			"apps/desktop/src/shared/vibrancy-types.ts",
		);
		const mainVibrancy = readRepoText(
			"apps/desktop/src/main/lib/vibrancy/index.ts",
		);
		const routerIndex = readRepoText(
			"apps/desktop/src/lib/trpc/routers/index.ts",
		);
		const vibrancyRouter = readRepoText(
			"apps/desktop/src/lib/trpc/routers/vibrancy.ts",
		);
		const store = readRepoText(
			"apps/desktop/src/renderer/stores/vibrancy/store.ts",
		);

		expect(sharedTypes).toContain('export type VibrancyBlurLevel = "subtle"');
		expect(sharedTypes).toContain("blurRadius: number");
		expect(sharedTypes).toContain("VIBRANCY_OPACITY_MIN = 0");
		expect(sharedTypes).toContain("VIBRANCY_OPACITY_MAX = 100");
		expect(sharedTypes).toContain("VIBRANCY_BLUR_RADIUS_MIN = 0");
		expect(sharedTypes).toContain("VIBRANCY_BLUR_RADIUS_MAX = 100");

		expect(mainVibrancy).toContain("@superset/macos-window-blur");
		expect(mainVibrancy).toContain("setWindowBlurRadius");
		expect(mainVibrancy).toContain("isNativeContinuousBlurSupported");
		expect(mainVibrancy).toContain("getBootTransparent");
		expect(mainVibrancy).toContain("getInitialWindowOptions");
		expect(mainVibrancy).toContain(
			'backgroundMaterial: state.enabled ? "acrylic" : "none"',
		);
		expect(mainVibrancy).toContain("transparent: true");

		expect(routerIndex).toContain("createVibrancyRouter");
		expect(routerIndex).toContain("vibrancy: createVibrancyRouter(wm)");
		expect(vibrancyRouter).toContain("bootTransparent: getBootTransparent()");
		expect(vibrancyRouter).toContain("nativeBlurSupported");
		expect(vibrancyRouter).toContain("vibrancyEmitter.emit");
		expect(vibrancyRouter).toContain("VIBRANCY_EVENTS.CHANGED");
		expect(store).toContain("bootTransparent");
		expect(store).toContain("nativeBlurSupported");
		expect(store).toContain("electronTrpcClient.vibrancy.onChanged.subscribe");
	});
});
