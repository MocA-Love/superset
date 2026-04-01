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

function consumeMessage(
	buffer: Buffer<ArrayBufferLike>,
): { body: string; rest: Buffer<ArrayBufferLike> } | null {
	const separatorIndex = buffer.indexOf("\r\n\r\n");
	if (separatorIndex === -1) {
		return null;
	}

	const header = buffer.subarray(0, separatorIndex).toString("utf8");
	const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
	if (!contentLengthMatch) {
		return null;
	}

	const contentLength = Number(contentLengthMatch[1]);
	const bodyStart = separatorIndex + 4;
	const bodyEnd = bodyStart + contentLength;
	if (buffer.length < bodyEnd) {
		return null;
	}

	return {
		body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
		rest: buffer.subarray(bodyEnd),
	};
}

export class StdioJsonRpcClient {
	private process: ChildProcessWithoutNullStreams | null = null;

	private nextId = 0;

	private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	private readonly pendingRequests = new Map<number, PendingRequest>();

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

	async request(method: string, params?: unknown): Promise<unknown> {
		const id = ++this.nextId;
		return await new Promise<unknown>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			void this.writeMessage({
				jsonrpc: "2.0",
				id,
				method,
				params,
			}).catch((error) => {
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
		if (!this.process) {
			return;
		}

		const child = this.process;
		this.process = null;
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
			const message = consumeMessage(this.buffer);
			if (!message) {
				return;
			}

			this.buffer = message.rest;
			if (!message.body.trim()) {
				continue;
			}

			try {
				const parsed = JSON.parse(message.body) as JsonRpcMessage;
				this.handleMessage(parsed);
			} catch (error) {
				console.error(
					"[language-services/lsp] Failed to parse JSON-RPC payload",
					{
						name: this.options.name,
						error,
						body: message.body,
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
