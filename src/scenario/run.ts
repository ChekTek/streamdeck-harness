import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { DaemonClient } from "../cli/client.js";
import { redactJson, redactText, type Secret } from "../daemon/redact.js";
import {
	compactJson,
	errorMessage,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../host/protocol.js";
import type { Expectation, Scenario, ScenarioReport, Step, StepResult } from "./schema.js";

type Aliases = Map<string, string>;

/**
 * Runs a scenario in an open session and returns a report for each step. A failed assertion
 * does not stop the run. `secrets` are the values that the session hides in its replies. An
 * expected value is compared with the same values hidden, and the names and failures of the
 * report do not show them.
 */
export async function runScenario(
	client: DaemonClient,
	scenario: Scenario,
	baseDir = process.cwd(),
	secrets: readonly Secret[] = [],
): Promise<ScenarioReport> {
	const aliases: Aliases = new Map();
	const steps: StepResult[] = [];
	const artifacts: string[] = [];

	for (const [index, step] of scenario.steps.entries()) {
		const name = redactText(step.name ?? describeStep(step), secrets);
		const result: StepResult = { index, name, ok: true, failures: [] };

		try {
			result.result = await runStep(client, step, aliases, artifacts, baseDir);
			if (step.expect !== undefined) {
				result.failures.push(...(await assertExpectation(client, step.expect, aliases, secrets)));
			}
		} catch (cause) {
			result.failures.push(errorMessage(cause));
		}

		result.failures = result.failures.map((failure) => redactText(failure, secrets));
		result.ok = result.failures.length === 0;
		steps.push(result);
	}

	const failures = steps.flatMap((step) =>
		step.failures.map((failure) => `step ${step.index} (${step.name}): ${failure}`),
	);
	return {
		name: redactText(scenario.name ?? "scenario", secrets),
		plugin: scenario.plugin,
		ok: failures.length === 0,
		steps,
		artifacts,
		failures,
	};
}

/** Resolves a scenario path. Paths are relative to the scenario file and can start with `~/`. */
export function resolvePath(value: string, baseDir: string): string {
	if (value.startsWith("~/")) {
		return resolve(process.env.HOME ?? "", value.slice(2));
	}
	return isAbsolute(value) ? value : resolve(baseDir, value);
}

function resolveAlias(aliases: Aliases, ref: string): string {
	return aliases.get(ref) ?? ref;
}

async function callObject(client: DaemonClient, method: string, params: JsonObject = {}): Promise<JsonObject> {
	const result = await client.call(method, params);
	if (!isJsonObject(result)) {
		throw new Error(`${method} returned a non-object result`);
	}
	return result;
}

async function runStep(
	client: DaemonClient,
	step: Step,
	aliases: Aliases,
	artifacts: string[],
	baseDir: string,
): Promise<JsonValue> {
	if (step.add !== undefined) {
		const created = await callObject(
			client,
			"add",
			compactJson({
				uuid: step.add,
				settings: step.settings,
				column: step.column,
				row: step.row,
				state: step.state,
				title: step.title,
			}),
		);
		if (!isJsonString(created.context)) {
			throw new Error("add did not return a context");
		}
		aliases.set(step.as ?? step.add, created.context);
		return created;
	}

	if (step.remove !== undefined) {
		return client.call("remove", compactJson({ ref: resolveAlias(aliases, step.remove) }));
	}
	if (step.appear !== undefined) {
		return client.call("appear", compactJson({ ref: resolveAlias(aliases, step.appear) }));
	}
	if (step.disappear !== undefined) {
		return client.call("disappear", compactJson({ ref: resolveAlias(aliases, step.disappear) }));
	}

	if (step.press !== undefined) {
		return client.call(
			"press",
			compactJson({
				ref: resolveAlias(aliases, step.press),
				holdMs: step.hold,
				settleMs: step.settle,
			}),
		);
	}

	if (step.screenshot !== undefined) {
		const shot = await callObject(
			client,
			"screenshot",
			compactJson({
				ref: resolveAlias(aliases, step.screenshot),
				name: step.shotName,
				size: step.size,
			}),
		);
		if (isJsonString(shot.png)) {
			artifacts.push(shot.png);
		}
		if (isJsonString(shot.svg)) {
			artifacts.push(shot.svg);
		}
		return shot;
	}

	if (step.setSettings !== undefined) {
		if (step.ref === undefined) {
			throw new Error('setSettings needs a "ref" naming the action instance');
		}
		return client.call(
			"setSettings",
			compactJson({ ref: resolveAlias(aliases, step.ref), settings: step.setSettings }),
		);
	}
	if (step.setGlobalSettings !== undefined) {
		return client.call("setGlobalSettings", compactJson({ settings: step.setGlobalSettings }));
	}
	if (step.setSecrets !== undefined) {
		return client.call("setSecrets", compactJson({ secrets: step.setSecrets }));
	}

	if (step.piOpen !== undefined) {
		const opened = await callObject(
			client,
			"piOpen",
			compactJson({ ref: resolveAlias(aliases, step.piOpen), timeoutMs: step.timeout, wait: step.wait }),
		);
		if (opened.connected !== true || (step.wait !== false && opened.ready !== true)) {
			const reason = isJsonString(opened.reason) ? opened.reason : "the page did not become ready";
			const hint = isJsonString(opened.hint) ? ` ${opened.hint}` : "";
			throw new Error(`property inspector is not ready: ${reason}.${hint}`);
		}
		return opened;
	}
	if (step.piSet !== undefined) {
		return client.call(
			"piSet",
			compactJson({
				setting: step.piSet,
				value: step.value,
				settleMs: step.settle,
			}),
		);
	}
	if (step.piType !== undefined) {
		return client.call(
			"piType",
			compactJson({
				setting: step.piType,
				text: step.text,
				clear: step.clear,
				paste: step.paste,
				blur: step.blur,
				settleMs: step.settle,
			}),
		);
	}
	if (step.piClick !== undefined) {
		return client.call(
			"piClick",
			compactJson({
				target: step.piClick,
				settleMs: step.settle,
			}),
		);
	}
	if (step.piVisible !== undefined) {
		return expectVisibility(client, step.piVisible, true);
	}
	if (step.piHidden !== undefined) {
		return expectVisibility(client, step.piHidden, false);
	}
	if (step.piScreenshot !== undefined) {
		const shot = await callObject(client, "piScreenshot", compactJson({ name: step.piScreenshot }));
		if (isJsonString(shot.png)) {
			artifacts.push(shot.png);
		}
		return shot;
	}
	if (step.piClose === true) {
		return client.call("piClose");
	}

	if (step.waitQuiet !== undefined) {
		return client.call("waitQuiet", compactJson({ quietMs: step.waitQuiet }));
	}

	if (step.checkLifecycle !== undefined) {
		const report = await callObject(
			client,
			"checkLifecycle",
			compactJson({
				uuid: step.checkLifecycle,
				cycles: step.cycles,
				warmup: step.warmup,
				settings: step.settings,
				interact: step.interact,
			}),
		);
		if (isJsonString(report.heapSnapshotPath)) {
			artifacts.push(report.heapSnapshotPath);
		}
		const wanted = step.expectVerdict ?? "pass";
		if (report.verdict !== wanted) {
			const reasons = Array.isArray(report.reasons) ? report.reasons.map((reason) => String(reason)) : [];
			throw new Error(
				`lifecycle verdict was "${String(report.verdict)}", expected "${wanted}":\n    ${reasons.join("\n    ")}`,
			);
		}
		return report;
	}

	if (step.lintSvg !== undefined) {
		const { lintPath } = await import("./lint-step.js");
		const report = lintPath(resolvePath(step.lintSvg, baseDir));
		const failed = report.errors > 0 || (step.allowWarnings === false && report.warnings > 0);
		if (failed) {
			throw new Error(
				`${report.errors} SVG error(s) and ${report.warnings} warning(s):\n    ${report.summary.join("\n    ")}`,
			);
		}
		return compactJson({
			errors: report.errors,
			warnings: report.warnings,
			summary: report.summary,
		});
	}

	if (step.expect !== undefined) {
		return null;
	}
	throw new Error(`step has no recognised action: ${JSON.stringify(step)}`);
}

/** Fails when the element of the property inspector is not in the wanted state. An absent element is hidden. */
async function expectVisibility(client: DaemonClient, target: string, wanted: boolean): Promise<JsonValue> {
	const state = await callObject(client, "piVisible", compactJson({ target }));
	if (state.visible !== wanted) {
		const actual = state.found === true ? (state.visible === true ? "shown" : "hidden") : "absent";
		throw new Error(`${JSON.stringify(target)} is ${actual}, expected ${wanted ? "shown" : "hidden"}`);
	}
	return state;
}

async function assertExpectation(
	client: DaemonClient,
	expectation: Expectation,
	aliases: Aliases,
	secrets: readonly Secret[],
): Promise<string[]> {
	const failures: string[] = [];

	if (expectation.key !== undefined) {
		const key = await callObject(client, "key", compactJson({ ref: resolveAlias(aliases, expectation.key) }));
		check(
			failures,
			expectation.state === undefined || key.state === expectation.state,
			`state is ${String(key.state)}, expected ${String(expectation.state)}`,
		);
		const title = expectation.title === undefined ? undefined : redactText(expectation.title, secrets);
		check(
			failures,
			title === undefined || key.title === title,
			`title is ${JSON.stringify(key.title)}, expected ${JSON.stringify(title)}`,
		);
		check(
			failures,
			expectation.titleMatches === undefined || new RegExp(expectation.titleMatches).test(String(key.title)),
			`title ${JSON.stringify(key.title)} does not match /${String(expectation.titleMatches)}/`,
		);
		check(
			failures,
			expectation.visible === undefined || key.visible === expectation.visible,
			`visible is ${String(key.visible)}, expected ${String(expectation.visible)}`,
		);
		check(
			failures,
			expectation.imageSource === undefined || key.imageSource === expectation.imageSource,
			`image came from ${String(key.imageSource)}, expected ${String(expectation.imageSource)}`,
		);
	}

	if (expectation.settingsOf !== undefined && expectation.settingsContain !== undefined) {
		const settings = await callObject(
			client,
			"getSettings",
			compactJson({ ref: resolveAlias(aliases, expectation.settingsOf) }),
		);
		failures.push(...missingEntries(settings, expectation.settingsContain, "settings", secrets));
	}

	if (expectation.globalSettingsContain !== undefined) {
		const global = await callObject(client, "getGlobalSettings");
		failures.push(...missingEntries(global, expectation.globalSettingsContain, "global settings", secrets));
	}

	if (expectation.events !== undefined) {
		for (const wanted of expectation.events) {
			const found = await callObject(
				client,
				"events",
				compactJson({
					event: [wanted.event],
					context: wanted.context === undefined ? undefined : resolveAlias(aliases, wanted.context),
					action: wanted.action,
					limit: 1,
				}),
			);
			const total = isJsonNumber(found.total) ? found.total : 0;
			const min = wanted.min ?? 1;
			check(failures, total >= min, `saw ${total} "${wanted.event}" event(s), expected at least ${min}`);
			check(
				failures,
				wanted.max === undefined || total <= wanted.max,
				`saw ${total} "${wanted.event}" event(s), expected at most ${String(wanted.max)}`,
			);
		}
	}

	if (
		expectation.noViolations === true ||
		expectation.maxViolations !== undefined ||
		expectation.violationKinds !== undefined
	) {
		const allValue = await client.call("violations");
		const all = Array.isArray(allValue) ? allValue.filter((entry) => isJsonObject(entry)) : [];
		const relevant =
			expectation.violationKinds === undefined
				? all
				: all.filter((violation) => {
					const kind = violation.kind;
					return isJsonString(kind) && expectation.violationKinds!.includes(kind);
				});
		const max = expectation.noViolations === true ? 0 : (expectation.maxViolations ?? 0);
		check(
			failures,
			relevant.length <= max,
			`${relevant.length} violation(s), expected at most ${max}:\n    ${relevant
				.slice(0, 5)
				.map((violation) => `${String(violation.kind)}: ${String(violation.message)}`)
				.join("\n    ")}`,
		);
	}

	if (expectation.maxLogErrors !== undefined) {
		const logs = await callObject(client, "logs", compactJson({ level: ["ERROR"], limit: 5 }));
		const total = isJsonNumber(logs.total) ? logs.total : 0;
		const lines = Array.isArray(logs.lines) ? logs.lines : [];
		check(
			failures,
			total <= expectation.maxLogErrors,
			`${total} ERROR line(s) in the plugin log, expected at most ${expectation.maxLogErrors}:\n    ${lines
				.map((line) => (isJsonObject(line) ? String(line.text) : String(line)))
				.join("\n    ")}`,
		);
	}

	return failures;
}

function check(failures: string[], condition: boolean, message: string): void {
	if (!condition) {
		failures.push(message);
	}
}

function missingEntries(actual: JsonObject, wanted: JsonObject, label: string, secrets: readonly Secret[]): string[] {
	return Object.entries(wanted)
		.map(([key, value]) => [redactText(key, secrets), redactJson(value, secrets)] as const)
		.filter(([key, value]) => !isDeepStrictEqual(actual[key], value))
		.map(([key, value]) => `${label}.${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(value)}`);
}

function describeStep(step: Step): string {
	const [action] = Object.entries(step).filter(([key]) => key !== "name" && key !== "expect");
	if (action === undefined) {
		return "expect";
	}
	const value = action[1];
	if (value === true || value === false || value === null) {
		return `${action[0]} ${String(value)}`;
	}
	if (Array.isArray(value)) {
		return action[0];
	}
	if (value !== undefined && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return action[0];
	}
	if (Number.isFinite(value) || value === `${value}`) {
		return `${action[0]} ${String(value)}`;
	}
	return action[0];
}
