import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { metaPath, sessionDir, socketPath, stateRoot, validateSessionName } from "../../daemon/paths.js";
import { type Args, flagBool, flagList, flagNumber, flagString } from "../args.js";
import { DaemonClient } from "../client.js";
import { emit, fail, table } from "../output.js";

const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/main.js", import.meta.url));

export type Meta = { status: string; pid?: number; error?: string; info?: Record<string, unknown> };

function readMeta(session: string): Meta | undefined {
	const path = metaPath(session);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Meta;
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
};

/**
 * Starts a detached daemon for `session` and waits for it to report ready. Shared by the
 * `start` command and the scenario runner.
 */
export async function launchSession(session: string, options: LaunchOptions): Promise<Meta> {
	validateSessionName(session);

	const existing = readMeta(session);
	if (existing?.status === "ready" && isAlive(existing.pid)) {
		throw new Error(
			`session "${session}" is already running (pid ${String(existing.pid)}). Close it first: sdtest -s=${session} close`,
		);
	}

	const directory = sessionDir(session);
	mkdirSync(directory, { recursive: true });
	rmSync(metaPath(session), { force: true });

	writeFileSync(
		`${directory}/start.json`,
		JSON.stringify(
			{
				pluginPath: options.pluginPath,
				devices: options.devices ?? ["stream-deck"],
				...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
				...(options.inspect === false ? { inspect: false } : {}),
				...(options.registerTimeoutMs === undefined ? {} : { registerTimeoutMs: options.registerTimeoutMs }),
				idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000,
			},
			null,
			2,
		),
	);

	const child = spawn(process.execPath, [DAEMON_ENTRY, session], { detached: true, stdio: "ignore" });
	child.unref();

	return waitForMeta(session, options.startTimeoutMs ?? 30_000);
}

export async function startCommand(args: Args): Promise<void> {
	const pluginPath = args.positional[0];
	if (pluginPath === undefined) {
		fail("usage: sdtest -s=<session> start <path-to-plugin-or-.sdPlugin>");
	}

	let meta: Meta;
	try {
		meta = await launchSession(args.session, {
			pluginPath,
			...(flagList(args, "device") === undefined ? {} : { devices: flagList(args, "device")! }),
			...(flagString(args, "node") === undefined ? {} : { nodePath: flagString(args, "node")! }),
			...(flagBool(args, "inspect") === false ? { inspect: false } : {}),
			...(flagNumber(args, "register-timeout") === undefined
				? {}
				: { registerTimeoutMs: flagNumber(args, "register-timeout")! }),
			idleTimeoutMs: (flagNumber(args, "idle-timeout") ?? 15) * 60_000,
			...(flagNumber(args, "start-timeout") === undefined
				? {}
				: { startTimeoutMs: flagNumber(args, "start-timeout")! }),
		});
	} catch (cause) {
		fail((cause as Error).message);
	}

	if (meta.status !== "ready") {
		fail(`session "${args.session}" failed to start:\n${meta.error ?? "unknown error"}`);
	}

	emit(meta.info ?? {}, (info: Record<string, unknown>) =>
		[
			`session   ${args.session}`,
			`plugin    ${String(info.plugin)} ${String(info.version)} (${String(info.uuid)})`,
			`runtime   ${String(info.runtime)}${info.inspector === null ? "" : " + inspector"}`,
			`pid       ${String(info.pid)}   host port ${String(info.port)}`,
			`artifacts ${String(info.artifacts)}`,
			"",
			"actions:",
			table(
				(info.actions as Array<Record<string, unknown>>).map((action) => [
					`  ${String(action.uuid)}`,
					String(action.name),
					`${String(action.states)} state(s)`,
				]),
			),
		].join("\n"),
	);
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

/** Stops a session and removes its state directory. Safe to call when nothing is running. */
export async function closeSession(session: string): Promise<void> {
	try {
		const client = await DaemonClient.connect(session);
		await client.call("close");
		client.close();
	} catch {
		// Already gone; fall through to cleaning up its directory.
	}
	rmSync(sessionDir(session), { recursive: true, force: true });
	if (process.platform !== "win32") {
		rmSync(socketPath(session), { force: true });
	}
}

export async function closeCommand(args: Args): Promise<void> {
	const targets = flagBool(args, "all") === true ? listSessions().map((entry) => entry.session) : [args.session];
	const closed: string[] = [];

	for (const session of targets) {
		await closeSession(session);
		closed.push(session);
	}

	emit({ closed }, ({ closed: names }: { closed: string[] }) =>
		names.length === 0 ? "no running sessions" : `closed: ${names.join(", ")}`,
	);
}

type SessionRow = { session: string; status: string; pid: number | null; plugin: string | null };

function listSessions(): SessionRow[] {
	const root = stateRoot();
	if (!existsSync(root)) {
		return [];
	}
	return readdirSync(root).flatMap((session) => {
		const meta = readMeta(session);
		if (meta === undefined) {
			return [];
		}
		const alive = isAlive(meta.pid);
		return [
			{
				session,
				status: meta.status === "ready" && !alive ? "dead" : meta.status,
				pid: meta.pid ?? null,
				plugin: (meta.info?.plugin as string | undefined) ?? null,
			},
		];
	});
}

export function listCommand(): void {
	emit(listSessions(), (rows: SessionRow[]) =>
		table([
			["SESSION", "STATUS", "PID", "PLUGIN"],
			...rows.map((row) => [row.session, row.status, String(row.pid ?? "-"), row.plugin ?? "-"]),
		]),
	);
}
