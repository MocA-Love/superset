export type DebugLevel = "debug" | "info" | "warning" | "error";

type DebugPrimitive = string | number | boolean | null | undefined;

export type DebugData = Record<string, DebugPrimitive>;

interface DebugBreadcrumb {
	namespace: string;
	level: DebugLevel;
	message: string;
	data?: DebugData;
}

interface DebugMessage extends DebugBreadcrumb {
	fingerprint?: string[];
}

export interface DebugChannelTransport {
	addBreadcrumb(entry: DebugBreadcrumb): void;
	captureMessage(entry: DebugMessage): void;
	captureException(error: unknown, entry: DebugMessage): void;
}

export interface DebugChannelOptions {
	// `enabled` を false にすると Sentry transport を含めて
	// チャンネル全体が止まる。
	// 調査ログを常時 Sentry に送りたい用途では true のままにして、
	// ローカル console の騒がしさだけ `mirrorToConsole` で制御する。
	namespace: string;
	enabled: boolean;
	transport?: DebugChannelTransport;
	mirrorToConsole?: boolean;
	maxStringLength?: number;
}

export interface DebugLogOptions {
	captureMessage?: boolean;
	fingerprint?: string[];
}

export interface DebugAggregateOptions {
	intervalMs?: number;
	level?: DebugLevel;
	captureMessage?: boolean;
	data?: DebugData;
}

interface AggregateState {
	count: number;
	sum: number;
	min: number;
	max: number;
	last: number;
	data?: DebugData;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_AGGREGATE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_STRING_LENGTH = 500;

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}... (${value.length - maxLength} chars truncated)`;
}

function normalizeValue(
	value: unknown,
	maxStringLength: number,
): DebugPrimitive {
	if (
		value === null ||
		value === undefined ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (typeof value === "string") {
		return truncateString(value, maxStringLength);
	}

	if (value instanceof Error) {
		return truncateString(`${value.name}: ${value.message}`, maxStringLength);
	}

	try {
		return truncateString(JSON.stringify(value), maxStringLength);
	} catch {
		return truncateString(String(value), maxStringLength);
	}
}

function normalizeData(
	data: DebugData | undefined,
	maxStringLength: number,
): DebugData | undefined {
	if (!data) return undefined;

	const normalized: DebugData = {};
	for (const [key, value] of Object.entries(data)) {
		normalized[key] = normalizeValue(value, maxStringLength);
	}
	return normalized;
}

function consoleMethod(level: DebugLevel): (...args: unknown[]) => void {
	switch (level) {
		case "debug":
			return console.debug.bind(console);
		case "warning":
			return console.warn.bind(console);
		case "error":
			return console.error.bind(console);
		default:
			return console.log.bind(console);
	}
}

export class DebugChannel {
	private readonly namespace: string;
	private readonly enabled: boolean;
	private readonly transport?: DebugChannelTransport;
	private readonly mirrorToConsole: boolean;
	private readonly maxStringLength: number;
	private readonly aggregates = new Map<string, AggregateState>();

	constructor(options: DebugChannelOptions) {
		this.namespace = options.namespace;
		this.enabled = options.enabled;
		this.transport = options.transport;
		this.mirrorToConsole = options.mirrorToConsole ?? true;
		this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
	}

	log(
		level: DebugLevel,
		message: string,
		data?: DebugData,
		options?: DebugLogOptions,
	): void {
		if (!this.enabled) return;

		const normalizedData = normalizeData(data, this.maxStringLength);
		const entry: DebugMessage = {
			namespace: this.namespace,
			level,
			message,
			data: normalizedData,
			fingerprint: options?.fingerprint,
		};

		if (this.mirrorToConsole) {
			const method = consoleMethod(level);
			method(`[debug:${this.namespace}] ${message}`, normalizedData ?? {});
		}

		this.transport?.addBreadcrumb(entry);
		if (options?.captureMessage) {
			this.transport?.captureMessage(entry);
		}
	}

	debug(message: string, data?: DebugData, options?: DebugLogOptions): void {
		this.log("debug", message, data, options);
	}

	info(message: string, data?: DebugData, options?: DebugLogOptions): void {
		this.log("info", message, data, options);
	}

	warn(message: string, data?: DebugData, options?: DebugLogOptions): void {
		this.log("warning", message, data, options);
	}

	error(message: string, data?: DebugData, options?: DebugLogOptions): void {
		this.log("error", message, data, options);
	}

	captureException(
		error: unknown,
		message: string,
		data?: DebugData,
		options?: DebugLogOptions,
	): void {
		if (!this.enabled) return;

		const normalizedData = normalizeData(data, this.maxStringLength);
		const entry: DebugMessage = {
			namespace: this.namespace,
			level: "error",
			message,
			data: normalizedData,
			fingerprint: options?.fingerprint,
		};

		if (this.mirrorToConsole) {
			console.error(
				`[debug:${this.namespace}] ${message}`,
				normalizedData ?? {},
				error,
			);
		}

		this.transport?.addBreadcrumb(entry);
		this.transport?.captureException(error, entry);
	}

	increment(metric: string, value = 1, options?: DebugAggregateOptions): void {
		this.observe(metric, value, options);
	}

	observe(
		metric: string,
		value: number,
		options?: DebugAggregateOptions,
	): void {
		if (!this.enabled) return;

		const key = `${metric}:${options?.intervalMs ?? DEFAULT_AGGREGATE_INTERVAL_MS}`;
		const existing = this.aggregates.get(key);
		const data = normalizeData(options?.data, this.maxStringLength);
		const state =
			existing ??
			({
				count: 0,
				sum: 0,
				min: value,
				max: value,
				last: value,
				data,
				timer: null,
			} satisfies AggregateState);

		state.count += 1;
		state.sum += value;
		state.min = Math.min(state.min, value);
		state.max = Math.max(state.max, value);
		state.last = value;
		state.data = {
			...(state.data ?? {}),
			...(data ?? {}),
		};

		if (!existing) {
			this.aggregates.set(key, state);
			const intervalMs = options?.intervalMs ?? DEFAULT_AGGREGATE_INTERVAL_MS;
			state.timer = setTimeout(() => {
				this.flushAggregate(
					key,
					metric,
					options?.level ?? "info",
					options?.captureMessage ?? true,
				);
			}, intervalMs);
		}
	}

	flushAll(): void {
		for (const key of this.aggregates.keys()) {
			const [metric] = key.split(":");
			this.flushAggregate(key, metric, "info", true);
		}
	}

	private flushAggregate(
		key: string,
		metric: string,
		level: DebugLevel,
		captureMessage: boolean,
	): void {
		const state = this.aggregates.get(key);
		if (!state) return;

		if (state.timer) {
			clearTimeout(state.timer);
		}
		this.aggregates.delete(key);

		this.log(
			level,
			`aggregate:${metric}`,
			{
				count: state.count,
				sum: Number(state.sum.toFixed(2)),
				min: Number(state.min.toFixed(2)),
				max: Number(state.max.toFixed(2)),
				avg: Number((state.sum / state.count).toFixed(2)),
				last: Number(state.last.toFixed(2)),
				...(state.data ?? {}),
			},
			{
				captureMessage,
				fingerprint: [this.namespace, "aggregate", metric],
			},
		);
	}
}

export function createDebugChannel(options: DebugChannelOptions): DebugChannel {
	return new DebugChannel(options);
}
