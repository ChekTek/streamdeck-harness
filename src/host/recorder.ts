import { EventEmitter } from "node:events";

import { isJsonString, type Frame, type JsonValue } from "./protocol.js";

export type Direction = "from-pi" | "from-plugin" | "harness" | "to-pi" | "to-plugin";

export type TranscriptEntry = {
	seq: number;
	/** Milliseconds since the session started. */
	at: number;
	direction: Direction;
	event: string;
	action?: string;
	context?: string;
	frame: Frame;
};

export type Violation = {
	seq: number;
	at: number;
	kind: string;
	message: string;
	context?: string;
	action?: string;
	detail?: JsonValue;
};

export type EntryFilter = {
	direction?: Direction[];
	event?: string[];
	context?: string;
	action?: string;
	sinceSeq?: number;
	sinceMs?: number;
};

/**
 * Timestamped record of every frame in both directions, plus harness-detected protocol
 * violations. Nothing is dropped -- unknown events are recorded verbatim so a new Stream
 * Deck event shows up in the transcript instead of vanishing.
 */
export class Recorder extends EventEmitter {
	readonly #startedAt = Date.now();
	readonly #entries: TranscriptEntry[] = [];
	readonly #violations: Violation[] = [];
	#seq = 0;
	/** Timestamp of the most recent frame in any direction, used for quiescence waits. */
	#lastActivityAt = 0;

	public get lastActivityAt(): number {
		return this.#lastActivityAt;
	}

	public get nextSeq(): number {
		return this.#seq;
	}

	public get startedAt(): number {
		return this.#startedAt;
	}

	public entries(filter: EntryFilter = {}): TranscriptEntry[] {
		return this.#entries.filter((entry) => {
			if (filter.direction !== undefined && !filter.direction.includes(entry.direction)) {
				return false;
			}
			if (filter.event !== undefined && !filter.event.includes(entry.event)) {
				return false;
			}
			if (filter.context !== undefined && entry.context !== filter.context) {
				return false;
			}
			if (filter.action !== undefined && entry.action !== filter.action) {
				return false;
			}
			if (filter.sinceSeq !== undefined && entry.seq < filter.sinceSeq) {
				return false;
			}
			if (filter.sinceMs !== undefined && entry.at < filter.sinceMs) {
				return false;
			}
			return true;
		});
	}

	public record(direction: Direction, frame: Frame): TranscriptEntry {
		const entry: TranscriptEntry = {
			seq: this.#seq++,
			at: Date.now() - this.#startedAt,
			direction,
			event: frame.event,
			frame,
		};
		if (isJsonString(frame.action)) {
			entry.action = frame.action;
		}
		if (isJsonString(frame.context)) {
			entry.context = frame.context;
		}

		this.#entries.push(entry);
		this.#lastActivityAt = Date.now();
		this.emit("entry", entry);
		return entry;
	}

	public violation(
		kind: string,
		message: string,
		extra: Omit<Violation, "at" | "kind" | "message" | "seq"> = {},
	): Violation {
		const violation: Violation = {
			seq: this.#seq++,
			at: Date.now() - this.#startedAt,
			kind,
			message,
			...extra,
		};
		this.#violations.push(violation);
		this.emit("violation", violation);
		return violation;
	}

	public violations(sinceSeq = 0): Violation[] {
		return this.#violations.filter((violation) => violation.seq >= sinceSeq);
	}

	/** Resolves with the first entry matching `predicate`, considering entries from `sinceSeq`. */
	public async waitFor(
		predicate: (entry: TranscriptEntry) => boolean,
		timeoutMs: number,
		sinceSeq = 0,
	): Promise<TranscriptEntry> {
		const existing = this.#entries.find((entry) => entry.seq >= sinceSeq && predicate(entry));
		if (existing !== undefined) {
			return existing;
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.off("entry", onEntry);
				reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching frame`));
			}, timeoutMs);

			const onEntry = (entry: TranscriptEntry): void => {
				if (!predicate(entry)) {
					return;
				}
				clearTimeout(timer);
				this.off("entry", onEntry);
				resolve(entry);
			};

			this.on("entry", onEntry);
		});
	}

	/** Resolves once no frame has been recorded for `quietMs`, or rejects at `timeoutMs`. */
	public async waitForQuiet(quietMs: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const idle = Date.now() - this.#lastActivityAt;
			if (idle >= quietMs) {
				return;
			}
			if (Date.now() >= deadline) {
				throw new Error(`plugin never went quiet for ${quietMs}ms within ${timeoutMs}ms`);
			}
			const wait = Math.min(quietMs - idle, deadline - Date.now());
			await new Promise((done) => setTimeout(done, Math.max(wait, 5)));
		}
	}
}
