import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Root directory for session state. `SDTEST_STATE_DIR` overrides it. */
export function stateRoot(): string {
	return process.env.SDTEST_STATE_DIR ?? join(homedir(), ".cache", "sdtest");
}

export function sessionDir(session: string): string {
	return join(stateRoot(), validateSessionName(session));
}

export function metaPath(session: string): string {
	return join(sessionDir(session), "meta.json");
}

export function daemonLogPath(session: string): string {
	return join(sessionDir(session), "daemon.log");
}

export function artifactsDir(session: string): string {
	return join(sessionDir(session), "artifacts");
}

/**
 * Address of the daemon socket. macOS limits socket paths to about 104 bytes, so a long
 * path falls back to a short name in the temp directory.
 */
export function socketPath(session: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\sdtest-${session}`;
	}
	const preferred = join(sessionDir(session), "sock");
	if (Buffer.byteLength(preferred) < 100) {
		return preferred;
	}
	const digest = createHash("sha256")
		.update(resolve(sessionDir(session)))
		.digest("hex")
		.slice(0, 16);
	return join(tmpdir(), `sdtest-${digest}.sock`);
}

/** Tells if `session` is a valid session name. */
export function isSessionName(session: string): boolean {
	// 1 to 64 letters, digits, dots, dashes or underscores. This is safe in a path and in a pipe name.
	return /^[a-zA-Z0-9._-]{1,64}$/.test(session) && session !== "." && session !== "..";
}

export function validateSessionName(session: string): string {
	if (!isSessionName(session)) {
		throw new Error(
			`invalid session name "${session}": use 1-64 characters from a-z, A-Z, 0-9, dot, dash, underscore (not "." or "..")`,
		);
	}
	return session;
}
