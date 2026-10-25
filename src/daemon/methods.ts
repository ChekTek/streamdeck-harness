import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkLifecycle, LIFECYCLE_DEFAULTS } from "../checks/lifecycle.js";
import type { ActionInstance } from "../host/action.js";
import {
	compactJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../host/protocol.js";
import type { Direction, EntryFilter } from "../host/recorder.js";
import { Inspector } from "../pi/inspector.js";
import { readPluginLogs } from "../plugin/logs.js";
import { getBrowser } from "../render/chromium.js";
import { keyHtml, resolveKeyImage } from "../render/key.js";
import type { Session } from "./session.js";

export type MethodContext = {
	session: Session;
	shutdown: (reason: string) => Promise<void>;
};

export type Method = (context: MethodContext, params: JsonObject) => JsonValue | Promise<JsonValue>;

function str(params: JsonObject, key: string): string | undefined {
	const value = params[key];
	return isJsonString(value) ? value : undefined;
}

function requireStr(params: JsonObject, key: string): string {
	const value = str(params, key);
	if (value === undefined) {
		throw new Error(`missing required parameter "${key}"`);
	}
	return value;
}

function num(params: JsonObject, key: string): number | undefined {
	const value = params[key];
	return isJsonNumber(value) ? value : undefined;
}

function bool(params: JsonObject, key: string): boolean | undefined {
	const value = params[key];
	return isJsonBoolean(value) ? value : undefined;
}

function obj(params: JsonObject, key: string): JsonObject | undefined {
	const value = params[key];
	return isJsonObject(value) ? value : undefined;
}

function strArray(params: JsonObject, key: string): string[] | undefined {
	const value = params[key];
	return Array.isArray(value) ? value.filter((item) => isJsonString(item)) : undefined;
}

function isDirection(value: string): value is Direction {
	return (
		value === "from-pi" ||
		value === "from-plugin" ||
		value === "harness" ||
		value === "to-pi" ||
		value === "to-plugin"
	);
}

/**
 * Resolves an action reference: a context id, or an action UUID when exactly one instance
 * of it exists. Agents overwhelmingly have the UUID, not the generated context.
 */
function resolve(session: Session, ref: string): ActionInstance {
	const byContext = session.host.allActions().find((instance) => instance.context === ref);
	if (byContext !== undefined) {
		return byContext;
	}

	const byUuid = session.host.findByUuid(ref);
	if (byUuid.length === 1) {
		return byUuid[0]!;
	}
	if (byUuid.length > 1) {
		throw new Error(
			`${byUuid.length} instances of ${ref} exist; pass a context instead:\n  ${byUuid.map((i) => i.context).join("\n  ")}`,
		);
	}

	const known = session.host
		.allActions()
		.map((i) => `${i.context}  ${i.uuid}`)
		.join("\n  ");
	throw new Error(
		`no action instance matching "${ref}"${known.length > 0 ? `. Live instances:\n  ${known}` : " (none added yet)"}`,
	);
}

function requireInspector(session: Session): Inspector {
	if (session.propertyInspector === undefined) {
		throw new Error("no property inspector is open. Open one first: sdtest pi-open <ref>");
	}
	return session.propertyInspector;
}

function describeInstance(session: Session, instance: ActionInstance): JsonObject {
	const override = instance.effectiveImage;
	const parameters = instance.titleParameters;
	return compactJson({
		context: instance.context,
		action: instance.uuid,
		name: instance.definition.Name,
		device: instance.device.id,
		controller: instance.controller,
		coordinates:
			instance.coordinates === undefined
				? null
				: compactJson({ column: instance.coordinates.column, row: instance.coordinates.row }),
		visible: instance.visible,
		state: instance.state,
		stateCount: instance.stateCount,
		title: instance.effectiveTitle,
		titleParameters: compactJson({
			fontFamily: parameters.fontFamily,
			fontSize: parameters.fontSize,
			fontStyle: parameters.fontStyle,
			fontUnderline: parameters.fontUnderline,
			showTitle: parameters.showTitle,
			titleAlignment: parameters.titleAlignment,
			titleColor: parameters.titleColor,
		}),
		imageSource: override === undefined ? "manifest" : "setImage",
		manifestImage: instance.manifestState?.Image ?? null,
		settings: session.host.settings.get(instance.context),
		resources: session.host.settings.getResources(instance.context),
		hasPropertyInspector: session.host.hasUi(instance.context),
		flashes: instance.flashes.map((flash) => compactJson({ kind: flash.kind, at: flash.at })),
	});
}

function wireJson(value: JsonValue): JsonValue {
	return parseJsonValue(JSON.stringify(value));
}

export const methods = {
	info({ session }: MethodContext): JsonValue {
		return session.describe();
	},

	close({ shutdown }: MethodContext): JsonValue {
		// Reply first: the shutdown tears down the very connection carrying this response.
		setTimeout(() => void shutdown("requested"), 0);
		return compactJson({ closed: true });
	},

	actions({ session }: MethodContext): JsonValue {
		return session.host.allActions().map((instance) => describeInstance(session, instance));
	},

	add({ session }: MethodContext, params: JsonObject): JsonValue {
		const column = num(params, "column");
		const row = num(params, "row");
		const deviceId = str(params, "device");
		const device =
			deviceId === undefined ? undefined : session.host.devices.find((candidate) => candidate.id === deviceId);
		if (deviceId !== undefined && device === undefined) {
			throw new Error(`no emulated device with id ${deviceId}`);
		}

		const controller = str(params, "controller");
		const added = session.host.addAction({
			uuid: requireStr(params, "uuid"),
			device,
			coordinates: column === undefined || row === undefined ? undefined : { column, row },
			controller: controller === "Keypad" || controller === "Encoder" ? controller : undefined,
			settings: obj(params, "settings"),
			state: num(params, "state"),
			title: str(params, "title"),
			isInMultiAction: bool(params, "multiAction"),
			appear: bool(params, "appear"),
		});
		return describeInstance(session, added);
	},

	remove({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.removeAction(instance);
		return compactJson({ removed: instance.context, action: instance.uuid });
	},

	appear({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.appear(instance);
		return describeInstance(session, instance);
	},

	disappear({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.disappear(instance);
		return compactJson({ context: instance.context, visible: instance.visible });
	},

	async press({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const instance = resolve(session, requireStr(params, "ref"));
		const holdMs = num(params, "holdMs") ?? 40;
		const desired = num(params, "userDesiredState");

		session.host.keyDown(instance, desired);
		await new Promise((done) => setTimeout(done, holdMs));
		session.host.keyUp(instance, desired);

		const settleMs = num(params, "settleMs") ?? 250;
		await new Promise((done) => setTimeout(done, settleMs));
		return describeInstance(session, instance);
	},

	keyDown({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.keyDown(instance, num(params, "userDesiredState"));
		return compactJson({ context: instance.context });
	},

	keyUp({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.keyUp(instance, num(params, "userDesiredState"));
		return compactJson({ context: instance.context });
	},

	key({ session }: MethodContext, params: JsonObject): JsonValue {
		return describeInstance(session, resolve(session, requireStr(params, "ref")));
	},

	/**
	 * Renders the key as Stream Deck would show it and writes a PNG. The SVG source and its
	 * Tiny 1.2 lint come back alongside -- reading those is cheaper than reading the image.
	 */
	async screenshot({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const instance = resolve(session, requireStr(params, "ref"));
		const size = num(params, "size") ?? 144;
		const image = resolveKeyImage(session.project, instance);

		const stem = str(params, "name") ?? `${instance.uuid.split(".").pop() ?? "key"}-${instance.context.slice(0, 8)}`;
		const pngPath = join(session.artifacts, `${stem}.png`);

		const browser = await getBrowser();
		const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
		try {
			await page.setContent(keyHtml(instance, image, size), { waitUntil: "load" });
			await page.locator("#key").screenshot({ path: pngPath });
		} finally {
			await page.close();
		}

		let svgPath: string | undefined;
		if (image.svg !== undefined) {
			svgPath = join(session.artifacts, `${stem}.svg`);
			writeFileSync(svgPath, image.svg);
		}

		return compactJson({
			png: pngPath,
			svg: svgPath ?? null,
			size,
			imageSource: image.origin,
			imagePath: image.path ?? null,
			imageError: image.error ?? null,
			title: instance.effectiveTitle,
			state: instance.state,
			lint:
				image.lint === undefined
					? null
					: compactJson({
						errors: image.lint.errors,
						warnings: image.lint.warnings,
						findings: image.lint.findings.map((finding) =>
							compactJson({
								severity: finding.severity,
								source: finding.source,
								rule: finding.rule,
								message: finding.message,
								fix: finding.fix,
								line: finding.line,
								column: finding.column,
							}),
						),
					}),
			note: "Rendered in headless Chromium, which is more permissive than Stream Deck's Qt renderer. Trust the lint over the picture.",
		});
	},

	getSettings({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		return session.host.settings.get(instance.context);
	},

	setSettings({ session }: MethodContext, params: JsonObject): JsonValue {
		const instance = resolve(session, requireStr(params, "ref"));
		const settings = obj(params, "settings");
		if (settings === undefined) {
			throw new Error('missing required parameter "settings" (a JSON object)');
		}
		session.host.pushSettings(instance, settings);
		return session.host.settings.get(instance.context);
	},

	getGlobalSettings({ session }: MethodContext): JsonValue {
		return session.host.settings.getGlobal();
	},

	setGlobalSettings({ session }: MethodContext, params: JsonObject): JsonValue {
		const settings = obj(params, "settings");
		if (settings === undefined) {
			throw new Error('missing required parameter "settings" (a JSON object)');
		}
		session.host.pushGlobalSettings(settings);
		return session.host.settings.getGlobal();
	},

	setSecrets({ session }: MethodContext, params: JsonObject): JsonValue {
		const secrets = obj(params, "secrets");
		if (secrets === undefined) {
			throw new Error('missing required parameter "secrets" (a JSON object)');
		}
		session.host.pushSecrets(secrets);
		return compactJson({ secrets: Object.keys(secrets) });
	},

	async piOpen({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const instance = resolve(session, requireStr(params, "ref"));
		if (session.propertyInspector !== undefined) {
			await session.propertyInspector.close();
			session.propertyInspector = undefined;
		}

		const inspector = await Inspector.open({
			project: session.project,
			instance,
			info: session.host.info,
			settings: session.host.settings.get(instance.context),
			hostPort: session.host.port,
			width: num(params, "width"),
			height: num(params, "height"),
		});
		session.propertyInspector = inspector;

		const connected = await inspector.waitForConnect(num(params, "timeoutMs") ?? 5_000);
		const hint = connected
			? undefined
			: "The page never called connectElgatoStreamDeckSocket. Check that the property inspector loads its SDPI bundle, and read consoleErrors.";

		return compactJson({
			url: inspector.url,
			context: instance.context,
			action: instance.uuid,
			connected,
			registered: session.host.hasUi(instance.context),
			fields: await inspector.fields(),
			consoleErrors: inspector.consoleLines.filter((line) => line.type === "error").map((line) => line.text),
			pageErrors: inspector.pageErrors,
			hint,
		});
	},

	async piSnapshot({ session }: MethodContext): Promise<JsonValue> {
		return compactJson({ snapshot: await requireInspector(session).snapshot() });
	},

	async piFields({ session }: MethodContext): Promise<JsonValue> {
		return requireInspector(session).fields();
	},

	async piSet({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const inspector = requireInspector(session);
		const applied = await inspector.setField(requireStr(params, "setting"), params.value ?? null);
		await new Promise((done) => setTimeout(done, num(params, "settleMs") ?? 300));
		return compactJson({
			setting: applied.setting,
			value: applied.value,
			settings: session.host.settings.get(inspector.context),
			globalSettings: session.host.settings.getGlobal(),
		});
	},

	async piClick({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const inspector = requireInspector(session);
		await inspector.click(requireStr(params, "target"));
		await new Promise((done) => setTimeout(done, num(params, "settleMs") ?? 300));
		return compactJson({ clicked: requireStr(params, "target"), settings: session.host.settings.get(inspector.context) });
	},

	async piScreenshot({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const inspector = requireInspector(session);
		const stem = str(params, "name") ?? `pi-${inspector.context.slice(0, 8)}`;
		return compactJson({
			png: await inspector.screenshot(session.artifacts, stem, bool(params, "fullPage") ?? true),
			note: "Rendered in headless Chromium; the real property inspector runs in QtWebEngine.",
		});
	},

	piConsole({ session }: MethodContext): JsonValue {
		const inspector = requireInspector(session);
		return compactJson({
			lines: inspector.consoleLines.map((line) => compactJson({ type: line.type, text: line.text })),
			pageErrors: inspector.pageErrors,
		});
	},

	async piClose({ session }: MethodContext): Promise<JsonValue> {
		const inspector = session.propertyInspector;
		if (inspector === undefined) {
			return compactJson({ closed: false });
		}
		const instance = session.host.allActions().find((candidate) => candidate.context === inspector.context);
		await inspector.close();
		session.propertyInspector = undefined;
		if (instance !== undefined) {
			session.host.propertyInspectorDidDisappear(instance);
		}
		return compactJson({ closed: true });
	},

	async checkLifecycle({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const interact = str(params, "interact") ?? "press";
		if (interact !== "press" && interact !== "none") {
			throw new Error('--interact must be "press" or "none"');
		}
		const report = await checkLifecycle(session, {
			uuid: requireStr(params, "uuid"),
			cycles: num(params, "cycles") ?? LIFECYCLE_DEFAULTS.cycles,
			warmup: num(params, "warmup") ?? LIFECYCLE_DEFAULTS.warmup,
			settings: obj(params, "settings") ?? {},
			interact,
			quietMs: num(params, "quietMs") ?? LIFECYCLE_DEFAULTS.quietMs,
			timeoutMs: num(params, "timeoutMs") ?? LIFECYCLE_DEFAULTS.timeoutMs,
			maxBytesPerCycle: num(params, "maxBytesPerCycle") ?? LIFECYCLE_DEFAULTS.maxBytesPerCycle,
			maxHandlesPerCycle: num(params, "maxHandlesPerCycle") ?? LIFECYCLE_DEFAULTS.maxHandlesPerCycle,
			heapSnapshot: bool(params, "heapSnapshot") ?? false,
		});
		return wireJson(parseJsonValue(JSON.stringify(report)));
	},

	events({ session }: MethodContext, params: JsonObject): JsonValue {
		const limit = num(params, "limit") ?? 200;
		const filter: EntryFilter = {};
		const direction = strArray(params, "direction")?.filter((value) => isDirection(value));
		if (direction !== undefined) {
			filter.direction = direction;
		}
		const event = strArray(params, "event");
		if (event !== undefined) {
			filter.event = event;
		}
		const context = str(params, "context");
		if (context !== undefined) {
			filter.context = context;
		}
		const action = str(params, "action");
		if (action !== undefined) {
			filter.action = action;
		}
		const sinceSeq = num(params, "sinceSeq");
		if (sinceSeq !== undefined) {
			filter.sinceSeq = sinceSeq;
		}

		const entries = session.host.recorder.entries(filter);
		return compactJson({
			total: entries.length,
			entries: entries.slice(-limit).map((entry) =>
				compactJson({
					seq: entry.seq,
					at: entry.at,
					direction: entry.direction,
					event: entry.event,
					action: entry.action,
					context: entry.context,
					frame: entry.frame,
				}),
			),
			violations: session.host.recorder.violations(num(params, "sinceSeq") ?? 0).map((violation) =>
				compactJson({
					seq: violation.seq,
					at: violation.at,
					kind: violation.kind,
					message: violation.message,
					context: violation.context,
					action: violation.action,
					detail: violation.detail,
				}),
			),
		});
	},

	violations({ session }: MethodContext, params: JsonObject): JsonValue {
		return session.host.recorder.violations(num(params, "sinceSeq") ?? 0).map((violation) =>
			compactJson({
				seq: violation.seq,
				at: violation.at,
				kind: violation.kind,
				message: violation.message,
				context: violation.context,
				action: violation.action,
				detail: violation.detail,
			}),
		);
	},

	async waitQuiet({ session }: MethodContext, params: JsonObject): Promise<JsonValue> {
		const quietMs = num(params, "quietMs") ?? 500;
		const timeoutMs = num(params, "timeoutMs") ?? 10_000;
		await session.host.recorder.waitForQuiet(quietMs, timeoutMs);
		return compactJson({ quiet: true, seq: session.host.recorder.nextSeq });
	},

	logs({ session }: MethodContext, params: JsonObject): JsonValue {
		const limit = num(params, "limit") ?? 100;
		const sinceStart = bool(params, "sinceStart") ?? true;
		const lines = readPluginLogs(session.project.root, {
			sinceMs: sinceStart ? session.startedAt : undefined,
			level: strArray(params, "level"),
		});
		return compactJson({
			total: lines.length,
			lines: lines.slice(-limit).map((line) =>
				compactJson({
					file: line.file,
					timestamp: line.timestamp,
					level: line.level,
					text: line.text,
				}),
			),
		});
	},

	output({ session }: MethodContext, params: JsonObject): JsonValue {
		const limit = num(params, "limit") ?? 100;
		const exit = session.plugin.exitInfo;
		return compactJson({
			running: session.plugin.running,
			exit:
				exit === undefined
					? null
					: compactJson({
						code: exit.code,
						signal: exit.signal,
					}),
			lines: session.plugin.output.slice(-limit).map((line) =>
				compactJson({
					stream: line.stream,
					at: line.at,
					text: line.text,
				}),
			),
		});
	},
} satisfies { [name: string]: Method };

export function methodFor(name: string): Method | undefined {
	for (const [key, method] of Object.entries(methods)) {
		if (key === name) {
			return method;
		}
	}
	return undefined;
}
