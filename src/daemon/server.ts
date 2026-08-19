import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import { type MethodContext, methods } from "./methods.js";
import { metaPath, socketPath } from "./paths.js";
import { readFrames, type RpcRequest, type RpcResponse, writeFrame } from "./rpc.js";
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
			if (Date.now() - this.#lastRequestAt > this.#idleTimeoutMs) {
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
			void this.#dispatch(socket, value as RpcRequest);
		});
	}

	async #dispatch(socket: Socket, request: RpcRequest): Promise<void> {
		this.#lastRequestAt = Date.now();

		const handler = methods[request.method];
		if (handler === undefined) {
			writeFrame(socket, {
				id: request.id,
				ok: false,
				error: { message: `unknown method "${request.method}"` },
			} satisfies RpcResponse);
			return;
		}

		const context: MethodContext = {
			session: this.#session,
			shutdown: (reason) => this.shutdown(reason),
		};

		try {
			const result = await handler(context, request.params ?? {});
			writeFrame(socket, { id: request.id, ok: true, result } satisfies RpcResponse);
		} catch (cause) {
			const error = cause as Error;
			writeFrame(socket, {
				id: request.id,
				ok: false,
				error: { message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) },
			} satisfies RpcResponse);
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

		// `server.close()` only completes once every connection has gone, and the client that
		// asked for the shutdown is still holding one. Stop accepting, then drop them.
		this.#server?.close();
		for (const connection of this.#connections) {
			connection.destroy();
		}
		this.#connections.clear();
		if (process.platform !== "win32" && existsSync(this.#address)) {
			unlinkSync(this.#address);
		}

		// Give the response frame a tick to flush before the process disappears.
		setTimeout(() => process.exit(0), 50);
	}
}
