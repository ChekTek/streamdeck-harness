import { isAbsolute, resolve } from "node:path";

import type { DaemonClient } from "../cli/client.js";
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
 * Executes a scenario against an already-running session, collecting a per-step report.
 * Steps run in order; a failed assertion is recorded and the run continues, so one report
 * shows everything that is wrong rather than only the first problem.
 */
export async function runScenario(
	client: DaemonClient,
	scenario: Scenario,
	baseDir = process.cwd(),
): Promise<ScenarioReport> {
	const aliases: Aliases = new Map();
	const steps: StepResult[] = [];
	const artifacts: string[] = [];

	if (scenario.globalSettings !== undefined) {
		await client.call("setGlobalSettings", compactJson({ settings: scenario.globalSettings }));
	}

	for (const [index, step] of scenario.steps.entries()) {
		const result: StepResult = { index, name: step.name ?? describeStep(step), ok: true, failures: [] };

		try {
			result.result = await runStep(client, step, aliases, artifacts, baseDir);
			if (step.expect !== undefined) {
				result.failures.push(...(await assertExpectation(client, step.expect, aliases)));
			}
		} catch (cause) {
			result.failures.push(errorMessage(cause));
		}

		result.ok = result.failures.length === 0;
		steps.push(result);
	}

	const failures = steps.flatMap((step) =>
		step.failures.map((failure) => `step ${step.index} (${step.name}): ${failure}`),
	);
	return {
		name: scenario.name ?? "scenario",
		plugin: scenario.plugin,
		ok: failures.length === 0,
		steps,
		artifacts,
		failures,
	};
}

/** Paths in a scenario are relative to the scenario file, and may start with `~/`. */
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
		const opened = await callObject(client, "piOpen", compactJson({ ref: resolveAlias(aliases, step.piOpen) }));
		if (opened.connected !== true) {
			throw new Error(`property inspector never connected. ${isJsonString(opened.hint) ? opened.hint : ""}`.trim());
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
	if (step.piClick !== undefined) {
		return client.call(
			"piClick",
			compactJson({
				target: step.piClick,
				settleMs: step.settle,
			}),
		);
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

async function assertExpectation(client: DaemonClient, expectation: Expectation, aliases: Aliases): Promise<string[]> {
	const failures: string[] = [];

	if (expectation.key !== undefined) {
		const key = await callObject(client, "key", compactJson({ ref: resolveAlias(aliases, expectation.key) }));
		check(
			failures,
			expectation.state === undefined || key.state === expectation.state,
			`state is ${String(key.state)}, expected ${String(expectation.state)}`,
		);
		check(
			failures,
			expectation.title === undefined || key.title === expectation.title,
			`title is ${JSON.stringify(key.title)}, expected ${JSON.stringify(expectation.title)}`,
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
		failures.push(...missingEntries(settings, expectation.settingsContain, "settings"));
	}

	if (expectation.globalSettingsContain !== undefined) {
		const global = await callObject(client, "getGlobalSettings");
		failures.push(...missingEntries(global, expectation.globalSettingsContain, "global settings"));
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

function missingEntries(actual: JsonObject, wanted: JsonObject, label: string): string[] {
	return Object.entries(wanted)
		.filter(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))
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
