import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

import {
	compactJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../host/protocol.js";

const execFileAsync = promisify(execFile);

type Pending = { resolve: (value: JsonValue) => void; reject: (reason: Error) => void };

export type MemoryUsage = {
	rss: number;
	heapTotal: number;
	heapUsed: number;
	external: number;
	arrayBuffers: number;
};

/**
 * Chrome DevTools Protocol client for the plugin's Node inspector.
 *
 * This is what makes the lifecycle check precise rather than a guess: forcing a GC and then
 * reading the heap and the active-handle table gives exact numbers, where sampling RSS only
 * gives allocator noise.
 */
export class InspectorClient {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #snapshotChunks: string[] = [];
	#nextId = 1;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.on("message", (raw) => {
			let message: JsonValue;
			try {
				message = parseJsonValue(String(raw));
			} catch {
				return;
			}
			if (!isJsonObject(message)) {
				return;
			}

			if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
				const params = message.params;
				if (isJsonObject(params) && isJsonString(params.chunk)) {
					this.#snapshotChunks.push(params.chunk);
				}
				return;
			}
			if (!isJsonNumber(message.id)) {
				return;
			}

			const pending = this.#pending.get(message.id);
			if (pending === undefined) {
				return;
			}
			this.#pending.delete(message.id);
			if (isJsonObject(message.error) && isJsonString(message.error.message)) {
				pending.reject(new Error(message.error.message));
			} else {
				pending.resolve(message.result ?? null);
			}
		});
	}

	public static async connect(url: string, timeoutMs = 5_000): Promise<InspectorClient> {
		const socket = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`inspector did not accept a connection within ${timeoutMs}ms`)),
				timeoutMs,
			);
			socket.once("open", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.once("error", (cause) => {
				clearTimeout(timer);
				reject(cause);
			});
		});

		const client = new InspectorClient(socket);
		await client.send("Runtime.enable");
		return client;
	}

	/**
	 * Counts the process's active libuv handles and requests by type. A `Timeout` count that
	 * grows once per appear/disappear cycle is an uncleared `setInterval`, named outright.
	 */
	public async activeResources(): Promise<{ [type: string]: number }> {
		const result = await this.send(
			"Runtime.evaluate",
			compactJson({
				expression:
					"typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : null",
				returnByValue: true,
				awaitPromise: false,
			}),
		);

		const values = cdpRemoteValue(result);
		if (!Array.isArray(values)) {
			return {};
		}
		const counts: { [type: string]: number } = {};
		for (const value of values) {
			if (!isJsonString(value)) {
				continue;
			}
			counts[value] = (counts[value] ?? 0) + 1;
		}
		return counts;
	}

	public close(): void {
		this.#socket.close();
	}

	/** Forces a full GC so the heap reading reflects what is actually retained. */
	public async collectGarbage(): Promise<void> {
		await this.send("HeapProfiler.collectGarbage");
	}

	/**
	 * Full memory accounting from inside the process.
	 *
	 * `Runtime.getHeapUsage` reports only the V8 JS heap, which misses Buffers and
	 * ArrayBuffers entirely -- and Stream Deck plugins buffer image bytes constantly, so a
	 * retained avatar or icon would go unnoticed. `process.memoryUsage()` covers both.
	 */
	public async memoryUsage(): Promise<MemoryUsage | undefined> {
		const result = await this.send(
			"Runtime.evaluate",
			compactJson({
				expression: "process.memoryUsage()",
				returnByValue: true,
				awaitPromise: false,
			}),
		);
		const value = cdpRemoteValue(result);
		if (!isJsonObject(value)) {
			return undefined;
		}
		if (
			!isJsonNumber(value.rss) ||
			!isJsonNumber(value.heapTotal) ||
			!isJsonNumber(value.heapUsed) ||
			!isJsonNumber(value.external) ||
			!isJsonNumber(value.arrayBuffers)
		) {
			return undefined;
		}
		return {
			rss: value.rss,
			heapTotal: value.heapTotal,
			heapUsed: value.heapUsed,
			external: value.external,
			arrayBuffers: value.arrayBuffers,
		};
	}

	public async send(method: string, params: JsonObject = {}): Promise<JsonValue> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Writes a `.heapsnapshot` openable in Chrome DevTools and returns its raw JSON. */
	public async takeHeapSnapshot(): Promise<string> {
		this.#snapshotChunks.length = 0;
		await this.send(
			"HeapProfiler.takeHeapSnapshot",
			compactJson({ reportProgress: false, captureNumericValue: false }),
		);
		return this.#snapshotChunks.join("");
	}
}

function cdpRemoteValue(result: JsonValue): JsonValue | undefined {
	if (!isJsonObject(result) || !isJsonObject(result.result)) {
		return undefined;
	}
	return result.result.value;
}

/** Resident set size in bytes, for plugins with no inspector to attach to. */
export async function readRss(pid: number): Promise<number | undefined> {
	try {
		if (process.platform === "win32") {
			const { stdout } = await execFileAsync("powershell", [
				"-NoProfile",
				"-Command",
				`(Get-Process -Id ${pid}).WorkingSet64`,
			]);
			const value = Number(stdout.trim());
			return Number.isNaN(value) ? undefined : value;
		}
		const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
		const kilobytes = Number(stdout.trim());
		return Number.isNaN(kilobytes) ? undefined : kilobytes * 1024;
	} catch {
		return undefined;
	}
}

/**
 * Summarises a V8 heap snapshot by constructor name. The snapshot's `nodes` array is a flat
 * run of fixed-width records described by `snapshot.meta.node_fields`.
 */
export function summariseHeapSnapshot(
	json: string,
	limit = 15,
): Array<{ name: string; count: number; selfSize: number }> {
	const parsed = parseJsonValue(json);
	if (!isJsonObject(parsed) || !isJsonObject(parsed.snapshot) || !isJsonObject(parsed.snapshot.meta)) {
		return [];
	}
	const fieldsValue = parsed.snapshot.meta.node_fields;
	const nodesValue = parsed.nodes;
	const stringsValue = parsed.strings;
	if (!Array.isArray(fieldsValue) || !Array.isArray(nodesValue) || !Array.isArray(stringsValue)) {
		return [];
	}

	const fields = fieldsValue.filter((field) => isJsonString(field));
	const nodes = nodesValue.filter((node) => isJsonNumber(node));
	const strings = stringsValue.filter((entry) => isJsonString(entry));

	const stride = fields.length;
	const nameIndex = fields.indexOf("name");
	const sizeIndex = fields.indexOf("self_size");
	if (nameIndex < 0 || sizeIndex < 0) {
		return [];
	}

	const totals = new Map<string, { count: number; selfSize: number }>();
	for (let offset = 0; offset + stride <= nodes.length; offset += stride) {
		const nameIndexValue = nodes[offset + nameIndex];
		const sizeIndexValue = nodes[offset + sizeIndex];
		if (nameIndexValue === undefined || sizeIndexValue === undefined) {
			continue;
		}
		const name = strings[nameIndexValue] ?? "(unknown)";
		const entry = totals.get(name) ?? { count: 0, selfSize: 0 };
		entry.count++;
		entry.selfSize += sizeIndexValue;
		totals.set(name, entry);
	}

	return [...totals.entries()]
		.map(([name, entry]) => ({ name, ...entry }))
		.sort((a, b) => b.selfSize - a.selfSize)
		.slice(0, limit);
}
