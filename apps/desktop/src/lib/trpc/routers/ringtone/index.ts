import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import { dialog } from "electron";
import {
	deleteCustomRingtone,
	getCustomRingtoneEditState,
	getCustomRingtoneInfo,
	getCustomRingtonePath,
	getCustomRingtoneSourcePath,
	importCustomRingtoneFromPath,
	setCustomRingtoneDisplayName,
} from "main/lib/custom-ringtones";
import { playSoundFile } from "main/lib/play-sound";
import { getSoundPath } from "main/lib/sound-paths";
import {
	getTempAudioPath,
	registerTempAudio,
	unregisterTempAudio,
} from "main/lib/temp-audio-protocol";
import {
	checkMissingBinaries,
	cleanupTempAudio,
	downloadFullYouTubeAudio,
	getBufferedInstallEvents,
	type InstallProgressEvent,
	importRingtoneFromYouTube,
	installMissingBinaries,
	subscribeInstallEvents,
	YouTubeRingtoneError,
} from "main/lib/youtube-ringtone";
import {
	CUSTOM_RINGTONE_ID,
	getRingtoneFilename,
	isBuiltInRingtoneId,
} from "shared/ringtones";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Track current playing session to handle race conditions.
 * Each play operation gets a unique session ID. When stop is called,
 * the session is invalidated so any pending fallback processes won't start.
 */
let currentSession: {
	id: number;
	process: ChildProcess | null;
} | null = null;
let nextSessionId = 0;

/**
 * Stops the currently playing sound and invalidates the session
 */
function stopCurrentSound(): void {
	if (currentSession) {
		if (currentSession.process) {
			// Use SIGKILL for immediate termination (afplay doesn't always respond to SIGTERM)
			currentSession.process.kill("SIGKILL");
		}
		currentSession = null;
	}
}

/**
 * Plays a sound file with session tracking for stop/race-condition safety.
 */
function playWithTracking(soundPath: string, volume: number = 100): void {
	stopCurrentSound();

	const sessionId = nextSessionId++;
	currentSession = { id: sessionId, process: null };

	const proc = playSoundFile(soundPath, volume, {
		onComplete: () => {
			if (currentSession?.id === sessionId) {
				currentSession = null;
			}
		},
		isCanceled: () => currentSession?.id !== sessionId,
		onProcessChange: (newProc) => {
			if (currentSession?.id === sessionId) {
				currentSession.process = newProc;
			}
		},
	});

	if (proc) {
		currentSession.process = proc;
	} else {
		currentSession = null;
	}
}

function getRingtoneSoundPath(ringtoneId: string): string | null {
	if (!ringtoneId || ringtoneId === "") {
		return null;
	}

	if (ringtoneId === CUSTOM_RINGTONE_ID) {
		return getCustomRingtonePath();
	}

	if (!isBuiltInRingtoneId(ringtoneId)) {
		return null;
	}

	const filename = getRingtoneFilename(ringtoneId);
	if (!filename) {
		return null;
	}

	return getSoundPath(filename);
}

/**
 * Ringtone router for audio preview and playback operations
 */
