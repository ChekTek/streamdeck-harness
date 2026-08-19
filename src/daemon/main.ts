import { openSync, readFileSync, writeFileSync } from "node:fs";

import {
	errorMessage,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../host/protocol.js";
import { daemonLogPath, metaPath, sessionDir, socketPath } from "./paths.js";
import { Daemon } from "./server.js";
import { Session, type SessionOptions } from "./session.js";

/**
 * Detached daemon entry point. Started by `sdtest start`; never invoked by hand.
 * Everything it owns is headless, so the user keeps their desktop while it runs.
 */
async function main(): Promise<void> {
	const name = process.argv[2];
	if (name === undefined) {
		process.stderr.write("usage: sdtest-daemon <session>\n");
		process.exit(2);
	}

	const startPath = `${sessionDir(name)}/start.json`;
	const options = parseStartFile(parseJsonValue(readFileSync(startPath, "utf8")), name);

	try {
		const session = await Session.start(options);
		const daemon = new Daemon({ session, idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000 });
		await daemon.listen();

		writeFileSync(
			metaPath(name),
			JSON.stringify(
				{ status: "ready", pid: process.pid, socket: socketPath(name), info: session.describe() },
				null,
				2,
			),
		);

		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.on(signal, () => void daemon.shutdown(signal));
		}
		// A plugin that crashes mid-session leaves the daemon up so the transcript and
		// logs stay readable; `sdtest output` reports the exit.
	} catch (cause) {
		writeFileSync(
			metaPath(name),
			JSON.stringify({ status: "failed", error: errorMessage(cause), at: new Date().toISOString() }, null, 2),
		);
		process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : errorMessage(cause)}\n`);
		process.exit(1);
	}
}

function parseStartFile(value: JsonValue, name: string): SessionOptions & { idleTimeoutMs?: number } {
	if (!isJsonObject(value) || !isJsonString(value.pluginPath)) {
		throw new Error("start.json is missing pluginPath");
	}
	const options: SessionOptions & { idleTimeoutMs?: number } = { name, pluginPath: value.pluginPath };
	if (isJsonString(value.nodePath)) {
		options.nodePath = value.nodePath;
	}
	if (isJsonBoolean(value.inspect)) {
		options.inspect = value.inspect;
	}
	if (isJsonNumber(value.registerTimeoutMs)) {
		options.registerTimeoutMs = value.registerTimeoutMs;
	}
	if (isJsonNumber(value.idleTimeoutMs)) {
		options.idleTimeoutMs = value.idleTimeoutMs;
	}
	if (Array.isArray(value.devices)) {
		options.devices = value.devices.filter((entry) => isJsonString(entry));
	}
	return options;
}

function writeLog(chunk: Uint8Array | string): boolean {
	writeFileSync(log, chunk);
	return true;
}

// Route daemon output to a file: the parent detaches from stdio immediately.
const log = openSync(daemonLogPath(process.argv[2] ?? "unknown"), "a");
// SAFETY: Node's WriteStream.write overloads include encoding/callback variants the daemon does
// not use; this intercept only needs the chunk so it can append it to the session log.
process.stdout.write = writeLog as typeof process.stdout.write;
// SAFETY: same write intercept as stdout; stderr is redirected into the same session log file.
process.stderr.write = writeLog as typeof process.stderr.write;

void main();
