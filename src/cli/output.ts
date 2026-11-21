import type { JsonValue } from "../host/protocol.js";

let jsonMode = false;

export function setJsonMode(value: boolean): void {
	jsonMode = value;
}

export function isJsonMode(): boolean {
	return jsonMode;
}

export function print(text: string): void {
	process.stdout.write(`${text}\n`);
}

/**
 * Prints `value` as JSON when `--json` is set, otherwise renders `human`. Agents get
 * structured output; a person reading the terminal gets something scannable.
 */
export function emit(value: JsonValue, human: (value: JsonValue) => string): void {
	if (jsonMode) {
		print(JSON.stringify(value, null, 2));
		return;
	}
	print(human(value));
}

export function fail(message: string): never {
	if (jsonMode) {
		print(JSON.stringify({ ok: false, error: message }, null, 2));
	} else {
		process.stderr.write(`sdtest: ${message}\n`);
	}
	process.exit(1);
}

export function table(rows: string[][]): string {
	if (rows.length === 0) {
		return "(none)";
	}
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, cell.length);
		});
	}
	return rows
		.map((row) =>
			row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  "),
		)
		.join("\n");
}
