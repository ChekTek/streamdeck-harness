import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import { compactJson, errorMessage, type JsonValue } from "../host/protocol.js";
import { isConcurrent, type MethodContext, methodFor } from "./methods.js";
import { metaPath, socketPath } from "./paths.js";
import { parseRpcRequest, readFrames, writeFrame } from "./rpc.js";
import type { Session } from "./session.js";

export type DaemonOptions = {
	session: Session;
	idleTimeoutMs: number;
};

/**
 * Holds a session open between CLI invocations. Everything runs headless in this detached
 * process so the user's desktop and their installed Stream Deck app are never touched.
 */
export class Daemon {
	readonly #session: Session;
	readonly #idleTimeoutMs: number;
	readonly #address: string;
	#server: Server | undefined;
	readonly #connections = new Set<Socket>();
	#lastRequestAt = Date.now();
	#inFlight = 0;
	#queue: Promise<undefined> = Promise.resolve(undefined);
	#idleTimer: NodeJS.Timeout | undefined;
	#closing = false;

	constructor(options: DaemonOptions) {
		this.#session = options.session;
		this.#idleTimeoutMs = options.idleTimeoutMs;
		this.#address = socketPath(options.session.name);
	}

	public async listen(): Promise<void> {
		if (process.platform !== "win32" && existsSync(this.#address)) {
			unlinkSync(this.#address);
		}

		const server = createServer((socket) => this.#onConnection(socket));
		this.#server = server;

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#address, () => {
				server.off("error", reject);
				resolve();
			});
		});

		this.#idleTimer = setInterval(() => {
			if (this.#inFlight === 0 && Date.now() - this.#lastRequestAt > this.#idleTimeoutMs) {
				void this.shutdown("idle");
			}
		}, 5_000);
		this.#idleTimer.unref();
	}

	#onConnection(socket: Socket): void {
		this.#connections.add(socket);
		socket.on("close", () => this.#connections.delete(socket));
		socket.on("error", () => socket.destroy());
		readFrames(socket, (value) => {
			void this.#dispatch(socket, value);
		});
	}

	async #dispatch(socket: Socket, value: JsonValue): Promise<void> {
		this.#lastRequestAt = Date.now();
		const request = parseRpcRequest(value);
		if (request === undefined) {
			return;
		}

		const handler = methodFor(request.method);
		if (handler === undefined) {
			writeFrame(
				socket,
				compactJson({
					id: request.id,
					ok: false,
					error: compactJson({ message: `unknown method "${request.method}"` }),
				}),
			);
			return;
		}

		const context: MethodContext = {
			session: this.#session,
			shutdown: (reason) => this.shutdown(reason),
		};

		const run = async (): Promise<JsonValue> => handler(context, request.params);

		this.#inFlight++;
		try {
			const result = await (isConcurrent(request.method) ? run() : this.#exclusive(run));
			writeFrame(socket, compactJson({ id: request.id, ok: true, result }));
		} catch (cause) {
			const error = compactJson({ message: errorMessage(cause) });
			if (cause instanceof Error && cause.stack !== undefined) {
				error.stack = cause.stack;
			}
			writeFrame(socket, compactJson({ id: request.id, ok: false, error }));
		} finally {
			this.#inFlight--;
			this.#lastRequestAt = Date.now();
		}
	}

	/**
	 * Runs `task` after every earlier exclusive request has finished. Requests arrive from
	 * separate CLI processes, so two that change the session would otherwise interleave.
	 */
	async #exclusive(task: () => Promise<JsonValue>): Promise<JsonValue> {
		const previous = this.#queue;
		let release = (): void => undefined;
		this.#queue = new Promise((resolve) => {
			release = (): void => resolve(undefined);
		});
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}

	public async shutdown(reason: string): Promise<void> {
		if (this.#closing) {
			return;
		}
		this.#closing = true;
		clearInterval(this.#idleTimer);

		writeFileSync(
			metaPath(this.#session.name),
			JSON.stringify({ status: "closed", reason, at: new Date().toISOString() }, null, 2),
		);

		await this.#session.close();

		this.#server?.close();
		for (const connection of this.#connections) {
			connection.destroy();
		}
		this.#connections.clear();
		if (process.platform !== "win32" && existsSync(this.#address)) {
			unlinkSync(this.#address);
		}

		setTimeout(() => process.exit(0), 50);
	}
}
