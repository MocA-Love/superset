import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

interface PlaySoundCallbacks {
	onComplete?: () => void;
	isCanceled?: () => boolean;
	onProcessChange?: (process: ChildProcess) => void;
}

/**
 * Plays a sound file at the given volume using platform-specific commands.
 * Returns the primary ChildProcess, or null if playback was skipped.
 *
 * - macOS: afplay -v (0.0-1.0)
 * - Linux: paplay --volume (0-65536), with aplay fallback
 * - Windows: PowerShell + System.Media.SoundPlayer (WAV) or MediaPlayer (other).
 *   System.Media.SoundPlayer doesn't support volume control, so the requested
 *   volume is honored only as a mute toggle (volume === 0 → skip playback).
 */
export function playSoundFile(
	soundPath: string,
	volume: number = 100,
	callbacks?: PlaySoundCallbacks,
): ChildProcess | null {
	if (!existsSync(soundPath)) {
		console.warn(`[play-sound] Sound file not found: ${soundPath}`);
		return null;
	}

	const volumeDecimal = volume / 100;

	if (process.platform === "darwin") {
		return execFile("afplay", ["-v", volumeDecimal.toString(), soundPath], () =>
			callbacks?.onComplete?.(),
		);
	}

	if (process.platform === "win32") {
		if (volume === 0) {
			callbacks?.onComplete?.();
			return null;
		}
		// PowerShell arguments are single-quoted to avoid shell injection; any
		// single quote in the path is escaped per PowerShell conventions.
		const escapedPath = soundPath.replace(/'/g, "''");
		const isWav = /\.wav$/i.test(soundPath);
		const script = isWav
			? `$p = New-Object Media.SoundPlayer '${escapedPath}'; $p.PlaySync()`
			: `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([System.Uri]::new('${escapedPath}')); $p.Volume = ${volumeDecimal}; $p.Play(); Start-Sleep -Milliseconds 500; while ($p.NaturalDuration.HasTimeSpan -and $p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 200 }`;
		return execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true },
			() => callbacks?.onComplete?.(),
		);
	}

	// Linux: paplay --volume accepts 0-65536 (65536 = 100%)
	const paVolume = Math.round(volumeDecimal * 65536);
	return execFile(
		"paplay",
		["--volume", paVolume.toString(), soundPath],
		(error) => {
			if (error) {
				if (callbacks?.isCanceled?.()) {
					callbacks?.onComplete?.();
					return;
				}
				if (volume === 0) {
					callbacks?.onComplete?.();
					return;
				}
				const fallback = execFile("aplay", [soundPath], () =>
					callbacks?.onComplete?.(),
				);
				callbacks?.onProcessChange?.(fallback);
				return;
			}
			callbacks?.onComplete?.();
		},
	);
}
