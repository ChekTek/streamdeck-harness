import { connect, type Socket } from "node:net";

import { socketPath } from "../daemon/paths.js";
import { isRpcResponse, readFrames, writeFrame } from "../daemon/rpc.js";
import { type JsonObject, type JsonValue } from "../host/protocol.js";

/** Short-lived connection to a session daemon. One per CLI invocation. */
export class DaemonClient {
	readonly #socket: Socket;
	readonly #pending = new Map<number, { resolve: (value: JsonValue) => void; reject: (reason: Error) => void }>();
	#nextId = 1;

	private constructor(socket: Socket) {
		this.#socket = socket;
		readFrames(socket, (value) => {
			if (!isRpcResponse(value)) {
				return;
			}
			const pending = this.#pending.get(value.id);
			if (pending === undefined) {
				return;
			}
			this.#pending.delete(value.id);
			if (value.ok) {
				pending.resolve(value.result);
			} else {
				const error = new Error(value.error.message);
				if (value.error.stack !== undefined) {
					error.stack = value.error.stack;
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

	public async call(method: string, params: JsonObject = {}): Promise<JsonValue> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			writeFrame(this.#socket, { id, method, params });
		});
	}

	public close(): void {
		this.#socket.end();
		this.#socket.destroy();
	}
}
