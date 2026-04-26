import { spawnSync } from "node:child_process";
import path from "node:path";
import { ExternalLspLanguageProvider } from "../../lsp/ExternalLspLanguageProvider";

const SPAWN_TIMEOUT_MS = 10_000;

function canExecute(command: string, shell: boolean): boolean {
	const probe = spawnSync(command, ["--version"], {
		stdio: "ignore",
		shell,
		timeout: SPAWN_TIMEOUT_MS,
	});
	return probe.status === 0;
}

function getEnvCandidateCommands(): string[] {
	const executableName = process.platform === "win32" ? "dart.exe" : "dart";
	const wrapperName = process.platform === "win32" ? "dart.bat" : "dart";
	return [
		process.env.DART_SDK
			? path.join(process.env.DART_SDK, "bin", executableName)
			: null,
		process.env.FLUTTER_ROOT
			? path.join(process.env.FLUTTER_ROOT, "bin", wrapperName)
			: null,
		process.env.FLUTTER_ROOT
			? path.join(
					process.env.FLUTTER_ROOT,
					"bin",
					"cache",
					"dart-sdk",
					"bin",
					executableName,
				)
			: null,
	].filter((candidate): candidate is string => Boolean(candidate));
}

function resolveFlutterSdkCommands(): string[] {
	const flutterCommand =
		process.platform === "win32" ? "flutter.bat" : "flutter";
	const locateCommand = process.platform === "win32" ? "where" : "which";
	const locateResult = spawnSync(locateCommand, [flutterCommand], {
		encoding: "utf8",
		shell: process.platform === "win32",
		timeout: SPAWN_TIMEOUT_MS,
	});
	if (locateResult.status !== 0 || !locateResult.stdout) {
		return [];
	}

	const flutterExecutablePath = locateResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!flutterExecutablePath) {
		return [];
	}

	const flutterBinDir = path.dirname(flutterExecutablePath);
	const executableName = process.platform === "win32" ? "dart.exe" : "dart";
	const wrapperName = process.platform === "win32" ? "dart.bat" : "dart";

	return [
		path.join(flutterBinDir, wrapperName),
		path.join(flutterBinDir, "cache", "dart-sdk", "bin", executableName),
	];
}

function resolveDartCommand(): { command: string; shell: boolean } | null {
	const pathCommand = process.platform === "win32" ? "dart.bat" : "dart";
	const shell = process.platform === "win32";
	if (canExecute(pathCommand, shell)) {
		return { command: pathCommand, shell };
	}

	for (const candidate of [
		...getEnvCandidateCommands(),
		...resolveFlutterSdkCommands(),
	]) {
		if (!canExecute(candidate, false)) {
			continue;
		}
		return { command: candidate, shell: false };
	}

	return null;
}

const DART_LANGUAGE_SERVER_ARGS = [
	"language-server",
	"--client-id=superset-desktop",
	"--client-version=1.0",
	"--protocol=lsp",
];

export class DartLanguageProvider extends ExternalLspLanguageProvider {
	constructor() {
		super({
			id: "dart",
			label: "Dart",
			description:
				"Dart and Flutter language services via the Dart analysis server (LSP mode).",
			languageIds: ["dart"],
			defaultSource: "dart",
			resolveServerCommand: () => {
				const resolved = resolveDartCommand();
				if (!resolved) {
					return null;
				}
				return {
					command: resolved.command,
					args: DART_LANGUAGE_SERVER_ARGS,
					shell: resolved.shell,
				};
			},
			initializationOptions: {
				closingLabels: true,
				outline: true,
				flutterOutline: true,
				suggestFromUnimportedLibraries: true,
			},
			onCustomNotification: (_args, message) => {
				switch (message.method) {
					case "dart/textDocument/publishClosingLabels":
					case "dart/textDocument/publishOutline":
					case "dart/textDocument/publishFlutterOutline":
						return;
					default:
						return;
				}
			},
		});
	}
}
