import type { Socket } from "node:net";

export type RpcRequest = {
	id: number;
	method: string;
	params: Record<string, unknown>;
};

export type RpcResponse =
	{ id: number; ok: false; error: { message: string; stack?: string } } | { id: number; ok: true; result: unknown };

/** Newline-delimited JSON framing, shared by the daemon and the CLI client. */
export function readFrames(socket: Socket, onFrame: (value: unknown) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim().length > 0) {
				try {
					onFrame(JSON.parse(line));
				} catch {
					// A malformed frame is dropped; the peer's request simply times out.
				}
			}
			index = buffer.indexOf("\n");
		}
	});
}

export function writeFrame(socket: Socket, value: unknown): void {
	socket.write(`${JSON.stringify(value)}\n`);
}
