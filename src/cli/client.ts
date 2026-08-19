import { connect, type Socket } from "node:net";

import { socketPath } from "../daemon/paths.js";
import { readFrames, type RpcResponse, writeFrame } from "../daemon/rpc.js";

/** Short-lived connection to a session daemon. One per CLI invocation. */
export class DaemonClient {
	readonly #socket: Socket;
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
	#nextId = 1;

	private constructor(socket: Socket) {
		this.#socket = socket;
		readFrames(socket, (value) => {
			const response = value as RpcResponse;
			const pending = this.#pending.get(response.id);
			if (pending === undefined) {
				return;
			}
			this.#pending.delete(response.id);
			if (response.ok) {
				pending.resolve(response.result);
			} else {
				const error = new Error(response.error.message);
				if (response.error.stack !== undefined) {
					error.stack = response.error.stack;
				}
				pending.reject(error);
			}
		});

		socket.on("close", () => {
			for (const pending of this.#pending.values()) {
				pending.reject(new Error("daemon closed the connection"));
			}
			this.#pending.clear();
		});
	}

	public static async connect(session: string): Promise<DaemonClient> {
		const address = socketPath(session);
		const socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = connect(address);
			candidate.once("connect", () => resolve(candidate));
			candidate.once("error", (cause: NodeJS.ErrnoException) => {
				reject(
					cause.code === "ENOENT" || cause.code === "ECONNREFUSED"
						? new Error(`no running session "${session}". Start one with: sdtest -s=${session} start <plugin-path>`)
						: cause,
				);
			});
		});
		return new DaemonClient(socket);
	}

	public async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			writeFrame(this.#socket, { id, method, params });
		});
	}

	public close(): void {
		this.#socket.end();
		this.#socket.destroy();
	}
}
