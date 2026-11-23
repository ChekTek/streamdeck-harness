import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

import {
	errorMessage,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../host/protocol.js";
import { parsePluginEnv } from "../plugin/launch.js";
import { daemonLogPath, metaPath, sessionDir, socketPath } from "./paths.js";
import { type Secret, secretsFromEnv } from "./redact.js";
import { Daemon } from "./server.js";
import { Session, type SessionOptions } from "./session.js";

/** Daemon entry point. `sdtest start` starts this process. */
async function main(): Promise<void> {
	const name = process.argv[2];
	if (name === undefined) {
		process.stderr.write("usage: sdtest-daemon <session>\n");
		process.exit(2);
	}

	try {
		const startPath = `${sessionDir(name)}/start.json`;
		const startText = readFileSync(startPath, "utf8");
		rmSync(startPath, { force: true });
		const options = parseStartFile(parseJsonValue(startText), name);

		const session = await Session.start(options);
		const daemon = new Daemon({
			session,
			idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000,
			secrets: options.secrets,
		});
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
		// A plugin crash does not stop the daemon, so the logs stay readable.
	} catch (cause) {
		writeFileSync(
			metaPath(name),
			JSON.stringify({ status: "failed", error: errorMessage(cause), at: new Date().toISOString() }, null, 2),
		);
		process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : errorMessage(cause)}\n`);
		process.exit(1);
	}
}

type StartOptions = SessionOptions & {
	idleTimeoutMs?: number;
	/** The variables of the env file. Output does not show their values. */
	secrets?: Secret[];
};

function parseStartFile(value: JsonValue, name: string): StartOptions {
	if (!isJsonObject(value) || !isJsonString(value.pluginPath)) {
		throw new Error("start.json is missing pluginPath");
	}
	const options: StartOptions = { name, pluginPath: value.pluginPath };
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
	if (isJsonObject(value.globalSettings)) {
		options.globalSettings = value.globalSettings;
	}
	if (isJsonString(value.envFile)) {
		try {
			options.env = parseEnv(readFileSync(value.envFile, "utf8"));
			options.secrets = secretsFromEnv(options.env);
		} catch (cause) {
			throw new Error(`could not read the env file ${value.envFile}: ${errorMessage(cause)}`, { cause });
		}
	}
	if (isJsonObject(value.env)) {
		options.env = { ...options.env, ...parsePluginEnv(value.env, "start.json env") };
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

// The parent closes stdio, so the output goes to a file.
const log = openSync(daemonLogPath(process.argv[2] ?? "unknown"), "a");
// SAFETY: the daemon uses only the chunk argument of `write`.
process.stdout.write = writeLog as typeof process.stdout.write;
// SAFETY: same as stdout.
process.stderr.write = writeLog as typeof process.stderr.write;

void main();
