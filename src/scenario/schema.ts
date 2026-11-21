/**
 * Declarative scenario format. One file describes a whole check -- launch, place actions,
 * interact, assert -- so an agent can run it with a single call instead of thirty round trips.
 */

import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../host/protocol.js";

export type Expectation = {
	/** Assert on a key's current visual state. */
	key?: string;
	state?: number;
	title?: string;
	titleMatches?: string;
	visible?: boolean;
	imageSource?: "manifest" | "none" | "setImage";

	/** Assert that an action's settings contain these entries. */
	settingsOf?: string;
	settingsContain?: JsonObject;
	globalSettingsContain?: JsonObject;

	/** Assert on the recorded transcript. */
	events?: Array<{ event: string; context?: string; action?: string; min?: number; max?: number }>;

	/** Assert on harness-detected violations. */
	noViolations?: boolean;
	maxViolations?: number;
	violationKinds?: string[];

	/** Assert on the plugin's own log files. */
	maxLogErrors?: number;
};

export type Step = {
	/** Optional label used in the report. */
	name?: string;

	add?: string;
	as?: string;
	settings?: JsonObject;
	column?: number;
	row?: number;
	state?: number;
	title?: string;

	remove?: string;
	appear?: string;
	disappear?: string;

	press?: string;
	hold?: number;
	settle?: number;

	screenshot?: string;
	shotName?: string;
	size?: number;

	setSettings?: JsonObject;
	ref?: string;
	setGlobalSettings?: JsonObject;
	setSecrets?: JsonObject;

	piOpen?: string;
	piSet?: string;
	value?: JsonValue;
	piClick?: string;
	piScreenshot?: string;
	piClose?: boolean;

	waitQuiet?: number;

	checkLifecycle?: string;
	cycles?: number;
	warmup?: number;
	interact?: "none" | "press";
	expectVerdict?: "inconclusive" | "leak" | "pass";

	lintSvg?: string;
	allowWarnings?: boolean;

	expect?: Expectation;
};

export type Scenario = {
	name?: string;
	plugin: string;
	device?: string[] | string;
	node?: string;
	globalSettings?: JsonObject;
	steps: Step[];
};

export type StepResult = {
	index: number;
	name: string;
	ok: boolean;
	failures: string[];
	result?: JsonValue;
};

export type ScenarioReport = {
	name: string;
	plugin: string;
	ok: boolean;
	steps: StepResult[];
	artifacts: string[];
	failures: string[];
};

export function parseScenario(value: JsonValue, source: string): Scenario {
	if (!isJsonObject(value)) {
		throw new Error(`${source}: expected a mapping at the top level`);
	}

	const plugin = value.plugin;
	if (!isJsonString(plugin) || plugin.length === 0) {
		throw new Error(`${source}: missing "plugin" (path to the plugin or its .sdPlugin folder)`);
	}

	const stepsValue = value.steps;
	if (!Array.isArray(stepsValue) || stepsValue.length === 0) {
		throw new Error(`${source}: missing "steps" (a non-empty list)`);
	}

	const scenario: Scenario = {
		plugin,
		steps: stepsValue.map((step, index) => parseStep(step, `${source} steps[${index}]`)),
	};
	if (isJsonString(value.name)) {
		scenario.name = value.name;
	}
	if (isJsonString(value.node)) {
		scenario.node = value.node;
	}
	if (isJsonObject(value.globalSettings)) {
		scenario.globalSettings = value.globalSettings;
	}

	const device = value.device;
	if (isJsonString(device)) {
		scenario.device = device;
	} else if (Array.isArray(device)) {
		scenario.device = device.filter((entry) => isJsonString(entry));
	}

	return scenario;
}

function parseStep(value: JsonValue, source: string): Step {
	if (!isJsonObject(value)) {
		throw new Error(`${source}: expected a mapping`);
	}

	const step: Step = {};
	assignString(step, value, "name", source);
	assignString(step, value, "add", source);
	assignString(step, value, "as", source);
	assignObject(step, value, "settings", source);
	assignNumber(step, value, "column", source);
	assignNumber(step, value, "row", source);
	assignNumber(step, value, "state", source);
	assignString(step, value, "title", source);
	assignString(step, value, "remove", source);
	assignString(step, value, "appear", source);
	assignString(step, value, "disappear", source);
	assignString(step, value, "press", source);
	assignNumber(step, value, "hold", source);
	assignNumber(step, value, "settle", source);
	assignString(step, value, "screenshot", source);
	assignString(step, value, "shotName", source);
	assignNumber(step, value, "size", source);
	assignObject(step, value, "setSettings", source);
	assignString(step, value, "ref", source);
	assignObject(step, value, "setGlobalSettings", source);
	assignObject(step, value, "setSecrets", source);
	assignString(step, value, "piOpen", source);
	assignString(step, value, "piSet", source);
	if ("value" in value) {
		step.value = value.value;
	}
	assignString(step, value, "piClick", source);
	assignString(step, value, "piScreenshot", source);
	assignBoolean(step, value, "piClose", source);
	assignNumber(step, value, "waitQuiet", source);
	assignString(step, value, "checkLifecycle", source);
	assignNumber(step, value, "cycles", source);
	assignNumber(step, value, "warmup", source);
	assignString(step, value, "lintSvg", source);
	assignBoolean(step, value, "allowWarnings", source);

	const interact = value.interact;
	if (interact === "none" || interact === "press") {
		step.interact = interact;
	} else if (interact !== undefined) {
		throw new Error(`${source}.interact: expected "none" or "press"`);
	}
	const expectVerdict = value.expectVerdict;
	if (expectVerdict === "inconclusive" || expectVerdict === "leak" || expectVerdict === "pass") {
		step.expectVerdict = expectVerdict;
	} else if (expectVerdict !== undefined) {
		throw new Error(`${source}.expectVerdict: expected "pass", "leak", or "inconclusive"`);
	}
	if (isJsonObject(value.expect)) {
		step.expect = parseExpectation(value.expect, `${source}.expect`);
	} else if (value.expect !== undefined) {
		throw new Error(`${source}.expect: expected a mapping`);
	}
	return step;
}

