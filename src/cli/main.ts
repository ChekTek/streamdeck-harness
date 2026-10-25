#!/usr/bin/env node
import {
	compactJson,
	errorMessage,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../host/protocol.js";
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
	params: (args: Args) => JsonObject;
	human?: (result: JsonValue) => string;
};

function jsonObject(value: JsonValue | undefined): JsonObject {
	return isJsonObject(value) ? value : {};
}

function jsonArray(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

function text(value: JsonValue | undefined): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (isJsonObject(value) || Array.isArray(value)) {
		return JSON.stringify(value);
	}
	return String(value);
}

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
function coerce(value: string | undefined, raw: boolean): JsonValue {
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

function mib(value: JsonValue | undefined): string {
	return isJsonNumber(value) ? `${(value / 1024 / 1024).toFixed(2)} MiB` : "-";
}

function keySummary(result: JsonValue): string {
	const row = jsonObject(result);
	const coordinates = row.coordinates;
	const position =
		coordinates === null
			? "multi-action"
			: isJsonObject(coordinates)
				? `column ${text(coordinates.column)}, row ${text(coordinates.row)}`
				: "multi-action";
	return [
		`context   ${text(row.context)}`,
		`action    ${text(row.action)}  (${text(row.name)})`,
		`position  ${position}`,
		`visible   ${text(row.visible)}`,
		`state     ${text(row.state)} of ${text(row.stateCount)}`,
		`title     ${JSON.stringify(row.title)}`,
		`image     ${text(row.imageSource)}${row.imageSource === "manifest" ? ` (${text(row.manifestImage)})` : ""}`,
		`settings  ${JSON.stringify(row.settings)}`,
	].join("\n");
}

function stringifyResult(result: JsonValue): string {
	return JSON.stringify(result, null, 2);
}

function fieldsTable(fields: JsonValue[], columns: string[]): string {
	return table([
		columns,
		...fields.map((entry) => {
			const field = jsonObject(entry);
			return columns.map((column) => {
				switch (column) {
					case "SETTING":
						return text(field.setting);
					case "TAG":
						return text(field.tag);
					case "LABEL":
						return text(field.label ?? "");
					case "VALUE":
						return JSON.stringify(field.value);
					case "SCOPE":
						return field.global === true ? "global" : "action";
					case "VISIBLE":
						return text(field.visible);
					default:
						return "";
				}
			});
		}),
	]);
}

const REMOTE = {
	info: {
		method: "info",
		summary: "Show the running session: plugin, runtime, devices, declared actions.",
		usage: "info",
		params: (): JsonObject => ({}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return [
				`plugin    ${text(row.plugin)} ${text(row.version)}`,
				`runtime   ${text(row.runtime)} -> ${text(row.codePath)}`,
				`pid       ${text(row.pid)}   port ${text(row.port)}`,
				`inspector ${text(row.inspector ?? "not attached")}`,
				`artifacts ${text(row.artifacts)}`,
			].join("\n");
		},
	},
	actions: {
		method: "actions",
		summary: "List the action instances currently placed on the emulated device.",
		usage: "actions",
		params: (): JsonObject => ({}),
		human: (rows: JsonValue): string =>
			table([
				["CONTEXT", "ACTION", "POS", "VISIBLE", "STATE", "TITLE"],
				...jsonArray(rows).map((entry) => {
					const row = jsonObject(entry);
					const coordinates = row.coordinates;
					return [
						text(row.context),
						text(row.action),
						coordinates === null
							? "multi"
							: isJsonObject(coordinates)
								? `${text(coordinates.column)},${text(coordinates.row)}`
								: "multi",
						text(row.visible),
						`${text(row.state)}/${text(row.stateCount)}`,
						JSON.stringify(row.title),
					];
				}),
			]),
	},
	add: {
		method: "add",
		summary: "Place an action on the device and send willAppear.",
		usage: "add <action-uuid> [--settings '<json>'] [--column N --row N] [--state N] [--title T] [--no-appear]",
		params: (args: Args): JsonObject => {
			const payload = compactJson({
				uuid: args.positional[0],
				settings: flagJson(args, "settings"),
				column: flagNumber(args, "column"),
				row: flagNumber(args, "row"),
				state: flagNumber(args, "state"),
				title: flagString(args, "title"),
				device: flagString(args, "device"),
				controller: flagString(args, "controller"),
				multiAction: flagBool(args, "multi-action"),
			});
			if (flagBool(args, "appear") === false) {
				payload.appear = false;
			}
			return payload;
		},
		human: keySummary,
	},
	remove: {
		method: "remove",
		summary: "Send willDisappear and drop the instance.",
		usage: "remove <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return `removed ${text(row.removed)} (${text(row.action)})`;
		},
	},
	appear: {
		method: "appear",
		summary: "Re-send willAppear for an instance.",
		usage: "appear <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: keySummary,
	},
	disappear: {
		method: "disappear",
		summary: "Send willDisappear without removing the instance.",
		usage: "disappear <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return `${text(row.context)} visible=${text(row.visible)}`;
		},
	},
	press: {
		method: "press",
		summary: "keyDown, hold, keyUp, then wait for the plugin to settle.",
		usage: "press <ref> [--hold MS] [--settle MS] [--desired-state N]",
		params: (args: Args): JsonObject =>
			compactJson({
				ref: ref(args),
				holdMs: flagNumber(args, "hold"),
				settleMs: flagNumber(args, "settle"),
				userDesiredState: flagNumber(args, "desired-state"),
			}),
		human: keySummary,
	},
	"key-down": {
		method: "keyDown",
		summary: "Send keyDown only.",
		usage: "key-down <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: (result: JsonValue): string => `keyDown -> ${text(jsonObject(result).context)}`,
	},
	"key-up": {
		method: "keyUp",
		summary: "Send keyUp only.",
		usage: "key-up <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: (result: JsonValue): string => `keyUp -> ${text(jsonObject(result).context)}`,
	},
	key: {
		method: "key",
		summary: "Show what the plugin has set on one key.",
		usage: "key <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: keySummary,
	},
	screenshot: {
		method: "screenshot",
		summary: "Render the key to a PNG and lint the SVG behind it.",
		usage: "screenshot <ref> [--size PX] [--name STEM]",
		params: (args: Args): JsonObject =>
			compactJson({
				ref: ref(args),
				size: flagNumber(args, "size"),
				name: flagString(args, "name"),
			}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			const lint = isJsonObject(row.lint) ? row.lint : undefined;
			const lines = [
				`png    ${text(row.png)}`,
				row.svg === null ? "svg    (raster image)" : `svg    ${text(row.svg)}`,
				`source ${text(row.imageSource)}${row.imagePath === null || row.imagePath === undefined ? "" : ` -> ${text(row.imagePath)}`}`,
				`title  ${JSON.stringify(row.title)}   state ${text(row.state)}`,
			];
			if (row.imageError !== null && row.imageError !== undefined) {
				lines.push(`ERROR  ${text(row.imageError)}`);
			}
			if (lint !== undefined) {
				lines.push(`lint   ${text(lint.errors)} error(s), ${text(lint.warnings)} warning(s)`);
				lines.push(
					...jsonArray(lint.findings).map((entry) => {
						const finding = jsonObject(entry);
						return `       ${text(finding.severity)} [${text(finding.rule)}] ${text(finding.message)}`;
					}),
				);
			}
			lines.push("", text(row.note));
			return lines.join("\n");
		},
	},
	settings: {
		method: "getSettings",
		summary: "Read an instance's settings.",
		usage: "settings <ref>",
		params: (args: Args): JsonObject => ({ ref: ref(args) }),
		human: stringifyResult,
	},
	"set-settings": {
		method: "setSettings",
		summary: "Write settings and notify the plugin, as the property inspector would.",
		usage: "set-settings <ref> --settings '<json>'",
		params: (args: Args): JsonObject => compactJson({ ref: ref(args), settings: flagJson(args, "settings") }),
		human: stringifyResult,
	},
	"global-settings": {
		method: "getGlobalSettings",
		summary: "Read global settings.",
		usage: "global-settings",
		params: (): JsonObject => ({}),
		human: stringifyResult,
	},
	"set-global-settings": {
		method: "setGlobalSettings",
		summary: "Write global settings and notify the plugin.",
		usage: "set-global-settings --settings '<json>'",
		params: (args: Args): JsonObject => compactJson({ settings: flagJson(args, "settings") }),
		human: stringifyResult,
	},
	"set-secrets": {
		method: "setSecrets",
		summary: "Push secrets to the plugin (SDK v3).",
		usage: "set-secrets --secrets '<json>'",
		params: (args: Args): JsonObject => compactJson({ secrets: flagJson(args, "secrets") }),
		human: (result: JsonValue): string => `secrets: ${jsonArray(jsonObject(result).secrets).map((entry) => text(entry)).join(", ")}`,
	},
	"pi-open": {
		method: "piOpen",
		summary: "Render an action's property inspector headlessly and connect it to the mock host.",
		usage: "pi-open <ref> [--width PX] [--height PX] [--timeout MS]",
		params: (args: Args): JsonObject =>
			compactJson({
				ref: ref(args),
				width: flagNumber(args, "width"),
				height: flagNumber(args, "height"),
				timeoutMs: flagNumber(args, "timeout"),
			}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			const lines = [
				`url        ${text(row.url)}`,
				`connected  ${text(row.connected)}   registered with host: ${text(row.registered)}`,
				"",
				"fields:",
				fieldsTable(jsonArray(row.fields), ["SETTING", "TAG", "LABEL", "VALUE", "SCOPE", "VISIBLE"]),
			];
			const errors = [...jsonArray(row.consoleErrors).map(text), ...jsonArray(row.pageErrors).map(text)];
			if (errors.length > 0) {
				lines.push("", "page errors:", ...errors.map((error) => `  ${error}`));
			}
			if (row.hint !== undefined) {
				lines.push("", text(row.hint));
			}
			return lines.join("\n");
		},
	},
	"pi-snapshot": {
		method: "piSnapshot",
		summary: "Accessibility snapshot of the open property inspector.",
		usage: "pi-snapshot",
		params: (): JsonObject => ({}),
		human: (result: JsonValue): string => text(jsonObject(result).snapshot),
	},
	"pi-fields": {
		method: "piFields",
		summary: "List the property inspector's settings-bound components and their values.",
		usage: "pi-fields",
		params: (): JsonObject => ({}),
		human: (fields: JsonValue): string => fieldsTable(jsonArray(fields), ["SETTING", "TAG", "VALUE", "SCOPE", "VISIBLE"]),
	},
	"pi-set": {
		method: "piSet",
		summary: "Set a property inspector field by its `setting` attribute, as a user would.",
		usage: "pi-set <setting> <value> [--raw] [--settle MS]",
		params: (args: Args): JsonObject =>
			compactJson({
				setting: args.positional[0],
				value: coerce(args.positional[1], flagBool(args, "raw") === true),
				settleMs: flagNumber(args, "settle"),
			}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return [
				`${text(row.setting)} = ${JSON.stringify(row.value)}`,
				`settings: ${JSON.stringify(row.settings)}`,
				`global:   ${JSON.stringify(row.globalSettings)}`,
			].join("\n");
		},
	},
	"pi-click": {
		method: "piClick",
		summary: "Click something in the property inspector (CSS selector, or visible text).",
		usage: "pi-click <selector-or-text> [--settle MS]",
		params: (args: Args): JsonObject => compactJson({ target: args.positional[0], settleMs: flagNumber(args, "settle") }),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return `clicked ${text(row.clicked)}\nsettings: ${JSON.stringify(row.settings)}`;
		},
	},
	"pi-screenshot": {
		method: "piScreenshot",
		summary: "Screenshot the open property inspector.",
		usage: "pi-screenshot [--name STEM] [--full-page false]",
		params: (args: Args): JsonObject => compactJson({ name: flagString(args, "name"), fullPage: flagBool(args, "full-page") }),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return `${text(row.png)}\n\n${text(row.note)}`;
		},
	},
	"pi-console": {
		method: "piConsole",
		summary: "Console output and uncaught errors from the property inspector page.",
		usage: "pi-console",
		params: (): JsonObject => ({}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return (
				[
					...jsonArray(row.lines).map((entry) => {
						const line = jsonObject(entry);
						return `[${text(line.type)}] ${text(line.text)}`;
					}),
					...jsonArray(row.pageErrors).map((error) => `[pageerror] ${text(error)}`),
				].join("\n") || "(no output)"
			);
		},
	},
	"pi-close": {
		method: "piClose",
		summary: "Close the property inspector and send propertyInspectorDidDisappear.",
		usage: "pi-close",
		params: (): JsonObject => ({}),
		human: (result: JsonValue): string =>
			isJsonBoolean(jsonObject(result).closed) && jsonObject(result).closed
				? "closed"
				: "no property inspector was open",
	},
	"check-lifecycle": {
		method: "checkLifecycle",
		summary: "Cycle an action through appear/disappear and report whether it releases what it acquired.",
		usage:
			"check-lifecycle <action-uuid> [--cycles N] [--warmup N] [--settings '<json>'] [--interact press|none] [--heap-snapshot]",
		params: (args: Args): JsonObject =>
			compactJson({
				uuid: args.positional[0],
				cycles: flagNumber(args, "cycles"),
				warmup: flagNumber(args, "warmup"),
				settings: flagJson(args, "settings"),
				interact: flagString(args, "interact"),
				quietMs: flagNumber(args, "quiet"),
				maxBytesPerCycle: flagNumber(args, "max-bytes-per-cycle"),
				maxHandlesPerCycle: flagNumber(args, "max-handles-per-cycle"),
				heapSnapshot: flagBool(args, "heap-snapshot"),
			}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			const samples = jsonArray(row.samples);
			const handles = jsonObject(row.handlesPerCycle);
			const lines = [
				`verdict     ${text(row.verdict).toUpperCase()}`,
				`action      ${text(row.action)}`,
				`measured    ${text(row.measurement)} over ${text(row.cycles)} cycle(s) after ${text(row.warmup)} warm-up`,
				"",
				...jsonArray(row.reasons).map((reason) => `  - ${text(reason)}`),
				"",
				table([
					["CYCLE", "RETAINED", "JS HEAP", "EXTERNAL", "RSS", "HANDLES"],
					...samples.map((entry) => {
						const sample = jsonObject(entry);
						const sampleHandles = jsonObject(sample.handles);
						return [
							text(sample.cycle),
							mib(sample.retained),
							mib(sample.heapUsed),
							mib(sample.external),
							mib(sample.rss),
							Object.entries(sampleHandles)
								.map(([type, count]) => `${type}:${text(count)}`)
								.join(" ") || "-",
						];
					}),
				]),
			];
			if (Object.keys(handles).length > 0) {
				lines.push("", `handle growth per cycle: ${JSON.stringify(handles)}`);
			}
			if (row.heapSnapshotPath !== undefined) {
				lines.push("", `heap snapshot: ${text(row.heapSnapshotPath)}`);
				lines.push(
					...jsonArray(row.topRetainers)
						.slice(0, 10)
						.map((entry) => {
							const retainer = jsonObject(entry);
							const size = isJsonNumber(retainer.selfSize) ? retainer.selfSize : 0;
							return `  ${text(retainer.name)}  x${text(retainer.count)}  ${(size / 1024).toFixed(0)} KiB`;
						}),
				);
			}
			lines.push("", text(row.note));
			return lines.join("\n");
		},
	},
	events: {
		method: "events",
		summary: "Read the WebSocket transcript in both directions.",
		usage:
			"events [--event a,b] [--direction to-plugin,from-plugin] [--context C] [--action U] [--since SEQ] [--limit N]",
		params: (args: Args): JsonObject =>
			compactJson({
				event: flagList(args, "event"),
				direction: flagList(args, "direction"),
				context: flagString(args, "context"),
				action: flagString(args, "action"),
				sinceSeq: flagNumber(args, "since"),
				limit: flagNumber(args, "limit"),
			}),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			const arrows = {
				"to-plugin": "->",
				"from-plugin": "<-",
				"to-pi": "=>",
				"from-pi": "<=",
				harness: "..",
			} as const;
			const rows = jsonArray(row.entries).map((entry) => {
				const item = jsonObject(entry);
				const direction = text(item.direction);
				let arrow = "??";
				for (const [name, symbol] of Object.entries(arrows)) {
					if (name === direction) {
						arrow = symbol;
					}
				}
				return [
					text(item.seq).padStart(4),
					`${text(item.at)}ms`,
					arrow,
					text(item.event),
					item.context === undefined ? "" : text(item.context).slice(0, 8),
				];
			});
			const violations = jsonArray(row.violations).map((entry) => {
				const violation = jsonObject(entry);
				return `  ! ${text(violation.kind)}: ${text(violation.message)}`;
			});
			const total = isJsonNumber(row.total) ? row.total : 0;
			return [
				table(rows),
				`${total} entr${total === 1 ? "y" : "ies"}`,
				...(violations.length > 0 ? ["", "violations:", ...violations] : []),
			].join("\n");
		},
	},
	violations: {
		method: "violations",
		summary: "Protocol and lifecycle violations the harness detected.",
		usage: "violations [--since SEQ]",
		params: (args: Args): JsonObject => compactJson({ sinceSeq: flagNumber(args, "since") }),
		human: (rows: JsonValue): string => {
			const list = jsonArray(rows);
			return list.length === 0
				? "no violations"
				: list
					.map((entry) => {
						const row = jsonObject(entry);
						return `${text(row.kind)}: ${text(row.message)}`;
					})
					.join("\n");
		},
	},
	"wait-quiet": {
		method: "waitQuiet",
		summary: "Block until the plugin stops sending frames.",
		usage: "wait-quiet [--quiet MS] [--timeout MS]",
		params: (args: Args): JsonObject => compactJson({ quietMs: flagNumber(args, "quiet"), timeoutMs: flagNumber(args, "timeout") }),
		human: (result: JsonValue): string => `quiet at seq ${text(jsonObject(result).seq)}`,
	},
	logs: {
		method: "logs",
		summary: "Read the plugin's own log files under <sdPlugin>/logs.",
		usage: "logs [--level ERROR,WARN] [--limit N] [--since-start false]",
		params: (args: Args): JsonObject =>
			compactJson({
				level: flagList(args, "level"),
				limit: flagNumber(args, "limit"),
				sinceStart: flagBool(args, "since-start"),
			}),
		human: (result: JsonValue): string => {
			const lines = jsonArray(jsonObject(result).lines);
			return lines.length === 0
				? "(no matching log lines)"
				: lines
					.map((entry) => {
						const line = jsonObject(entry);
						return `${text(line.level ?? "")} ${text(line.text)}`;
					})
					.join("\n");
		},
	},
	output: {
		method: "output",
		summary: "Read the plugin process's stdout and stderr.",
		usage: "output [--limit N]",
		params: (args: Args): JsonObject => compactJson({ limit: flagNumber(args, "limit") }),
		human: (result: JsonValue): string => {
			const row = jsonObject(result);
			return [
				`running: ${text(row.running)}${row.exit === null || row.exit === undefined ? "" : ` exit: ${JSON.stringify(row.exit)}`}`,
				...jsonArray(row.lines).map((entry) => {
					const line = jsonObject(entry);
					return `[${text(line.stream)}] ${text(line.text)}`;
				}),
			].join("\n");
		},
	},
} satisfies { [verb: string]: Remote };

function remoteFor(verb: string): Remote | undefined {
	for (const [name, remote] of Object.entries(REMOTE)) {
		if (name === verb) {
			return remote;
		}
	}
	return undefined;
}

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

	const remote = remoteFor(args.verb);
	if (remote === undefined) {
		fail(`unknown command "${args.verb}". Run "sdtest help" for the list.`);
	}

	const client = await DaemonClient.connect(args.session);
	try {
		const result = await client.call(remote.method, remote.params(args));
		if (remote.human === undefined || isJsonMode()) {
			emit(result, stringifyResult);
		} else {
			emit(result, remote.human);
		}
	} finally {
		client.close();
	}
}

main().catch((cause: unknown) => {
	fail(errorMessage(cause));
});
