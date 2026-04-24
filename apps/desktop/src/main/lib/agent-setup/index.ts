import fs from "node:fs";
import { PLATFORM } from "shared/constants";
import { setupDesktopAgentCapabilities } from "./desktop-agent-setup";
import {
	BASH_DIR,
	BIN_DIR,
	HOOKS_DIR,
	OPENCODE_PLUGIN_DIR,
	ZSH_DIR,
} from "./paths";
import {
	createBashWrapper,
	createZshWrapper,
	getCommandShellArgs,
	getShellArgs,
	getShellEnv,
} from "./shell-wrappers";

export function setupAgentHooks(): void {
	console.log("[agent-setup] Initializing agent hooks...");

	// Only the bash/zsh rc wrappers and the PATH-injection bin directory are
	// strictly Unix-only; HOOKS_DIR and OPENCODE_PLUGIN_DIR are platform-neutral.
	fs.mkdirSync(HOOKS_DIR, { recursive: true });
	fs.mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });
	if (!PLATFORM.IS_WINDOWS) {
		fs.mkdirSync(BIN_DIR, { recursive: true });
		fs.mkdirSync(ZSH_DIR, { recursive: true });
		fs.mkdirSync(BASH_DIR, { recursive: true });
	}

	setupDesktopAgentCapabilities();

	if (!PLATFORM.IS_WINDOWS) {
		createZshWrapper();
		createBashWrapper();
	} else {
		console.log(
			"[agent-setup] Skipping bash/zsh rc wrappers on Windows — hooks.json / settings.json integration still active",
		);
	}

	console.log("[agent-setup] Agent hooks initialized");
}

export function getSupersetBinDir(): string {
	return BIN_DIR;
}

export { getCommandShellArgs, getShellArgs, getShellEnv };
