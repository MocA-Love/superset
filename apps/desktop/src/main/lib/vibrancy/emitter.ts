import { EventEmitter } from "node:events";
import type { VibrancyState } from "./index";

export const VIBRANCY_EVENTS = {
	CHANGED: "vibrancy:changed",
} as const;

type VibrancyEvents = {
	[VIBRANCY_EVENTS.CHANGED]: [VibrancyState];
};

export const vibrancyEmitter = new EventEmitter() as EventEmitter & {
	on<K extends keyof VibrancyEvents>(
		event: K,
		listener: (...args: VibrancyEvents[K]) => void,
	): EventEmitter;
	off<K extends keyof VibrancyEvents>(
		event: K,
		listener: (...args: VibrancyEvents[K]) => void,
	): EventEmitter;
	emit<K extends keyof VibrancyEvents>(
		event: K,
		...args: VibrancyEvents[K]
	): boolean;
};
