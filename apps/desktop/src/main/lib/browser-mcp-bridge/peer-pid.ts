import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Resolve the PID of the remote end of a loopback TCP connection on
 * macOS / Linux.
 *
 * macOS does not expose a TCP-equivalent of LOCAL_PEERPID, so we fall
 * back to `lsof` and filter by the remote side's ephemeral port. For a
 * loopback connection `lsof` returns two entries (server side, client
 * side); we identify the peer as the process whose *local* end matches
 * `remotePort`, not `ownPid`.
 *
 * The remote port is a 16-bit ephemeral chosen by the kernel for each
 * outbound connection, so collisions between concurrent connections
 * are effectively impossible in practice on a single host. We still
 * defend against race / reuse by rejecting results that could point
 * back to our own process.
 */
export async function resolvePeerPidFromRemotePort(
	remotePort: number,
	ownPid: number,
): Promise<number | null> {
	if (
		!Number.isInteger(remotePort) ||
		remotePort < 1 ||
		remotePort > 65_535
	) {
		return null;
	}
	try {
		const { stdout } = await execAsync(
			`lsof -nP -iTCP:${remotePort} -sTCP:ESTABLISHED 2>/dev/null || true`,
			{ timeout: 3_000, maxBuffer: 1024 * 1024 },
		);
		const text = stdout.trim();
		if (!text) return null;
		const lines = text.split("\n").slice(1); // skip header
		for (const line of lines) {
			const cols = line.trim().split(/\s+/);
			// Format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
			// NAME: 127.0.0.1:<localPort>->127.0.0.1:<peerPort> (ESTABLISHED)
			if (cols.length < 9) continue;
			const pid = Number.parseInt(cols[1] ?? "", 10);
			if (!Number.isFinite(pid) || pid <= 0) continue;
			if (pid === ownPid) continue; // this is our own (server) socket entry
			const name = cols.slice(8).join(" ");
			// The peer process is the one whose LOCAL endpoint is
			// 127.0.0.1:<remotePort>. The `->` separator is always
			// present on ESTABLISHED sockets.
			const match = name.match(
				/^(?:\[::1\]|127\.0\.0\.1):(\d+)->(?:\[::1\]|127\.0\.0\.1):(\d+)/,
			);
			if (!match) continue;
			const localPort = Number.parseInt(match[1] ?? "", 10);
			if (localPort === remotePort) return pid;
		}
		return null;
	} catch {
		return null;
	}
}
