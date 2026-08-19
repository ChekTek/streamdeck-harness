import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

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
			const message = JSON.parse(String(raw)) as {
				id?: number;
				method?: string;
				params?: unknown;
				result?: unknown;
				error?: { message: string };
			};

			if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
				this.#snapshotChunks.push((message.params as { chunk: string }).chunk);
				return;
			}
			if (message.id === undefined) {
				return;
			}

			const pending = this.#pending.get(message.id);
			if (pending === undefined) {
				return;
			}
			this.#pending.delete(message.id);
			if (message.error === undefined) {
				pending.resolve(message.result);
			} else {
				pending.reject(new Error(message.error.message));
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
	public async activeResources(): Promise<Record<string, number>> {
		const result = await this.send<{ result: { value?: string[] }; exceptionDetails?: unknown }>("Runtime.evaluate", {
			expression: "typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : null",
			returnByValue: true,
			awaitPromise: false,
		});

		const values = result.result.value;
		if (!Array.isArray(values)) {
			return {};
		}
		const counts: Record<string, number> = {};
		for (const value of values) {
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
		const result = await this.send<{ result: { value?: MemoryUsage } }>("Runtime.evaluate", {
			expression: "process.memoryUsage()",
			returnByValue: true,
			awaitPromise: false,
		});
		return result.result.value;
	}

	public async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.#socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Writes a `.heapsnapshot` openable in Chrome DevTools and returns its raw JSON. */
	public async takeHeapSnapshot(): Promise<string> {
		this.#snapshotChunks.length = 0;
		await this.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
		return this.#snapshotChunks.join("");
	}
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
	const snapshot = JSON.parse(json) as {
		snapshot: { meta: { node_fields: string[] } };
		nodes: number[];
		strings: string[];
	};

	const fields = snapshot.snapshot.meta.node_fields;
	const stride = fields.length;
	const nameIndex = fields.indexOf("name");
	const sizeIndex = fields.indexOf("self_size");
	if (nameIndex < 0 || sizeIndex < 0) {
		return [];
	}

	const totals = new Map<string, { count: number; selfSize: number }>();
	for (let offset = 0; offset + stride <= snapshot.nodes.length; offset += stride) {
		const name = snapshot.strings[snapshot.nodes[offset + nameIndex]!] ?? "(unknown)";
		const entry = totals.get(name) ?? { count: 0, selfSize: 0 };
		entry.count++;
		entry.selfSize += snapshot.nodes[offset + sizeIndex] ?? 0;
		totals.set(name, entry);
	}

	return [...totals.entries()]
		.map(([name, entry]) => ({ name, ...entry }))
		.sort((a, b) => b.selfSize - a.selfSize)
		.slice(0, limit);
}
