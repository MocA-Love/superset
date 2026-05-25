import { spawn } from "node:child_process";

type Candidate = { command: string; args?: string[] };

function nativeCandidates(): Candidate[] {
	switch (process.platform) {
		case "darwin":
			return [{ command: "pbcopy" }];
		case "win32":
			return [{ command: "clip" }];
		default:
			return [
				{ command: "wl-copy" },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "xsel", args: ["--clipboard", "--input"] },
			];
	}
}

function tryCandidate(text: string, candidate: Candidate): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(candidate.command, candidate.args ?? [], {
				stdio: ["pipe", "ignore", "ignore"],
			});
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
		child.stdin?.on("error", () => resolve(false));
		child.stdin?.end(text);
	});
}

function emitOsc52(text: string): boolean {
	if (!process.stdout.isTTY) return false;
	const payload = Buffer.from(text, "utf8").toString("base64");
	process.stdout.write(`\x1b]52;c;${payload}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<boolean> {
	const osc = emitOsc52(text);
	let native = false;
	for (const candidate of nativeCandidates()) {
		if (await tryCandidate(text, candidate)) {
			native = true;
			break;
		}
	}
	return osc || native;
}
