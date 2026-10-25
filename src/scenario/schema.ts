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
	assignString(step, value, "name");
	assignString(step, value, "add");
	assignString(step, value, "as");
	assignObject(step, value, "settings");
	assignNumber(step, value, "column");
	assignNumber(step, value, "row");
	assignNumber(step, value, "state");
	assignString(step, value, "title");
	assignString(step, value, "remove");
	assignString(step, value, "appear");
	assignString(step, value, "disappear");
	assignString(step, value, "press");
	assignNumber(step, value, "hold");
	assignNumber(step, value, "settle");
	assignString(step, value, "screenshot");
	assignString(step, value, "shotName");
	assignNumber(step, value, "size");
	assignObject(step, value, "setSettings");
	assignString(step, value, "ref");
	assignObject(step, value, "setGlobalSettings");
	assignObject(step, value, "setSecrets");
	assignString(step, value, "piOpen");
	assignString(step, value, "piSet");
	if ("value" in value) {
		step.value = value.value;
	}
	assignString(step, value, "piClick");
	assignString(step, value, "piScreenshot");
	assignBoolean(step, value, "piClose");
	assignNumber(step, value, "waitQuiet");
	assignString(step, value, "checkLifecycle");
	assignNumber(step, value, "cycles");
	assignNumber(step, value, "warmup");
	assignString(step, value, "lintSvg");
	assignBoolean(step, value, "allowWarnings");

	const interact = value.interact;
	if (interact === "none" || interact === "press") {
		step.interact = interact;
	}
	const expectVerdict = value.expectVerdict;
	if (expectVerdict === "inconclusive" || expectVerdict === "leak" || expectVerdict === "pass") {
		step.expectVerdict = expectVerdict;
	}
	if (isJsonObject(value.expect)) {
		step.expect = parseExpectation(value.expect, `${source}.expect`);
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

function parseExpectation(value: JsonObject, source: string): Expectation {
	const expectation: Expectation = {};
	assignString(expectation, value, "key");
	assignNumber(expectation, value, "state");
	assignString(expectation, value, "title");
	assignString(expectation, value, "titleMatches");
	assignBoolean(expectation, value, "visible");
	const imageSource = value.imageSource;
	if (imageSource === "manifest" || imageSource === "none" || imageSource === "setImage") {
		expectation.imageSource = imageSource;
	}
	assignString(expectation, value, "settingsOf");
	assignObject(expectation, value, "settingsContain");
	assignObject(expectation, value, "globalSettingsContain");
	assignBoolean(expectation, value, "noViolations");
	assignNumber(expectation, value, "maxViolations");
	assignNumber(expectation, value, "maxLogErrors");

	const kinds = value.violationKinds;
	if (Array.isArray(kinds)) {
		expectation.violationKinds = kinds.filter((entry) => isJsonString(entry));
	}

	const events = value.events;
	if (Array.isArray(events)) {
		expectation.events = events.flatMap((entry, index) => {
			if (!isJsonObject(entry) || !isJsonString(entry.event)) {
				throw new Error(`${source}.events[${index}]: expected { event }`);
			}
			const item: ExpectedEvent = {
				event: entry.event,
			};
			if (isJsonString(entry.context)) {
				item.context = entry.context;
			}
			if (isJsonString(entry.action)) {
				item.action = entry.action;
			}
			if (isJsonNumber(entry.min)) {
				item.min = entry.min;
			}
			if (isJsonNumber(entry.max)) {
				item.max = entry.max;
			}
			return [item];
		});
	}

	return expectation;
}

function assignString<K extends string>(target: Partial<Record<K, string>>, source: JsonObject, key: K): void {
	const value = source[key];
	if (isJsonString(value)) {
		target[key] = value;
	}
}

function assignNumber<K extends string>(target: Partial<Record<K, number>>, source: JsonObject, key: K): void {
	const value = source[key];
	if (isJsonNumber(value)) {
		target[key] = value;
	}
}

function assignBoolean<K extends string>(target: Partial<Record<K, boolean>>, source: JsonObject, key: K): void {
	const value = source[key];
	if (isJsonBoolean(value)) {
		target[key] = value;
	}
}

function assignObject<K extends string>(target: Partial<Record<K, JsonObject>>, source: JsonObject, key: K): void {
	const value = source[key];
	if (isJsonObject(value)) {
		target[key] = value;
	}
}
