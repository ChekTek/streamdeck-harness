import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** `2026-08-17T17:11:04.308Z DEBUG ...` -- the format the Stream Deck SDK loggers write. */
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*)$/;

export type LogLine = {
	file: string;
	timestamp: string | undefined;
	level: string | undefined;
	text: string;
};

/**
 * Reads the plugin's own rotating log files under `<sdPlugin>/logs`. Stream Deck SDK
 * plugins write these themselves; they carry stack traces the WebSocket transcript never sees.
 */
export function readPluginLogs(root: string, options: { sinceMs?: number; level?: string[] } = {}): LogLine[] {
	const directory = join(root, "logs");
	if (!existsSync(directory)) {
		return [];
	}

	const files = readdirSync(directory)
		.filter((name) => name.endsWith(".log"))
		.map((name) => join(directory, name))
		.filter((path) => statSync(path).isFile())
		// `<uuid>.0.log` is the newest; sort oldest-first so the result reads chronologically.
		.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

	const lines: LogLine[] = [];
	for (const file of files) {
		for (const raw of readFileSync(file, "utf8").split("\n")) {
			if (raw.trim().length === 0) {
				continue;
			}
			const match = LOG_LINE.exec(raw);
			const timestamp = match?.[1];
			const level = match?.[2];

			if (options.sinceMs !== undefined && timestamp !== undefined && Date.parse(timestamp) < options.sinceMs) {
				continue;
			}
			if (options.level !== undefined && (level === undefined || !options.level.includes(level))) {
				continue;
			}
			lines.push({ file, timestamp, level, text: match?.[3] ?? raw });
		}
	}
	return lines;
}

/**
 * The first `limit` error lines since `sinceMs`. Mirrors the project rule to check the
 * first 15 lines of `*.sdPlugin/logs` for critical errors after a rebuild.
 */
export function readPluginErrors(root: string, sinceMs?: number, limit = 15): LogLine[] {
	return readPluginLogs(root, { ...(sinceMs === undefined ? {} : { sinceMs }), level: ["ERROR"] }).slice(0, limit);
}