export const createRingtoneRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		/**
		 * Preview a ringtone by ringtone ID.
		 */
		preview: publicProcedure
			.input(
				z.object({
					ringtoneId: z.string(),
					volume: z.number().min(0).max(100).optional(),
				}),
			)
			.mutation(({ input }) => {
				const soundPath = getRingtoneSoundPath(input.ringtoneId);
				if (!soundPath) {
					return { success: true as const };
				}

				playWithTracking(soundPath, input.volume ?? 100);
				return { success: true as const };
			}),

		/**
		 * Stop the currently playing ringtone preview
		 */
		stop: publicProcedure.mutation(() => {
			stopCurrentSound();
			return { success: true as const };
		}),

		/**
		 * Returns metadata for the imported custom ringtone, if one exists.
		 */
		getCustom: publicProcedure.query(() => {
			return getCustomRingtoneInfo();
		}),

		/**
		 * Imports a custom ringtone file from disk and stores it in the Superset home assets directory.
		 */
		importCustom: publicProcedure.mutation(async () => {
			const window = getWindow();
			const openDialogOptions: OpenDialogOptions = {
				properties: ["openFile"],
				title: "Select Notification Sound",
				filters: [
					{
						name: "Audio",
						extensions: ["mp3", "wav", "ogg"],
					},
				],
			};
			const result = window
				? await dialog.showOpenDialog(window, openDialogOptions)
				: await dialog.showOpenDialog(openDialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { canceled: true as const, ringtone: null };
			}

			try {
				const ringtone = await importCustomRingtoneFromPath(
					result.filePaths[0],
				);
				return { canceled: false as const, ringtone };
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Failed to import custom ringtone",
				});
			}
		}),

		/**
		 * Deletes the imported custom ringtone (audio file + metadata).
		 */
		deleteCustom: publicProcedure.mutation(() => {
			stopCurrentSound();
			deleteCustomRingtone();
			return { success: true as const };
		}),

		/**
		 * Renames the custom ringtone's display name.
		 */
		renameCustom: publicProcedure
			.input(z.object({ name: z.string().min(1).max(80) }))
			.mutation(({ input }) => {
				try {
					setCustomRingtoneDisplayName(input.name);
					const info = getCustomRingtoneInfo();
					if (!info) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "No custom ringtone to rename.",
						});
					}
					return { ringtone: info };
				} catch (error) {
					if (error instanceof TRPCError) throw error;
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error
								? error.message
								: "Failed to rename custom ringtone",
					});
				}
			}),

		/**
		 * Check which required binaries (yt-dlp, ffmpeg) are missing.
		 */
		checkBinaries: publicProcedure.query(async () => {
			const missing = await checkMissingBinaries();
			return { missing };
		}),

		/**
		 * Install yt-dlp and ffmpeg via Homebrew (macOS only).
		 * Log events are streamed via `installProgress` subscription keyed on installId.
		 */
		installBinaries: publicProcedure
			.input(z.object({ installId: z.string().min(1) }))
			.mutation(async ({ input }) => {
				try {
					await installMissingBinaries(input.installId);
					return { success: true as const };
				} catch (error) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to install dependencies",
					});
				}
			}),

		/**
		 * Subscribe to install progress events for a given installId.
		 * Emits buffered events on connect (replay) plus live events.
		 */
		installProgress: publicProcedure
			.input(z.object({ installId: z.string().min(1) }))
			.subscription(({ input }) => {
				return observable<InstallProgressEvent>((emit) => {
					let lastSeq = 0;
					const deliver = (event: InstallProgressEvent) => {
						if (event.seq <= lastSeq) return;
						lastSeq = event.seq;
						emit.next(event);
					};
					const unsubscribe = subscribeInstallEvents(input.installId, deliver);
					for (const event of getBufferedInstallEvents(input.installId)) {
						deliver(event);
					}
					return () => {
						unsubscribe();
					};
				});
			}),

		/**
		 * Download the full audio from a YouTube URL to a temp file.
		 * Returns a tempId for use with the superset-temp-audio protocol and video metadata.
		 */
		downloadYouTubeAudio: publicProcedure
			.input(z.object({ url: z.string().min(1) }))
			.mutation(async ({ input }) => {
				try {
					const result = await downloadFullYouTubeAudio(input.url);
					return {
						tempId: result.tempId,
						info: result.info,
					};
				} catch (error) {
					if (error instanceof YouTubeRingtoneError) {
						throw new TRPCError({
							code:
								error.code === "BINARY_MISSING" ||
								error.code === "TIMEOUT" ||
								error.code === "VIDEO_TOO_LONG"
									? "PRECONDITION_FAILED"
									: "BAD_REQUEST",
							message: error.message,
						});
					}
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to download YouTube audio",
					});
				}
			}),

		/**
		 * Clean up a previously downloaded temp audio file.
		 */
		cleanupTempAudio: publicProcedure
			.input(z.object({ tempId: z.string() }))
			.mutation(async ({ input }) => {
				await cleanupTempAudio(input.tempId);
				return { success: true as const };
			}),

		/**
		 * Returns the saved edit parameters for the current custom ringtone,
		 * or null if the ringtone was not produced by the clip editor.
		 */
		getCustomEditState: publicProcedure.query(() => {
			return getCustomRingtoneEditState();
		}),

		/**
		 * Registers the saved source audio with the temp-audio protocol so
		 * the clip editor can stream it for preview & waveform. Returns
		 * `null` if no source is available (user can only re-import fresh).
		 */
		openCustomSource: publicProcedure.mutation(() => {
			const sourcePath = getCustomRingtoneSourcePath();
			if (!sourcePath) {
				return { tempId: null as string | null };
			}
			const tempId = randomUUID();
			registerTempAudio(tempId, sourcePath);
			return { tempId };
		}),

		/**
		 * Release the temp-audio registration returned by `openCustomSource`.
		 * Does NOT delete the persisted source file.
		 */
		closeCustomSource: publicProcedure
			.input(z.object({ tempId: z.string() }))
			.mutation(({ input }) => {
				unregisterTempAudio(input.tempId);
				return { success: true as const };
			}),

		/**
		 * Re-produce the custom ringtone by re-running the ffmpeg clip
		 * pipeline on the saved source audio with new parameters.
		 */
		reEditCustom: publicProcedure
			.input(
				z.object({
					startSeconds: z
						.number()
						.min(0)
						.max(60 * 60 * 12),
					endSeconds: z
						.number()
						.min(0)
						.max(60 * 60 * 12),
					displayName: z.string().max(120).optional(),
					fadeInSeconds: z.number().min(0).max(10).optional(),
					fadeOutSeconds: z.number().min(0).max(10).optional(),
					playbackRate: z.number().min(0.5).max(2.0).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const sourcePath = getCustomRingtoneSourcePath();
				if (!sourcePath) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"This ringtone has no saved source audio. Re-import from YouTube to enable editing.",
					});
				}
				const existingInfo = getCustomRingtoneInfo();
				const existingEditState = getCustomRingtoneEditState();
				try {
					const ringtone = await importRingtoneFromYouTube({
						url: existingEditState?.sourceUrl ?? "",
						startSeconds: input.startSeconds,
						endSeconds: input.endSeconds,
						displayName: input.displayName,
						thumbnailUrl: existingInfo?.thumbnailUrl,
						fadeInSeconds: input.fadeInSeconds,
						fadeOutSeconds: input.fadeOutSeconds,
						playbackRate: input.playbackRate,
						tempFilePath: sourcePath,
						sourceTitle: existingEditState?.sourceTitle,
					});
					return { ringtone };
				} catch (error) {
					if (error instanceof YouTubeRingtoneError) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: error.message,
						});
					}
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to re-edit custom ringtone",
					});
				}
			}),

		/**
		 * Imports a custom ringtone by clipping a section of a YouTube video.
		 * Requires `yt-dlp` and `ffmpeg` to be installed on the user's machine.
		 */
		importFromYouTube: publicProcedure
			.input(
				z.object({
					url: z.string().min(1),
					startSeconds: z
						.number()
						.min(0)
						.max(60 * 60 * 12),
					endSeconds: z
						.number()
						.min(0)
						.max(60 * 60 * 12),
					displayName: z.string().max(120).optional(),
					thumbnailUrl: z.string().max(2048).optional(),
					fadeInSeconds: z.number().min(0).max(10).optional(),
					fadeOutSeconds: z.number().min(0).max(10).optional(),
					playbackRate: z.number().min(0.5).max(2.0).optional(),
					/** Client-side tempId from downloadYouTubeAudio – resolved to path server-side */
					tempId: z.string().optional(),
					sourceTitle: z.string().max(400).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				try {
					const tempFilePath = input.tempId
						? (getTempAudioPath(input.tempId) ?? undefined)
						: undefined;
					const ringtone = await importRingtoneFromYouTube({
						...input,
						tempFilePath,
					});
					return { ringtone };
				} catch (error) {
					if (error instanceof YouTubeRingtoneError) {
						throw new TRPCError({
							code:
								error.code === "BINARY_MISSING" || error.code === "TIMEOUT"
									? "PRECONDITION_FAILED"
									: "BAD_REQUEST",
							message: error.message,
						});
					}
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to import YouTube ringtone",
					});
				}
			}),
	});
};

/**
 * Plays the notification sound based on the selected ringtone.
 * This is used by the notification system.
 */
export function playNotificationRingtone(ringtoneId: string): void {
	const soundPath = getRingtoneSoundPath(ringtoneId);
	if (!soundPath) {
		return;
	}

	playSoundFile(soundPath);
}