type ExpectedEvent = {
	event: string;
	context?: string;
	action?: string;
	min?: number;
	max?: number;
};

const EXPECTATION_KEYS = [
	"key",
	"state",
	"title",
	"titleMatches",
	"visible",
	"imageSource",
	"settingsOf",
	"settingsContain",
	"globalSettingsContain",
	"events",
	"noViolations",
	"maxViolations",
	"violationKinds",
	"maxLogErrors",
] as const satisfies Array<keyof Expectation>;

const KEY_ASSERTIONS = ["state", "title", "titleMatches", "visible", "imageSource"] as const;

const EXPECTED_EVENT_KEYS = ["event", "context", "action", "min", "max"] as const satisfies Array<keyof ExpectedEvent>;

/**
 * Parses an `expect` block strictly: an unknown key, a wrong value type, or an assertion
 * missing the field that names its target is an error, because silently dropping it would
 * turn the intended assertion into a pass.
 */
function parseExpectation(value: JsonObject, source: string): Expectation {
	rejectUnknownKeys(value, EXPECTATION_KEYS, source);

	const expectation: Expectation = {};
	assignString(expectation, value, "key", source);
	assignNumber(expectation, value, "state", source);
	assignString(expectation, value, "title", source);
	assignString(expectation, value, "titleMatches", source);
	assignBoolean(expectation, value, "visible", source);
	const imageSource = value.imageSource;
	if (imageSource === "manifest" || imageSource === "none" || imageSource === "setImage") {
		expectation.imageSource = imageSource;
	} else if (imageSource !== undefined) {
		throw new Error(`${source}.imageSource: expected "manifest", "setImage", or "none"`);
	}
	assignString(expectation, value, "settingsOf", source);
	assignObject(expectation, value, "settingsContain", source);
	assignObject(expectation, value, "globalSettingsContain", source);
	assignBoolean(expectation, value, "noViolations", source);
	assignNumber(expectation, value, "maxViolations", source);
	assignNumber(expectation, value, "maxLogErrors", source);

	const orphan = KEY_ASSERTIONS.find((name) => value[name] !== undefined);
	if (expectation.key === undefined && orphan !== undefined) {
		throw new Error(`${source}.${orphan}: needs "key" naming the action instance to check`);
	}
	if ((expectation.settingsOf === undefined) !== (expectation.settingsContain === undefined)) {
		throw new Error(`${source}: "settingsOf" and "settingsContain" must be used together`);
	}

	const kinds = value.violationKinds;
	if (kinds !== undefined) {
		if (!Array.isArray(kinds) || !kinds.every((entry) => isJsonString(entry))) {
			throw new Error(`${source}.violationKinds: expected a list of strings`);
		}
		expectation.violationKinds = kinds.filter((entry) => isJsonString(entry));
	}

	const events = value.events;
	if (events !== undefined) {
		if (!Array.isArray(events)) {
			throw new Error(`${source}.events: expected a list`);
		}
		expectation.events = events.map((entry, index) => {
			const where = `${source}.events[${index}]`;
			if (!isJsonObject(entry) || !isJsonString(entry.event)) {
				throw new Error(`${where}: expected { event }`);
			}
			rejectUnknownKeys(entry, EXPECTED_EVENT_KEYS, where);
			const item: ExpectedEvent = {
				event: entry.event,
			};
			assignString(item, entry, "context", where);
			assignString(item, entry, "action", where);
			assignNumber(item, entry, "min", where);
			assignNumber(item, entry, "max", where);
			return item;
		});
	}

	return expectation;
}

function rejectUnknownKeys(value: JsonObject, known: readonly string[], where: string): void {
	const unknown = Object.keys(value).find((key) => !known.includes(key));
	if (unknown !== undefined) {
		throw new Error(`${where}.${unknown}: unknown key. Known keys: ${known.join(", ")}`);
	}
}

function assignString<K extends string>(
	target: Partial<Record<K, string>>,
	source: JsonObject,
	key: K,
	where: string,
): void {
	const value = source[key];
	if (value === undefined) {
		return;
	}
	if (!isJsonString(value)) {
		throw new Error(`${where}.${key}: expected a string`);
	}
	target[key] = value;
}

function assignNumber<K extends string>(
	target: Partial<Record<K, number>>,
	source: JsonObject,
	key: K,
	where: string,
): void {
	const value = source[key];
	if (value === undefined) {
		return;
	}
	if (!isJsonNumber(value)) {
		throw new Error(`${where}.${key}: expected a number`);
	}
	target[key] = value;
}

function assignBoolean<K extends string>(
	target: Partial<Record<K, boolean>>,
	source: JsonObject,
	key: K,
	where: string,
): void {
	const value = source[key];
	if (value === undefined) {
		return;
	}
	if (!isJsonBoolean(value)) {
		throw new Error(`${where}.${key}: expected true or false`);
	}
	target[key] = value;
}

function assignObject<K extends string>(
	target: Partial<Record<K, JsonObject>>,
	source: JsonObject,
	key: K,
	where: string,
): void {
	const value = source[key];
	if (value === undefined) {
		return;
	}
	if (!isJsonObject(value)) {
		throw new Error(`${where}.${key}: expected a mapping`);
	}
	target[key] = value;
}
