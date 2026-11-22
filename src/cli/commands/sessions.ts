import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	artifactsDir,
	isSessionName,
	metaPath,
	sessionDir,
	socketPath,
	stateRoot,
	validateSessionName,
} from "../../daemon/paths.js";
import {
	compactJson,
	errorMessage,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "../../host/protocol.js";
import { parsePluginEnv } from "../../plugin/launch.js";
import { type Args, flagBool, flagJson, flagList, flagNumber, flagString } from "../args.js";
import { DaemonClient } from "../client.js";
import { emit, fail, table } from "../output.js";

const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/main.js", import.meta.url));

export type Meta = { status: string; pid?: number; error?: string; info?: JsonObject };

function readMeta(session: string): Meta | undefined {
	const path = metaPath(session);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const value = parseJsonValue(readFileSync(path, "utf8"));
		if (!isJsonObject(value) || !isJsonString(value.status)) {
			return undefined;
		}
		const meta: Meta = { status: value.status };
		if (isJsonNumber(value.pid)) {
			meta.pid = value.pid;
		}
		if (isJsonString(value.error)) {
			meta.error = value.error;
		}
		if (isJsonObject(value.info)) {
			meta.info = value.info;
		}
		return meta;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number | undefined): boolean {
	if (pid === undefined) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export type LaunchOptions = {
	pluginPath: string;
	devices?: string[];
	nodePath?: string;
	inspect?: boolean;
	registerTimeoutMs?: number;
	idleTimeoutMs?: number;
	startTimeoutMs?: number;
	/** Global settings that the host holds before the plugin starts. */
	globalSettings?: JsonObject;
	/** Environment variables for the plugin process. */
	env?: NodeJS.ProcessEnv;
};

/** Starts a daemon for `session` and waits until it is ready. */
export async function launchSession(session: string, options: LaunchOptions): Promise<Meta> {
	validateSessionName(session);

	const directory = sessionDir(session);
	mkdirSync(directory, { recursive: true });
	const lock = acquireStartLock(session);

	try {
		const existing = readMeta(session);
		if (existing?.status === "ready" && isAlive(existing.pid)) {
			throw new Error(
				`session "${session}" is already running (pid ${String(existing.pid)}). Close it first: sdtest -s=${session} close`,
			);
		}
		rmSync(metaPath(session), { force: true });

		const start = {
			pluginPath: options.pluginPath,
			devices: options.devices ?? ["stream-deck"],
			idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000,
			nodePath: options.nodePath,
			inspect: options.inspect === false ? false : undefined,
			registerTimeoutMs: options.registerTimeoutMs,
			globalSettings: options.globalSettings,
			env: options.env,
		};
		writeFileSync(`${directory}/start.json`, JSON.stringify(start, null, 2));

		spawnDaemon(session).unref();

		return await waitForMeta(session, options.startTimeoutMs ?? 30_000);
	} finally {
		rmSync(lock, { force: true });
	}
}

/** Locks `session` so that two starts cannot run at the same time. Takes over the lock of a dead process. */
function acquireStartLock(session: string): string {
	const path = join(sessionDir(session), "start.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx" });
			return path;
		} catch (cause) {
			if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") {
				throw cause;
			}
		}

		const holder = readLockHolder(path);
		if (isAlive(holder)) {
			throw new Error(`session "${session}" is already being started by another sdtest (pid ${String(holder)})`);
		}
		rmSync(path, { force: true });
	}
	throw new Error(`session "${session}" is already being started by another sdtest`);
}

function readLockHolder(path: string): number | undefined {
	try {
		const pid = Number(readFileSync(path, "utf8"));
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Starts the daemon so that it stays alive after the CLI exits. On Windows, `start /b` gives
 * the daemon a hidden console. With `detached: true`, each child program opens a terminal.
 */
function spawnDaemon(session: string): ChildProcess {
	if (process.platform !== "win32") {
		return spawn(process.execPath, [DAEMON_ENTRY, session], { detached: true, stdio: "ignore" });
	}

	const command = `start "" /b "${process.execPath}" "${DAEMON_ENTRY}" ${session}`;
	return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
		stdio: "ignore",
		windowsHide: true,
		windowsVerbatimArguments: true,
	});
}

export const START_USAGE =
	"start <path-to-plugin-or-.sdPlugin> [--global-settings '<json>'] [--env '<json>'] [--device NAMES] [--node PATH] [--no-inspect] [--idle-timeout MIN] [--register-timeout MS] [--start-timeout MS]";

export const CLOSE_USAGE = "close [--all] [--keep-artifacts]";

