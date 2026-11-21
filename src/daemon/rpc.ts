import type { Socket } from "node:net";

import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../host/protocol.js";

export type RpcRequest = {
	id: number;
	method: string;
	params: JsonObject;
};

export type RpcSuccess = { id: number; ok: true; result: JsonValue };
export type RpcFailure = { id: number; ok: false; error: { message: string; stack?: string } };
export type RpcResponse = RpcFailure | RpcSuccess;

export function isRpcResponse(value: JsonValue): value is RpcResponse {
	if (!isJsonObject(value) || !isJsonNumber(value.id) || !isJsonBoolean(value.ok)) {
		return false;
	}
	if (value.ok) {
		return "result" in value;
	}
	return isJsonObject(value.error) && isJsonString(value.error.message);
}

export function parseRpcRequest(value: JsonValue): RpcRequest | undefined {
	if (!isJsonObject(value) || !isJsonNumber(value.id) || !isJsonString(value.method)) {
		return undefined;
	}
	const params = value.params;
	return {
		id: value.id,
		method: value.method,
		params: isJsonObject(params) ? params : {},
	};
}

/** Newline-delimited JSON framing, shared by the daemon and the CLI client. */
export function readFrames(socket: Socket, onFrame: (value: JsonValue) => void): void {
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
					onFrame(parseJsonValue(line));
				} catch {
					// A malformed frame is dropped; the peer's request simply times out.
				}
			}
			index = buffer.indexOf("\n");
		}
	});
}

export function writeFrame(socket: Socket, value: JsonValue): void {
	socket.write(`${JSON.stringify(value)}\n`);
}
