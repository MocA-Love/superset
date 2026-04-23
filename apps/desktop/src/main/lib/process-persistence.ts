/**
 * Process persistence helper for cross-platform "detached daemon" spawning.
 *
 * On macOS/Windows, Node's `detached: true` + `child.unref()` is enough:
 * the child survives the parent's exit. On modern Linux with systemd-logind
 * user scopes (Ubuntu 22.04+, Fedora, Arch, etc.), every GUI app runs inside
 * an `app-*.scope` cgroup. When the scope's main PID (Electron) exits,
 * systemd kills every process in the cgroup — including `setsid`-detached
 * children. The `detached` flag only separates the POSIX session; it does
 * not escape the cgroup.
 *
 * This helper wraps the spawn in `systemd-run --user --scope` on Linux so
 * the daemon lands in its own transient scope, outside Electron's cgroup.
 * When `systemd-run` or a user D-Bus session is unavailable we fall back
 * to a plain spawn — matches current behaviour rather than failing hard.
 */
import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";

export interface SpawnPersistentExtraOptions {
	/** Stable label used to build the systemd unit name on Linux. */
	unitLabel: string;
}

let systemdRunAvailable: boolean | null = null;

function canUseSystemdRun(): boolean {
	if (systemdRunAvailable !== null) return systemdRunAvailable;

	if (process.platform !== "linux") {
		systemdRunAvailable = false;
		return false;
	}

	// `systemd-run --user` needs a D-Bus user session. Without it the call
	// fails with "Failed to connect to user bus" (e.g. raw SSH, containers).
	if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) {
		systemdRunAvailable = false;
		return false;
	}

	try {
		childProcess.execFileSync("systemd-run", ["--version"], {
			stdio: "ignore",
			timeout: 2000,
		});
		systemdRunAvailable = true;
	} catch {
		systemdRunAvailable = false;
	}
	return systemdRunAvailable;
}

function buildUnitName(label: string): string {
	// systemd unit names accept only [A-Za-z0-9:_.\\-]. Replace anything else
	// so callers can pass identifiers (e.g. organizationId) straight through.
	const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "_");
	const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
	// systemd caps unit names at 256 chars including the ".scope" suffix that
	// systemd-run appends. Leave headroom for the suffix we add below.
	const maxLabelLen = 200;
	const truncated =
		safeLabel.length > maxLabelLen
			? safeLabel.slice(0, maxLabelLen)
			: safeLabel;
	return `${truncated}-${suffix}`;
}

/**
 * Spawn a daemon that must outlive the current Electron process.
 *
 * Caller is responsible for `detached: true` + `child.unref()` in `options` —
 * this helper does not set them, because the non-Linux fallback path relies
 * on them and a few call sites need to condition them on `app.isPackaged`.
 */
export function spawnPersistent(
	execPath: string,
	args: ReadonlyArray<string>,
	options: childProcess.SpawnOptions,
	extra: SpawnPersistentExtraOptions,
): childProcess.ChildProcess {
	if (!canUseSystemdRun()) {
		return childProcess.spawn(execPath, [...args], options);
	}

	const unit = buildUnitName(extra.unitLabel);
	const systemdArgs = [
		"--user",
		"--scope",
		// Auto-remove the scope unit once all processes exit. Without this
		// `systemctl --user list-units` accumulates a dead-scope entry per run.
		"--collect",
		// Suppress "Running scope as unit: xxx.scope" info lines that would
		// otherwise land in our logFd-backed stdio.
		"--quiet",
		`--unit=${unit}`,
		"--",
		execPath,
		...args,
	];

	try {
		return childProcess.spawn("systemd-run", systemdArgs, options);
	} catch (error) {
		console.warn(
			`[spawnPersistent] systemd-run spawn failed, falling back to plain spawn: ${String(error)}`,
		);
		return childProcess.spawn(execPath, [...args], options);
	}
}
