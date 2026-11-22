import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Matches an SDK log line: timestamp, level, text. Example: `2026-08-17T17:11:04.308Z DEBUG ...`. */
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*)$/;

export type LogLine = {
	file: string;
	timestamp: string | undefined;
	level: string | undefined;
	text: string;
};

/** Reads the log files of the plugin in `<sdPlugin>/logs`. */
export function readPluginLogs(root: string, options: { sinceMs?: number; level?: string[] } = {}): LogLine[] {
	const directory = join(root, "logs");
	if (!existsSync(directory)) {
		return [];
	}

	const files = readdirSync(directory)
		.filter((name) => name.endsWith(".log"))
		.map((name) => join(directory, name))
		.filter((path) => statSync(path).isFile())
		// Sort from oldest to newest.
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

/** Returns the first `limit` error lines after `sinceMs`. */
export function readPluginErrors(root: string, sinceMs?: number, limit = 15): LogLine[] {
	if (sinceMs === undefined) {
		return readPluginLogs(root, { level: ["ERROR"] }).slice(0, limit);
	}
	return readPluginLogs(root, { sinceMs, level: ["ERROR"] }).slice(0, limit);
}
