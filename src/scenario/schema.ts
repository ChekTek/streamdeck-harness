/**
 * Declarative scenario format. One file describes a whole check -- launch, place actions,
 * interact, assert -- so an agent can run it with a single call instead of thirty round trips.
 */

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
	settingsContain?: Record<string, unknown>;
	globalSettingsContain?: Record<string, unknown>;

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
	settings?: Record<string, unknown>;
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

	setSettings?: Record<string, unknown>;
	ref?: string;
	setGlobalSettings?: Record<string, unknown>;
	setSecrets?: Record<string, unknown>;

	piOpen?: string;
	piSet?: string;
	value?: unknown;
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
	globalSettings?: Record<string, unknown>;
	steps: Step[];
};

export type StepResult = {
	index: number;
	name: string;
	ok: boolean;
	failures: string[];
	result?: unknown;
};

export type ScenarioReport = {
	name: string;
	plugin: string;
	ok: boolean;
	steps: StepResult[];
	artifacts: string[];
	failures: string[];
};

export function parseScenario(value: unknown, source: string): Scenario {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${source}: expected a mapping at the top level`);
	}
	const scenario = value as Partial<Scenario>;

	if (typeof scenario.plugin !== "string" || scenario.plugin.length === 0) {
		throw new Error(`${source}: missing "plugin" (path to the plugin or its .sdPlugin folder)`);
	}
	if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
		throw new Error(`${source}: missing "steps" (a non-empty list)`);
	}
	return scenario as Scenario;
}
