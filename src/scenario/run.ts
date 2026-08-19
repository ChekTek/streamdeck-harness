import { isAbsolute, resolve } from "node:path";

import type { DaemonClient } from "../cli/client.js";
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
		await client.call("setGlobalSettings", { settings: scenario.globalSettings });
	}

	for (const [index, step] of scenario.steps.entries()) {
		const result: StepResult = { index, name: step.name ?? describeStep(step), ok: true, failures: [] };

		try {
			result.result = await runStep(client, step, aliases, artifacts, baseDir);
			if (step.expect !== undefined) {
				result.failures.push(...(await assertExpectation(client, step.expect, aliases)));
			}
		} catch (cause) {
			result.failures.push((cause as Error).message);
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

async function runStep(
	client: DaemonClient,
	step: Step,
	aliases: Aliases,
	artifacts: string[],
	baseDir: string,
): Promise<unknown> {
	if (step.add !== undefined) {
		const created = await client.call<{ context: string }>("add", {
			uuid: step.add,
			...(step.settings === undefined ? {} : { settings: step.settings }),
			...(step.column === undefined ? {} : { column: step.column }),
			...(step.row === undefined ? {} : { row: step.row }),
			...(step.state === undefined ? {} : { state: step.state }),
			...(step.title === undefined ? {} : { title: step.title }),
		});
		aliases.set(step.as ?? step.add, created.context);
		return created;
	}

	if (step.remove !== undefined) {
		return client.call("remove", { ref: resolveAlias(aliases, step.remove) });
	}
	if (step.appear !== undefined) {
		return client.call("appear", { ref: resolveAlias(aliases, step.appear) });
	}
	if (step.disappear !== undefined) {
		return client.call("disappear", { ref: resolveAlias(aliases, step.disappear) });
	}

	if (step.press !== undefined) {
		return client.call("press", {
			ref: resolveAlias(aliases, step.press),
			...(step.hold === undefined ? {} : { holdMs: step.hold }),
			...(step.settle === undefined ? {} : { settleMs: step.settle }),
		});
	}

	if (step.screenshot !== undefined) {
		const shot = await client.call<{ png: string; svg: string | null; lint: { errors: number } | null }>("screenshot", {
			ref: resolveAlias(aliases, step.screenshot),
			...(step.shotName === undefined ? {} : { name: step.shotName }),
			...(step.size === undefined ? {} : { size: step.size }),
		});
		artifacts.push(shot.png);
		if (shot.svg !== null) {
			artifacts.push(shot.svg);
		}
		return shot;
	}

	if (step.setSettings !== undefined) {
		if (step.ref === undefined) {
			throw new Error('setSettings needs a "ref" naming the action instance');
		}
		return client.call("setSettings", { ref: resolveAlias(aliases, step.ref), settings: step.setSettings });
	}
	if (step.setGlobalSettings !== undefined) {
		return client.call("setGlobalSettings", { settings: step.setGlobalSettings });
	}
	if (step.setSecrets !== undefined) {
		return client.call("setSecrets", { secrets: step.setSecrets });
	}

	if (step.piOpen !== undefined) {
		const opened = await client.call<{ connected: boolean; hint?: string }>("piOpen", {
			ref: resolveAlias(aliases, step.piOpen),
		});
		if (!opened.connected) {
			throw new Error(`property inspector never connected. ${opened.hint ?? ""}`.trim());
		}
		return opened;
	}
	if (step.piSet !== undefined) {
		return client.call("piSet", {
			setting: step.piSet,
			value: step.value,
			...(step.settle === undefined ? {} : { settleMs: step.settle }),
		});
	}
	if (step.piClick !== undefined) {
		return client.call("piClick", {
			target: step.piClick,
			...(step.settle === undefined ? {} : { settleMs: step.settle }),
		});
	}
	if (step.piScreenshot !== undefined) {
		const shot = await client.call<{ png: string }>("piScreenshot", { name: step.piScreenshot });
		artifacts.push(shot.png);
		return shot;
	}
	if (step.piClose === true) {
		return client.call("piClose");
	}

	if (step.waitQuiet !== undefined) {
		return client.call("waitQuiet", { quietMs: step.waitQuiet });
	}

	if (step.checkLifecycle !== undefined) {
		const report = await client.call<{ verdict: string; reasons: string[]; heapSnapshotPath?: string }>(
			"checkLifecycle",
			{
				uuid: step.checkLifecycle,
				...(step.cycles === undefined ? {} : { cycles: step.cycles }),
				...(step.warmup === undefined ? {} : { warmup: step.warmup }),
				...(step.settings === undefined ? {} : { settings: step.settings }),
				...(step.interact === undefined ? {} : { interact: step.interact }),
			},
		);
		if (report.heapSnapshotPath !== undefined) {
			artifacts.push(report.heapSnapshotPath);
		}
		const wanted = step.expectVerdict ?? "pass";
		if (report.verdict !== wanted) {
			throw new Error(
				`lifecycle verdict was "${report.verdict}", expected "${wanted}":\n    ${report.reasons.join("\n    ")}`,
			);
		}
		return report;
	}

	if (step.lintSvg !== undefined) {
		// Linting is static, so it is done in-process rather than over the session.
		const { lintPath } = await import("./lint-step.js");
		const report = lintPath(resolvePath(step.lintSvg, baseDir));
		const failed = report.errors > 0 || (step.allowWarnings === false && report.warnings > 0);
		if (failed) {
			throw new Error(
				`${report.errors} SVG error(s) and ${report.warnings} warning(s):\n    ${report.summary.join("\n    ")}`,
			);
		}
		return report;
	}

	if (step.expect !== undefined) {
		return undefined;
	}
	throw new Error(`step has no recognised action: ${JSON.stringify(step)}`);
}

async function assertExpectation(client: DaemonClient, expectation: Expectation, aliases: Aliases): Promise<string[]> {
	const failures: string[] = [];

	if (expectation.key !== undefined) {
		const key = await client.call<Record<string, unknown>>("key", { ref: resolveAlias(aliases, expectation.key) });
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
		const settings = await client.call<Record<string, unknown>>("getSettings", {
			ref: resolveAlias(aliases, expectation.settingsOf),
		});
		failures.push(...missingEntries(settings, expectation.settingsContain, "settings"));
	}

	if (expectation.globalSettingsContain !== undefined) {
		const global = await client.call<Record<string, unknown>>("getGlobalSettings");
		failures.push(...missingEntries(global, expectation.globalSettingsContain, "global settings"));
	}

	if (expectation.events !== undefined) {
		for (const wanted of expectation.events) {
			const found = await client.call<{ total: number }>("events", {
				event: [wanted.event],
				...(wanted.context === undefined ? {} : { context: resolveAlias(aliases, wanted.context) }),
				...(wanted.action === undefined ? {} : { action: wanted.action }),
				limit: 1,
			});
			const min = wanted.min ?? 1;
			check(failures, found.total >= min, `saw ${found.total} "${wanted.event}" event(s), expected at least ${min}`);
			check(
				failures,
				wanted.max === undefined || found.total <= wanted.max,
				`saw ${found.total} "${wanted.event}" event(s), expected at most ${String(wanted.max)}`,
			);
		}
	}

	if (
		expectation.noViolations === true ||
		expectation.maxViolations !== undefined ||
		expectation.violationKinds !== undefined
	) {
		const all = await client.call<Array<{ kind: string; message: string }>>("violations");
		const relevant =
			expectation.violationKinds === undefined
				? all
				: all.filter((violation) => expectation.violationKinds!.includes(violation.kind));
		const max = expectation.noViolations === true ? 0 : (expectation.maxViolations ?? 0);
		check(
			failures,
			relevant.length <= max,
			`${relevant.length} violation(s), expected at most ${max}:\n    ${relevant
				.slice(0, 5)
				.map((v) => `${v.kind}: ${v.message}`)
				.join("\n    ")}`,
		);
	}

	if (expectation.maxLogErrors !== undefined) {
		const logs = await client.call<{ total: number; lines: Array<{ text: string }> }>("logs", {
			level: ["ERROR"],
			limit: 5,
		});
		check(
			failures,
			logs.total <= expectation.maxLogErrors,
			`${logs.total} ERROR line(s) in the plugin log, expected at most ${expectation.maxLogErrors}:\n    ${logs.lines.map((line) => line.text).join("\n    ")}`,
		);
	}

	return failures;
}

function check(failures: string[], condition: boolean, message: string): void {
	if (!condition) {
		failures.push(message);
	}
}

function missingEntries(actual: Record<string, unknown>, wanted: Record<string, unknown>, label: string): string[] {
	return Object.entries(wanted)
		.filter(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))
		.map(([key, value]) => `${label}.${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(value)}`);
}

function describeStep(step: Step): string {
	const [action] = Object.entries(step).filter(([key]) => key !== "name" && key !== "expect");
	return action === undefined
		? "expect"
		: `${action[0]} ${typeof action[1] === "object" ? "" : String(action[1])}`.trim();
}