export async function startCommand(args: Args): Promise<void> {
	const pluginPath = args.positional[0];
	if (pluginPath === undefined) {
		fail(`usage: sdtest -s=<session> ${START_USAGE}`);
	}

	const options: LaunchOptions = {
		pluginPath,
		idleTimeoutMs: (flagNumber(args, "idle-timeout") ?? 15) * 60_000,
	};
	const devices = flagList(args, "device");
	if (devices !== undefined) {
		options.devices = devices;
	}
	const nodePath = flagString(args, "node");
	if (nodePath !== undefined) {
		options.nodePath = nodePath;
	}
	if (flagBool(args, "inspect") === false) {
		options.inspect = false;
	}
	const registerTimeoutMs = flagNumber(args, "register-timeout");
	if (registerTimeoutMs !== undefined) {
		options.registerTimeoutMs = registerTimeoutMs;
	}
	const startTimeoutMs = flagNumber(args, "start-timeout");
	if (startTimeoutMs !== undefined) {
		options.startTimeoutMs = startTimeoutMs;
	}
	const globalSettings = flagJson(args, "global-settings");
	if (globalSettings !== undefined) {
		options.globalSettings = globalSettings;
	}
	const env = flagJson(args, "env");
	if (env !== undefined) {
		try {
			options.env = parsePluginEnv(env, "--env");
		} catch (cause) {
			fail(errorMessage(cause));
		}
	}

	let meta: Meta;
	try {
		meta = await launchSession(args.session, options);
	} catch (cause) {
		fail(errorMessage(cause));
	}

	if (meta.status !== "ready") {
		fail(`session "${args.session}" failed to start:\n${meta.error ?? "unknown error"}`);
	}

	const info = meta.info ?? {};
	emit(info, (value) => {
		const row = isJsonObject(value) ? value : {};
		const actions = Array.isArray(row.actions) ? row.actions : [];
		return [
			`session   ${args.session}`,
			`plugin    ${String(row.plugin)} ${String(row.version)} (${String(row.uuid)})`,
			`runtime   ${String(row.runtime)}${row.inspector === null || row.inspector === undefined ? "" : " + inspector"}`,
			`pid       ${String(row.pid)}   host port ${String(row.port)}`,
			`artifacts ${String(row.artifacts)}`,
			"",
			"actions:",
			table(
				actions.map((entry) => {
					const action = isJsonObject(entry) ? entry : {};
					return [`  ${String(action.uuid)}`, String(action.name), `${String(action.states)} state(s)`];
				}),
			),
		].join("\n");
	});
}

async function waitForMeta(session: string, timeoutMs: number): Promise<Meta> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const meta = readMeta(session);
		if (meta?.status === "ready" || meta?.status === "failed") {
			return meta;
		}
		if (Date.now() > deadline) {
			return {
				status: "failed",
				error: `daemon did not report ready within ${timeoutMs}ms. See ${sessionDir(session)}/daemon.log`,
			};
		}
		await new Promise((done) => setTimeout(done, 100));
	}
}

export type ClosedArtifacts = { session: string; count: number; kept: boolean; path: string };

/**
 * Stops a session and removes its state. `keepArtifacts` keeps the screenshots and snapshots.
 * Returns what became of the artifacts.
 */
export async function closeSession(session: string, keepArtifacts = false): Promise<ClosedArtifacts> {
	validateSessionName(session);
	const pid = readMeta(session)?.pid;
	const path = artifactsDir(session);
	const count = existsSync(path) ? readdirSync(path).length : 0;
	try {
		const client = await DaemonClient.connect(session);
		await client.call("close");
		client.close();
		await waitForExit(pid, 10_000);
	} catch {
		// The daemon is gone. Remove its directory.
	}
	removeSessionState(session, keepArtifacts);
	if (process.platform !== "win32") {
		rmSync(socketPath(session), { force: true });
	}
	return { session, count, kept: keepArtifacts && count > 0, path };
}

async function waitForExit(pid: number | undefined, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid) && Date.now() < deadline) {
		await new Promise((done) => setTimeout(done, 25));
	}
}

function removeSessionState(session: string, keepArtifacts: boolean): void {
	const directory = sessionDir(session);
	const artifacts = artifactsDir(session);
	if (!keepArtifacts || !existsSync(artifacts) || readdirSync(artifacts).length === 0) {
		rmSync(directory, { recursive: true, force: true });
		return;
	}
	for (const entry of readdirSync(directory)) {
		if (entry !== basename(artifacts)) {
			rmSync(join(directory, entry), { recursive: true, force: true });
		}
	}
}

export async function closeCommand(args: Args): Promise<void> {
	const targets = flagBool(args, "all") === true ? listSessions().map((entry) => entry.session) : [args.session];
	const keep = flagBool(args, "keep-artifacts") === true;
	const closed: string[] = [];
	const artifacts: ClosedArtifacts[] = [];

	for (const session of targets) {
		const result = await closeSession(session, keep);
		closed.push(session);
		if (result.count > 0) {
			artifacts.push(result);
		}
	}

	emit(compactJson({ closed, artifacts: artifacts.map((entry) => compactJson(entry)) }), () => {
		if (closed.length === 0) {
			return "no running sessions";
		}
		return [
			`closed: ${closed.join(", ")}`,
			...artifacts.map((entry) =>
				entry.kept
					? `  ${entry.session}: kept ${entry.count} artifact(s) in ${entry.path}`
					: `  ${entry.session}: deleted ${entry.count} artifact(s). Use --keep-artifacts to keep them.`,
			),
		].join("\n");
	});
}

type SessionRow = { session: string; status: string; pid: number | null; plugin: string | null };

function listSessions(): SessionRow[] {
	const root = stateRoot();
	if (!existsSync(root)) {
		return [];
	}
	return readdirSync(root).flatMap((session) => {
		const meta = isSessionName(session) ? readMeta(session) : undefined;
		if (meta === undefined) {
			return [];
		}
		const alive = isAlive(meta.pid);
		const plugin = meta.info === undefined || !isJsonString(meta.info.plugin) ? null : meta.info.plugin;
		return [
			{
				session,
				status: meta.status === "ready" && !alive ? "dead" : meta.status,
				pid: meta.pid ?? null,
				plugin,
			},
		];
	});
}

export function listCommand(): void {
	emit(
		listSessions().map((row) =>
			compactJson({
				session: row.session,
				status: row.status,
				pid: row.pid,
				plugin: row.plugin,
			}),
		),
		(rows) => {
			const list = Array.isArray(rows) ? rows : [];
			return table([
				["SESSION", "STATUS", "PID", "PLUGIN"],
				...list.map((entry) => {
					const row = isJsonObject(entry) ? entry : {};
					return [
						String(row.session ?? ""),
						String(row.status ?? ""),
						String(row.pid ?? "-"),
						row.plugin === null || row.plugin === undefined ? "-" : String(row.plugin),
					];
				}),
			]);
		},
	);
}
