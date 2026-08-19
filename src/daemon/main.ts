import { openSync, readFileSync, writeFileSync } from "node:fs";

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
	const options = JSON.parse(readFileSync(startPath, "utf8")) as SessionOptions & { idleTimeoutMs?: number };

	try {
		const session = await Session.start({ ...options, name });
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
		const error = cause as Error;
		writeFileSync(
			metaPath(name),
			JSON.stringify({ status: "failed", error: error.message, at: new Date().toISOString() }, null, 2),
		);
		process.stderr.write(`${error.stack ?? error.message}\n`);
		process.exit(1);
	}
}

// Route daemon output to a file: the parent detaches from stdio immediately.
const log = openSync(daemonLogPath(process.argv[2] ?? "unknown"), "a");
process.stdout.write = ((chunk: Uint8Array | string): boolean => {
	writeFileSync(log, chunk);
	return true;
}) as typeof process.stdout.write;
process.stderr.write = ((chunk: Uint8Array | string): boolean => {
	writeFileSync(log, chunk);
	return true;
}) as typeof process.stderr.write;

void main();
