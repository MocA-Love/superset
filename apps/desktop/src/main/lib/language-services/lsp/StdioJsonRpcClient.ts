import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

type JsonRpcId = number | string | null;

type JsonRpcRequestMessage = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
};

type JsonRpcNotificationMessage = {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
};

type JsonRpcResponseMessage = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
};

type JsonRpcMessage =
	| JsonRpcRequestMessage
	| JsonRpcNotificationMessage
	| JsonRpcResponseMessage;

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type StdioJsonRpcClientOptions = {
	name: string;
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: boolean;
	onNotification?: (message: JsonRpcNotificationMessage) => void;
	onRequest?: (message: JsonRpcRequestMessage) => Promise<unknown> | unknown;
	onExit?: (payload: {
		code: number | null;
		signal: NodeJS.Signals | null;
	}) => void;
	onStderr?: (chunk: string) => void;
};

function isJsonRpcResponseMessage(
	message: JsonRpcMessage,
): message is JsonRpcResponseMessage {
	return "id" in message && !("method" in message);
}

function isJsonRpcRequestMessage(
	message: JsonRpcMessage,
): message is JsonRpcRequestMessage {
	return "id" in message && "method" in message;
}

type ConsumeResult =
	| { kind: "message"; body: string; rest: Buffer<ArrayBufferLike> }
	| { kind: "skip"; rest: Buffer<ArrayBufferLike> }
	| null;

function consumeMessage(buffer: Buffer<ArrayBufferLike>): ConsumeResult {
	const separatorIndex = buffer.indexOf("\r\n\r\n");
	if (separatorIndex === -1) {
		return null;
	}

	const header = buffer.subarray(0, separatorIndex).toString("utf8");
	const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
	if (!contentLengthMatch) {
		// Invalid header — skip past the separator so the buffer can recover
		return { kind: "skip", rest: buffer.subarray(separatorIndex + 4) };
	}

	const contentLength = Number(contentLengthMatch[1]);
	const bodyStart = separatorIndex + 4;
	const bodyEnd = bodyStart + contentLength;
	if (buffer.length < bodyEnd) {
		return null;
	}

	return {
		kind: "message",
		body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
		rest: buffer.subarray(bodyEnd),
	};
}

export class StdioJsonRpcClient {
	private process: ChildProcessWithoutNullStreams | null = null;

	private nextId = 0;

	private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	private readonly pendingRequests = new Map<number, PendingRequest>();

	private stopping = false;

	constructor(private readonly options: StdioJsonRpcClientOptions) {}

	async start(): Promise<void> {
		if (this.process) {
			return;
		}

		const child = spawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env: this.options.env,
			shell: this.options.shell,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process = child;
		child.stdout.on("data", (chunk: Buffer) => {
			this.handleStdout(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.options.onStderr?.(chunk);
		});
		child.on("exit", (code, signal) => {
			this.process = null;
			for (const pendingRequest of this.pendingRequests.values()) {
				pendingRequest.reject(
					new Error(
						`${this.options.name} exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`,
					),
				);
			}
			this.pendingRequests.clear();
			this.options.onExit?.({ code, signal });
		});
		child.on("error", (error) => {
			this.process = null;
			for (const pendingRequest of this.pendingRequests.values()) {
				pendingRequest.reject(error);
			}
			this.pendingRequests.clear();
		});
	}

	async request(
		method: string,
		params?: unknown,
		timeoutMs = 30_000,
	): Promise<unknown> {
		const id = ++this.nextId;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(
					new Error(
						`${this.options.name} request "${method}" timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			void this.writeMessage({
				jsonrpc: "2.0",
				id,
				method,
				params,
			}).catch((error) => {
				clearTimeout(timer);
				this.pendingRequests.delete(id);
				reject(error);
			});
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.writeMessage({
			jsonrpc: "2.0",
			method,
			params,
		});
	}

	async stop(): Promise<void> {
		if (!this.process || this.stopping) {
			return;
		}

		this.stopping = true;
		const child = this.process;

		// Attempt graceful LSP shutdown → exit before killing
		try {
			await this.request("shutdown", null, 5_000);
			await this.notify("exit");
		} catch {
			// Graceful path failed — fall through to kill
		}

		this.process = null;
		this.stopping = false;
		child.removeAllListeners();
		if (!child.killed) {
			child.kill();
		}

		for (const pendingRequest of this.pendingRequests.values()) {
			pendingRequest.reject(new Error(`${this.options.name} stopped`));
		}
		this.pendingRequests.clear();
	}

	private handleStdout(chunk: Buffer<ArrayBufferLike>): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const result = consumeMessage(this.buffer);
			if (!result) {
				return;
			}

			this.buffer = result.rest;

			if (result.kind === "skip") {
				console.warn("[language-services/lsp] Skipped invalid header block", {
					name: this.options.name,
				});
				continue;
			}

			if (!result.body.trim()) {
				continue;
			}

			try {
				const parsed = JSON.parse(result.body) as JsonRpcMessage;
				this.handleMessage(parsed);
			} catch (error) {
				console.error(
					"[language-services/lsp] Failed to parse JSON-RPC payload",
					{
						name: this.options.name,
						error,
						body: result.body,
					},
				);
			}
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (isJsonRpcResponseMessage(message)) {
			const requestId = Number(message.id);
			const pendingRequest = Number.isNaN(requestId)
				? null
				: this.pendingRequests.get(requestId);
			if (!pendingRequest) {
				return;
			}

			this.pendingRequests.delete(requestId);
			if (message.error) {
				pendingRequest.reject(new Error(message.error.message));
				return;
			}

			pendingRequest.resolve(message.result);
			return;
		}

		if (isJsonRpcRequestMessage(message)) {
			void this.handleServerRequest(message);
			return;
		}

		this.options.onNotification?.(message);
	}

	private async handleServerRequest(
		message: JsonRpcRequestMessage,
	): Promise<void> {
		try {
			const result =
				(await this.options.onRequest?.(message)) ??
				this.defaultRequestResult(message.method);
			await this.writeMessage({
				jsonrpc: "2.0",
				id: message.id,
				result: result ?? null,
			});
		} catch (error) {
			await this.writeMessage({
				jsonrpc: "2.0",
				id: message.id,
				error: {
					code: -32603,
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private defaultRequestResult(method: string): unknown {
		switch (method) {
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
				return null;
			case "workspace/configuration":
				return [];
			default:
				throw new Error(`Unhandled JSON-RPC request: ${method}`);
		}
	}

	private async writeMessage(message: JsonRpcMessage): Promise<void> {
		const child = this.process;
		if (!child) {
			throw new Error(`${this.options.name} is not running`);
		}

		const payload = Buffer.from(JSON.stringify(message), "utf8");
		const header = Buffer.from(
			`Content-Length: ${payload.byteLength}\r\n\r\n`,
			"utf8",
		);
		const combined = Buffer.concat([header, payload]);

		await new Promise<void>((resolve, reject) => {
			child.stdin.write(combined, (error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	}
}
