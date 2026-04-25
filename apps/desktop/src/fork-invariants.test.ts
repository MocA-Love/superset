import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const repoRoot = path.resolve(import.meta.dir, "../../..");

interface DesktopPackageJson {
	scripts: Record<string, string>;
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
