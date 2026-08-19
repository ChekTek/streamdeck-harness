import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Root for all session state. Overridable so tests never touch the user's real sessions. */
export function stateRoot(): string {
	return process.env.SDTEST_STATE_DIR ?? join(homedir(), ".cache", "sdtest");
}

export function sessionDir(session: string): string {
	return join(stateRoot(), session);
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
 * Address the daemon listens on. Unix socket paths are capped at ~104 bytes on macOS, so
 * long session directories fall back to a short path under the temp directory.
 */
export function socketPath(session: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\sdtest-${session}`;
	}
	const preferred = join(sessionDir(session), "sock");
	return Buffer.byteLength(preferred) < 100 ? preferred : join(tmpdir(), `sdtest-${session}.sock`);
}

export function validateSessionName(session: string): string {
	if (!/^[a-zA-Z0-9._-]{1,64}$/.test(session)) {
		throw new Error(`invalid session name "${session}": use 1-64 characters from a-z, A-Z, 0-9, dot, dash, underscore`);
	}
	return session;
}
