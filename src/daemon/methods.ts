import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkLifecycle, LIFECYCLE_DEFAULTS } from "../checks/lifecycle.js";
import type { ActionInstance } from "../host/action.js";
import type { JsonObject } from "../host/protocol.js";
import type { Direction } from "../host/recorder.js";
import { Inspector } from "../pi/inspector.js";
import { readPluginLogs } from "../plugin/logs.js";
import { getBrowser } from "../render/chromium.js";
import { keyHtml, resolveKeyImage } from "../render/key.js";
import type { Session } from "./session.js";

export type MethodContext = {
	session: Session;
	shutdown: (reason: string) => Promise<void>;
};

export type Method = (context: MethodContext, params: Record<string, unknown>) => Promise<unknown> | unknown;

// ------------------------------------------------------------------ param helpers

function str(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function requireStr(params: Record<string, unknown>, key: string): string {
	const value = str(params, key);
	if (value === undefined) {
		throw new Error(`missing required parameter "${key}"`);
	}
	return value;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
	const value = params[key];
	return typeof value === "number" ? value : undefined;
}

function bool(params: Record<string, unknown>, key: string): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

function obj(params: Record<string, unknown>, key: string): JsonObject | undefined {
	const value = params[key];
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function strArray(params: Record<string, unknown>, key: string): string[] | undefined {
	const value = params[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
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
	return {
		context: instance.context,
		action: instance.uuid,
		name: instance.definition.Name,
		device: instance.device.id,
		controller: instance.controller,
		coordinates: instance.coordinates ?? null,
		visible: instance.visible,
		state: instance.state,
		stateCount: instance.stateCount,
		title: instance.effectiveTitle,
		titleParameters: instance.titleParameters as unknown as JsonObject[string],
		imageSource: override === undefined ? "manifest" : "setImage",
		manifestImage: instance.manifestState?.Image ?? null,
		settings: session.host.settings.get(instance.context),
		resources: session.host.settings.getResources(instance.context),
		hasPropertyInspector: session.host.hasUi(instance.context),
		flashes: instance.flashes as unknown as JsonObject[string],
	};
}

// ------------------------------------------------------------------ methods

export const methods: Record<string, Method> = {
	info({ session }) {
		return session.describe();
	},

	close({ shutdown }) {
		// Reply first: the shutdown tears down the very connection carrying this response.
		setTimeout(() => void shutdown("requested"), 0);
		return { closed: true };
	},

	actions({ session }) {
		return session.host.allActions().map((instance) => describeInstance(session, instance));
	},

	add({ session }, params) {
		const column = num(params, "column");
		const row = num(params, "row");
		const deviceId = str(params, "device");
		const device =
			deviceId === undefined ? undefined : session.host.devices.find((candidate) => candidate.id === deviceId);
		if (deviceId !== undefined && device === undefined) {
			throw new Error(`no emulated device with id ${deviceId}`);
		}

		const controller = str(params, "controller");
		const instance = session.host.addAction({
			uuid: requireStr(params, "uuid"),
			...(device === undefined ? {} : { device }),
			...(column === undefined || row === undefined ? {} : { coordinates: { column, row } }),
			...(controller === "Keypad" || controller === "Encoder" ? { controller } : {}),
			...(obj(params, "settings") === undefined ? {} : { settings: obj(params, "settings")! }),
			...(num(params, "state") === undefined ? {} : { state: num(params, "state")! }),
			...(str(params, "title") === undefined ? {} : { title: str(params, "title")! }),
			...(bool(params, "multiAction") === undefined ? {} : { isInMultiAction: bool(params, "multiAction")! }),
			...(bool(params, "appear") === undefined ? {} : { appear: bool(params, "appear")! }),
		});
		return describeInstance(session, instance);
	},

	remove({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.removeAction(instance);
		return { removed: instance.context, action: instance.uuid };
	},

	appear({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.appear(instance);
		return describeInstance(session, instance);
	},

	disappear({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.disappear(instance);
		return { context: instance.context, visible: instance.visible };
	},

	async press({ session }, params) {
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

	keyDown({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.keyDown(instance, num(params, "userDesiredState"));
		return { context: instance.context };
	},

	keyUp({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		session.host.keyUp(instance, num(params, "userDesiredState"));
		return { context: instance.context };
	},

	key({ session }, params) {
		return describeInstance(session, resolve(session, requireStr(params, "ref")));
	},

	/**
	 * Renders the key as Stream Deck would show it and writes a PNG. The SVG source and its
	 * Tiny 1.2 lint come back alongside -- reading those is cheaper than reading the image.
	 */
	async screenshot({ session }, params) {
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

		return {
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
					: { errors: image.lint.errors, warnings: image.lint.warnings, findings: image.lint.findings },
			note: "Rendered in headless Chromium, which is more permissive than Stream Deck's Qt renderer. Trust the lint over the picture.",
		};
	},

	getSettings({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		return session.host.settings.get(instance.context);
	},

	setSettings({ session }, params) {
		const instance = resolve(session, requireStr(params, "ref"));
		const settings = obj(params, "settings");
		if (settings === undefined) {
			throw new Error('missing required parameter "settings" (a JSON object)');
		}
		session.host.pushSettings(instance, settings);
		return session.host.settings.get(instance.context);
	},

	getGlobalSettings({ session }) {
		return session.host.settings.getGlobal();
	},

	setGlobalSettings({ session }, params) {
		const settings = obj(params, "settings");
		if (settings === undefined) {
			throw new Error('missing required parameter "settings" (a JSON object)');
		}
		session.host.pushGlobalSettings(settings);
		return session.host.settings.getGlobal();
	},

	setSecrets({ session }, params) {
		const secrets = obj(params, "secrets");
		if (secrets === undefined) {
			throw new Error('missing required parameter "secrets" (a JSON object)');
		}
		session.host.pushSecrets(secrets);
		return { secrets: Object.keys(secrets) };
	},

	async piOpen({ session }, params) {
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
			...(num(params, "width") === undefined ? {} : { width: num(params, "width")! }),
			...(num(params, "height") === undefined ? {} : { height: num(params, "height")! }),
		});
		session.propertyInspector = inspector;

		const connected = await inspector.waitForConnect(num(params, "timeoutMs") ?? 5_000);
		const hint = connected
			? undefined
			: "The page never called connectElgatoStreamDeckSocket. Check that the property inspector loads its SDPI bundle, and read consoleErrors.";

		return {
			url: inspector.url,
			context: instance.context,
			action: instance.uuid,
			connected,
			registered: session.host.hasUi(instance.context),
			fields: await inspector.fields(),
			consoleErrors: inspector.consoleLines.filter((line) => line.type === "error").map((line) => line.text),
			pageErrors: inspector.pageErrors,
			...(hint === undefined ? {} : { hint }),
		};
	},

	async piSnapshot({ session }) {
		return { snapshot: await requireInspector(session).snapshot() };
	},

	async piFields({ session }) {
		return requireInspector(session).fields();
	},

	async piSet({ session }, params) {
		const inspector = requireInspector(session);
		const applied = await inspector.setField(requireStr(params, "setting"), params.value);
		// Give the component time to round-trip its setSettings through the host.
		await new Promise((done) => setTimeout(done, num(params, "settleMs") ?? 300));
		return {
			...applied,
			settings: session.host.settings.get(inspector.context),
			globalSettings: session.host.settings.getGlobal(),
		};
	},

	async piClick({ session }, params) {
		const inspector = requireInspector(session);
		await inspector.click(requireStr(params, "target"));
		await new Promise((done) => setTimeout(done, num(params, "settleMs") ?? 300));
		return { clicked: requireStr(params, "target"), settings: session.host.settings.get(inspector.context) };
	},

	async piScreenshot({ session }, params) {
		const inspector = requireInspector(session);
		const stem = str(params, "name") ?? `pi-${inspector.context.slice(0, 8)}`;
		return {
			png: await inspector.screenshot(session.artifacts, stem, bool(params, "fullPage") ?? true),
			note: "Rendered in headless Chromium; the real property inspector runs in QtWebEngine.",
		};
	},

	piConsole({ session }) {
		const inspector = requireInspector(session);
		return { lines: inspector.consoleLines, pageErrors: inspector.pageErrors };
	},

	async piClose({ session }) {
		const inspector = session.propertyInspector;
		if (inspector === undefined) {
			return { closed: false };
		}
		const instance = session.host.allActions().find((candidate) => candidate.context === inspector.context);
		await inspector.close();
		session.propertyInspector = undefined;
		if (instance !== undefined) {
			session.host.propertyInspectorDidDisappear(instance);
		}
		return { closed: true };
	},

	async checkLifecycle({ session }, params) {
		const interact = str(params, "interact") ?? "press";
		if (interact !== "press" && interact !== "none") {
			throw new Error('--interact must be "press" or "none"');
		}
		return checkLifecycle(session, {
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
	},

	events({ session }, params) {
		const limit = num(params, "limit") ?? 200;
		const entries = session.host.recorder.entries({
			...(strArray(params, "direction") === undefined
				? {}
				: { direction: strArray(params, "direction") as Direction[] }),
			...(strArray(params, "event") === undefined ? {} : { event: strArray(params, "event")! }),
			...(str(params, "context") === undefined ? {} : { context: str(params, "context")! }),
			...(str(params, "action") === undefined ? {} : { action: str(params, "action")! }),
			...(num(params, "sinceSeq") === undefined ? {} : { sinceSeq: num(params, "sinceSeq")! }),
		});

		return {
			total: entries.length,
			entries: entries.slice(-limit),
			violations: session.host.recorder.violations(num(params, "sinceSeq") ?? 0),
		};
	},

	violations({ session }, params) {
		return session.host.recorder.violations(num(params, "sinceSeq") ?? 0);
	},

	async waitQuiet({ session }, params) {
		const quietMs = num(params, "quietMs") ?? 500;
		const timeoutMs = num(params, "timeoutMs") ?? 10_000;
		await session.host.recorder.waitForQuiet(quietMs, timeoutMs);
		return { quiet: true, seq: session.host.recorder.nextSeq };
	},

	logs({ session }, params) {
		const limit = num(params, "limit") ?? 100;
		const sinceStart = bool(params, "sinceStart") ?? true;
		const lines = readPluginLogs(session.project.root, {
			...(sinceStart ? { sinceMs: session.startedAt } : {}),
			...(strArray(params, "level") === undefined ? {} : { level: strArray(params, "level")! }),
		});
		return { total: lines.length, lines: lines.slice(-limit) };
	},

	output({ session }, params) {
		const limit = num(params, "limit") ?? 100;
		return {
			running: session.plugin.running,
			exit: session.plugin.exitInfo ?? null,
			lines: session.plugin.output.slice(-limit),
		};
	},
};
