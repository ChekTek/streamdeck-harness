#!/usr/bin/env node
import { type Args, flagBool, flagJson, flagList, flagNumber, flagString, parseArgs } from "./args.js";
import { DaemonClient } from "./client.js";
import { lintCommand } from "./commands/lint.js";
import { runCommand } from "./commands/run.js";
import { closeCommand, listCommand, startCommand } from "./commands/sessions.js";
import { emit, fail, isJsonMode, print, setJsonMode, table } from "./output.js";

type Remote = {
	method: string;
	summary: string;
	usage: string;
	params: (args: Args) => Record<string, unknown>;
	human?: (result: never) => string;
};

function ref(args: Args): string {
	const value = args.positional[0];
	if (value === undefined) {
		fail("this command needs an action reference: a context id, or an action UUID when only one instance exists");
	}
	return value;
}

/**
 * CLI values arrive as strings. SDPI checkboxes need booleans and numeric fields need
 * numbers, so obvious literals are coerced; `--raw` forces the string through unchanged.
 */
function coerce(value: string | undefined, raw: boolean): unknown {
	if (value === undefined || raw) {
		return value ?? "";
	}
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	if (value === "null") {
		return null;
	}
	return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

function mib(value: unknown): string {
	return typeof value === "number" ? `${(value / 1024 / 1024).toFixed(2)} MiB` : "-";
}

function keySummary(result: Record<string, unknown>): string {
	const coordinates = result.coordinates as { column: number; row: number } | null;
	return [
		`context   ${String(result.context)}`,
		`action    ${String(result.action)}  (${String(result.name)})`,
		`position  ${coordinates === null ? "multi-action" : `column ${coordinates.column}, row ${coordinates.row}`}`,
		`visible   ${String(result.visible)}`,
		`state     ${String(result.state)} of ${String(result.stateCount)}`,
		`title     ${JSON.stringify(result.title)}`,
		`image     ${String(result.imageSource)}${result.imageSource === "manifest" ? ` (${String(result.manifestImage)})` : ""}`,
		`settings  ${JSON.stringify(result.settings)}`,
	].join("\n");
}

const REMOTE: Record<string, Remote> = {
	info: {
		method: "info",
		summary: "Show the running session: plugin, runtime, devices, declared actions.",
		usage: "info",
		params: () => ({}),
		human: (result: Record<string, unknown>) =>
			[
				`plugin    ${String(result.plugin)} ${String(result.version)}`,
				`runtime   ${String(result.runtime)} -> ${String(result.codePath)}`,
				`pid       ${String(result.pid)}   port ${String(result.port)}`,
				`inspector ${String(result.inspector ?? "not attached")}`,
				`artifacts ${String(result.artifacts)}`,
			].join("\n"),
	},
	actions: {
		method: "actions",
		summary: "List the action instances currently placed on the emulated device.",
		usage: "actions",
		params: () => ({}),
		human: (rows: Array<Record<string, unknown>>) =>
			table([
				["CONTEXT", "ACTION", "POS", "VISIBLE", "STATE", "TITLE"],
				...rows.map((row) => {
					const coordinates = row.coordinates as { column: number; row: number } | null;
					return [
						String(row.context),
						String(row.action),
						coordinates === null ? "multi" : `${coordinates.column},${coordinates.row}`,
						String(row.visible),
						`${String(row.state)}/${String(row.stateCount)}`,
						JSON.stringify(row.title),
					];
				}),
			]),
	},
	add: {
		method: "add",
		summary: "Place an action on the device and send willAppear.",
		usage: "add <action-uuid> [--settings '<json>'] [--column N --row N] [--state N] [--title T] [--no-appear]",
		params: (args) => ({
			uuid: args.positional[0],
			...(flagJson(args, "settings") === undefined ? {} : { settings: flagJson(args, "settings") }),
			...(flagNumber(args, "column") === undefined ? {} : { column: flagNumber(args, "column") }),
			...(flagNumber(args, "row") === undefined ? {} : { row: flagNumber(args, "row") }),
			...(flagNumber(args, "state") === undefined ? {} : { state: flagNumber(args, "state") }),
			...(flagString(args, "title") === undefined ? {} : { title: flagString(args, "title") }),
			...(flagString(args, "device") === undefined ? {} : { device: flagString(args, "device") }),
			...(flagString(args, "controller") === undefined ? {} : { controller: flagString(args, "controller") }),
			...(flagBool(args, "multi-action") === undefined ? {} : { multiAction: flagBool(args, "multi-action") }),
			...(flagBool(args, "appear") === false ? { appear: false } : {}),
		}),
		human: keySummary,
	},
	remove: {
		method: "remove",
		summary: "Send willDisappear and drop the instance.",
		usage: "remove <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: (result: Record<string, unknown>) => `removed ${String(result.removed)} (${String(result.action)})`,
	},
	appear: {
		method: "appear",
		summary: "Re-send willAppear for an instance.",
		usage: "appear <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: keySummary,
	},
	disappear: {
		method: "disappear",
		summary: "Send willDisappear without removing the instance.",
		usage: "disappear <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: (result: Record<string, unknown>) => `${String(result.context)} visible=${String(result.visible)}`,
	},
	press: {
		method: "press",
		summary: "keyDown, hold, keyUp, then wait for the plugin to settle.",
		usage: "press <ref> [--hold MS] [--settle MS] [--desired-state N]",
		params: (args) => ({
			ref: ref(args),
			...(flagNumber(args, "hold") === undefined ? {} : { holdMs: flagNumber(args, "hold") }),
			...(flagNumber(args, "settle") === undefined ? {} : { settleMs: flagNumber(args, "settle") }),
			...(flagNumber(args, "desired-state") === undefined
				? {}
				: { userDesiredState: flagNumber(args, "desired-state") }),
		}),
		human: keySummary,
	},
	"key-down": {
		method: "keyDown",
		summary: "Send keyDown only.",
		usage: "key-down <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: (result: Record<string, unknown>) => `keyDown -> ${String(result.context)}`,
	},
	"key-up": {
		method: "keyUp",
		summary: "Send keyUp only.",
		usage: "key-up <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: (result: Record<string, unknown>) => `keyUp -> ${String(result.context)}`,
	},
	key: {
		method: "key",
		summary: "Show what the plugin has set on one key.",
		usage: "key <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: keySummary,
	},
	screenshot: {
		method: "screenshot",
		summary: "Render the key to a PNG and lint the SVG behind it.",
		usage: "screenshot <ref> [--size PX] [--name STEM]",
		params: (args) => ({
			ref: ref(args),
			...(flagNumber(args, "size") === undefined ? {} : { size: flagNumber(args, "size") }),
			...(flagString(args, "name") === undefined ? {} : { name: flagString(args, "name") }),
		}),
		human: (result: Record<string, unknown>) => {
			const lint = result.lint as { errors: number; warnings: number; findings: Array<Record<string, unknown>> } | null;
			const lines = [
				`png    ${String(result.png)}`,
				result.svg === null ? "svg    (raster image)" : `svg    ${String(result.svg)}`,
				`source ${String(result.imageSource)}${result.imagePath === null ? "" : ` -> ${String(result.imagePath)}`}`,
				`title  ${JSON.stringify(result.title)}   state ${String(result.state)}`,
			];
			if (result.imageError !== null) {
				lines.push(`ERROR  ${String(result.imageError)}`);
			}
			if (lint !== null) {
				lines.push(`lint   ${lint.errors} error(s), ${lint.warnings} warning(s)`);
				lines.push(
					...lint.findings.map(
						(finding) => `       ${String(finding.severity)} [${String(finding.rule)}] ${String(finding.message)}`,
					),
				);
			}
			lines.push("", String(result.note));
			return lines.join("\n");
		},
	},
	settings: {
		method: "getSettings",
		summary: "Read an instance's settings.",
		usage: "settings <ref>",
		params: (args) => ({ ref: ref(args) }),
		human: (result: unknown) => JSON.stringify(result, null, 2),
	},
	"set-settings": {
		method: "setSettings",
		summary: "Write settings and notify the plugin, as the property inspector would.",
		usage: "set-settings <ref> --settings '<json>'",
		params: (args) => ({ ref: ref(args), settings: flagJson(args, "settings") }),
		human: (result: unknown) => JSON.stringify(result, null, 2),
	},
	"global-settings": {
		method: "getGlobalSettings",
		summary: "Read global settings.",
		usage: "global-settings",
		params: () => ({}),
		human: (result: unknown) => JSON.stringify(result, null, 2),
	},
	"set-global-settings": {
		method: "setGlobalSettings",
		summary: "Write global settings and notify the plugin.",
		usage: "set-global-settings --settings '<json>'",
		params: (args) => ({ settings: flagJson(args, "settings") }),
		human: (result: unknown) => JSON.stringify(result, null, 2),
	},
	"set-secrets": {
		method: "setSecrets",
		summary: "Push secrets to the plugin (SDK v3).",
		usage: "set-secrets --secrets '<json>'",
		params: (args) => ({ secrets: flagJson(args, "secrets") }),
		human: (result: Record<string, unknown>) => `secrets: ${(result.secrets as string[]).join(", ")}`,
	},
	"pi-open": {
		method: "piOpen",
		summary: "Render an action's property inspector headlessly and connect it to the mock host.",
		usage: "pi-open <ref> [--width PX] [--height PX] [--timeout MS]",
		params: (args) => ({
			ref: ref(args),
			...(flagNumber(args, "width") === undefined ? {} : { width: flagNumber(args, "width") }),
			...(flagNumber(args, "height") === undefined ? {} : { height: flagNumber(args, "height") }),
			...(flagNumber(args, "timeout") === undefined ? {} : { timeoutMs: flagNumber(args, "timeout") }),
		}),
		human: (result: Record<string, unknown>) => {
			const fields = result.fields as Array<Record<string, unknown>>;
			const lines = [
				`url        ${String(result.url)}`,
				`connected  ${String(result.connected)}   registered with host: ${String(result.registered)}`,
				"",
				"fields:",
				table([
					["SETTING", "TAG", "LABEL", "VALUE", "SCOPE", "VISIBLE"],
					...fields.map((field) => [
						String(field.setting),
						String(field.tag),
						String(field.label ?? ""),
						JSON.stringify(field.value),
						field.global === true ? "global" : "action",
						String(field.visible),
					]),
				]),
			];
			const errors = [...(result.consoleErrors as string[]), ...(result.pageErrors as string[])];
			if (errors.length > 0) {
				lines.push("", "page errors:", ...errors.map((error) => `  ${error}`));
			}
			if (result.hint !== undefined) {
				lines.push("", String(result.hint));
			}
			return lines.join("\n");
		},
	},
	"pi-snapshot": {
		method: "piSnapshot",
		summary: "Accessibility snapshot of the open property inspector.",
		usage: "pi-snapshot",
		params: () => ({}),
		human: (result: Record<string, unknown>) => String(result.snapshot),
	},
	"pi-fields": {
		method: "piFields",
		summary: "List the property inspector's settings-bound components and their values.",
		usage: "pi-fields",
		params: () => ({}),
		human: (fields: Array<Record<string, unknown>>) =>
			table([
				["SETTING", "TAG", "VALUE", "SCOPE", "VISIBLE"],
				...fields.map((field) => [
					String(field.setting),
					String(field.tag),
					JSON.stringify(field.value),
					field.global === true ? "global" : "action",
					String(field.visible),
				]),
			]),
	},
	"pi-set": {
		method: "piSet",
		summary: "Set a property inspector field by its `setting` attribute, as a user would.",
		usage: "pi-set <setting> <value> [--raw] [--settle MS]",
		params: (args) => ({
			setting: args.positional[0],
			value: coerce(args.positional[1], flagBool(args, "raw") === true),
			...(flagNumber(args, "settle") === undefined ? {} : { settleMs: flagNumber(args, "settle") }),
		}),
		human: (result: Record<string, unknown>) =>
			[
				`${String(result.setting)} = ${JSON.stringify(result.value)}`,
				`settings: ${JSON.stringify(result.settings)}`,
				`global:   ${JSON.stringify(result.globalSettings)}`,
			].join("\n"),
	},
	"pi-click": {
		method: "piClick",
		summary: "Click something in the property inspector (CSS selector, or visible text).",
		usage: "pi-click <selector-or-text> [--settle MS]",
		params: (args) => ({
			target: args.positional[0],
			...(flagNumber(args, "settle") === undefined ? {} : { settleMs: flagNumber(args, "settle") }),
		}),
		human: (result: Record<string, unknown>) =>
			`clicked ${String(result.clicked)}\nsettings: ${JSON.stringify(result.settings)}`,
	},
	"pi-screenshot": {
		method: "piScreenshot",
		summary: "Screenshot the open property inspector.",
		usage: "pi-screenshot [--name STEM] [--full-page false]",
		params: (args) => ({
			...(flagString(args, "name") === undefined ? {} : { name: flagString(args, "name") }),
			...(flagBool(args, "full-page") === undefined ? {} : { fullPage: flagBool(args, "full-page") }),
		}),
		human: (result: Record<string, unknown>) => `${String(result.png)}\n\n${String(result.note)}`,
	},
	"pi-console": {
		method: "piConsole",
		summary: "Console output and uncaught errors from the property inspector page.",
		usage: "pi-console",
		params: () => ({}),
		human: (result: { lines: Array<Record<string, unknown>>; pageErrors: string[] }) =>
			[
				...result.lines.map((line) => `[${String(line.type)}] ${String(line.text)}`),
				...result.pageErrors.map((error) => `[pageerror] ${error}`),
			].join("\n") || "(no output)",
	},
	"pi-close": {
		method: "piClose",
		summary: "Close the property inspector and send propertyInspectorDidDisappear.",
		usage: "pi-close",
		params: () => ({}),
		human: (result: Record<string, unknown>) => (result.closed === true ? "closed" : "no property inspector was open"),
	},
	"check-lifecycle": {
		method: "checkLifecycle",
		summary: "Cycle an action through appear/disappear and report whether it releases what it acquired.",
		usage:
			"check-lifecycle <action-uuid> [--cycles N] [--warmup N] [--settings '<json>'] [--interact press|none] [--heap-snapshot]",
		params: (args) => ({
			uuid: args.positional[0],
			...(flagNumber(args, "cycles") === undefined ? {} : { cycles: flagNumber(args, "cycles") }),
			...(flagNumber(args, "warmup") === undefined ? {} : { warmup: flagNumber(args, "warmup") }),
			...(flagJson(args, "settings") === undefined ? {} : { settings: flagJson(args, "settings") }),
			...(flagString(args, "interact") === undefined ? {} : { interact: flagString(args, "interact") }),
			...(flagNumber(args, "quiet") === undefined ? {} : { quietMs: flagNumber(args, "quiet") }),
			...(flagNumber(args, "max-bytes-per-cycle") === undefined
				? {}
				: { maxBytesPerCycle: flagNumber(args, "max-bytes-per-cycle") }),
			...(flagNumber(args, "max-handles-per-cycle") === undefined
				? {}
				: { maxHandlesPerCycle: flagNumber(args, "max-handles-per-cycle") }),
			...(flagBool(args, "heap-snapshot") === undefined ? {} : { heapSnapshot: flagBool(args, "heap-snapshot") }),
		}),
		human: (result: Record<string, unknown>) => {
			const samples = result.samples as Array<Record<string, unknown>>;
			const handles = result.handlesPerCycle as Record<string, number>;
			const lines = [
				`verdict     ${String(result.verdict).toUpperCase()}`,
				`action      ${String(result.action)}`,
				`measured    ${String(result.measurement)} over ${String(result.cycles)} cycle(s) after ${String(result.warmup)} warm-up`,
				"",
				...(result.reasons as string[]).map((reason) => `  - ${reason}`),
				"",
				table([
					["CYCLE", "RETAINED", "JS HEAP", "EXTERNAL", "RSS", "HANDLES"],
					...samples.map((entry) => [
						String(entry.cycle),
						mib(entry.retained),
						mib(entry.heapUsed),
						mib(entry.external),
						mib(entry.rss),
						Object.entries(entry.handles as Record<string, number>)
							.map(([type, count]) => `${type}:${count}`)
							.join(" ") || "-",
					]),
				]),
			];
			if (Object.keys(handles).length > 0) {
				lines.push("", `handle growth per cycle: ${JSON.stringify(handles)}`);
			}
			if (result.heapSnapshotPath !== undefined) {
				lines.push("", `heap snapshot: ${String(result.heapSnapshotPath)}`);
				lines.push(
					...(result.topRetainers as Array<Record<string, unknown>>)
						.slice(0, 10)
						.map(
							(entry) =>
								`  ${String(entry.name)}  x${String(entry.count)}  ${(Number(entry.selfSize) / 1024).toFixed(0)} KiB`,
						),
				);
			}
			lines.push("", String(result.note));
			return lines.join("\n");
		},
	},
	events: {
		method: "events",
		summary: "Read the WebSocket transcript in both directions.",
		usage:
			"events [--event a,b] [--direction to-plugin,from-plugin] [--context C] [--action U] [--since SEQ] [--limit N]",
		params: (args) => ({
			...(flagList(args, "event") === undefined ? {} : { event: flagList(args, "event") }),
			...(flagList(args, "direction") === undefined ? {} : { direction: flagList(args, "direction") }),
			...(flagString(args, "context") === undefined ? {} : { context: flagString(args, "context") }),
			...(flagString(args, "action") === undefined ? {} : { action: flagString(args, "action") }),
			...(flagNumber(args, "since") === undefined ? {} : { sinceSeq: flagNumber(args, "since") }),
			...(flagNumber(args, "limit") === undefined ? {} : { limit: flagNumber(args, "limit") }),
		}),
		human: (result: {
			total: number;
			entries: Array<Record<string, unknown>>;
			violations: Array<Record<string, unknown>>;
		}) => {
			const arrows: Record<string, string> = {
				"to-plugin": "->",
				"from-plugin": "<-",
				"to-pi": "=>",
				"from-pi": "<=",
				harness: "..",
			};
			const rows = result.entries.map((entry) => [
				String(entry.seq).padStart(4),
				`${String(entry.at)}ms`,
				arrows[String(entry.direction)] ?? "??",
				String(entry.event),
				entry.context === undefined ? "" : String(entry.context).slice(0, 8),
			]);
			const violations = result.violations.map(
				(violation) => `  ! ${String(violation.kind)}: ${String(violation.message)}`,
			);
			return [
				table(rows),
				`${result.total} entr${result.total === 1 ? "y" : "ies"}`,
				...(violations.length > 0 ? ["", "violations:", ...violations] : []),
			].join("\n");
		},
	},
	violations: {
		method: "violations",
		summary: "Protocol and lifecycle violations the harness detected.",
		usage: "violations [--since SEQ]",
		params: (args) => ({ ...(flagNumber(args, "since") === undefined ? {} : { sinceSeq: flagNumber(args, "since") }) }),
		human: (rows: Array<Record<string, unknown>>) =>
			rows.length === 0 ? "no violations" : rows.map((row) => `${String(row.kind)}: ${String(row.message)}`).join("\n"),
	},
	"wait-quiet": {
		method: "waitQuiet",
		summary: "Block until the plugin stops sending frames.",
		usage: "wait-quiet [--quiet MS] [--timeout MS]",
		params: (args) => ({
			...(flagNumber(args, "quiet") === undefined ? {} : { quietMs: flagNumber(args, "quiet") }),
			...(flagNumber(args, "timeout") === undefined ? {} : { timeoutMs: flagNumber(args, "timeout") }),
		}),
		human: (result: Record<string, unknown>) => `quiet at seq ${String(result.seq)}`,
	},
	logs: {
		method: "logs",
		summary: "Read the plugin's own log files under <sdPlugin>/logs.",
		usage: "logs [--level ERROR,WARN] [--limit N] [--since-start false]",
		params: (args) => ({
			...(flagList(args, "level") === undefined ? {} : { level: flagList(args, "level") }),
			...(flagNumber(args, "limit") === undefined ? {} : { limit: flagNumber(args, "limit") }),
			...(flagBool(args, "since-start") === undefined ? {} : { sinceStart: flagBool(args, "since-start") }),
		}),
		human: (result: { total: number; lines: Array<Record<string, unknown>> }) =>
			result.lines.length === 0
				? "(no matching log lines)"
				: result.lines.map((line) => `${String(line.level ?? "")} ${String(line.text)}`).join("\n"),
	},
	output: {
		method: "output",
		summary: "Read the plugin process's stdout and stderr.",
		usage: "output [--limit N]",
		params: (args) => ({ ...(flagNumber(args, "limit") === undefined ? {} : { limit: flagNumber(args, "limit") }) }),
		human: (result: { running: boolean; exit: unknown; lines: Array<Record<string, unknown>> }) =>
			[
				`running: ${String(result.running)}${result.exit === null ? "" : ` exit: ${JSON.stringify(result.exit)}`}`,
				...result.lines.map((line) => `[${String(line.stream)}] ${String(line.text)}`),
			].join("\n"),
	},
};

function helpText(): string {
	const rows = [
		["start <path>", "Launch a plugin headlessly and hold it open in a background daemon."],
		["close [--all]", "Stop a session (or every session) and clean up."],
		["list", "List sessions."],
		["lint-svg <paths>", "Check SVGs against SVG Tiny 1.2 and the Stream Deck renderer (no session needed)."],
		["run <scenario.yaml>", "Run a whole declarative check in one call and print a single report."],
		...Object.entries(REMOTE).map(([verb, remote]) => [verb, remote.summary]),
	];
	return [
		"sdtest -- headless test harness for Stream Deck plugins",
		"",
		"usage: sdtest [-s=<session>] <command> [args] [--json]",
		"",
		table(rows.map(([verb, summary]) => [`  ${verb!}`, summary!])),
		"",
		"Sessions run detached and headless; the real Stream Deck app is never touched.",
	].join("\n");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	setJsonMode(args.flags.get("json") === true || args.flags.get("json") === "true");

	if (args.verb === "help" || args.flags.get("help") === true) {
		print(helpText());
		return;
	}

	if (args.verb === "start") {
		await startCommand(args);
		return;
	}
	if (args.verb === "close") {
		await closeCommand(args);
		return;
	}
	if (args.verb === "list") {
		listCommand();
		return;
	}
	if (args.verb === "lint-svg") {
		lintCommand(args);
		return;
	}
	if (args.verb === "run") {
		await runCommand(args);
		return;
	}

	const remote = REMOTE[args.verb];
	if (remote === undefined) {
		fail(`unknown command "${args.verb}". Run "sdtest help" for the list.`);
	}

	const client = await DaemonClient.connect(args.session);
	try {
		const result = await client.call(remote.method, remote.params(args));
		if (remote.human === undefined || isJsonMode()) {
			emit(result, () => JSON.stringify(result, null, 2));
		} else {
			emit(result, remote.human as (value: never) => string);
		}
	} finally {
		client.close();
	}
}

main().catch((cause: unknown) => {
	fail((cause as Error).message);
});
