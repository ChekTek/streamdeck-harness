import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { resolvePath, runScenario } from "../../scenario/run.js";
import { parseScenario, type ScenarioReport } from "../../scenario/schema.js";
import { type Args, flagBool } from "../args.js";
import { DaemonClient } from "../client.js";
import { emit, fail } from "../output.js";
import { closeSession, launchSession } from "./sessions.js";

/**
 * Runs a scenario file end to end in its own session and prints one report. This is the
 * shape an agent should reach for: a whole check in a single call, rather than a long
 * sequence of round trips.
 */
export async function runCommand(args: Args): Promise<void> {
	const file = args.positional[0];
	if (file === undefined) {
		fail("usage: sdtest run <scenario.yaml> [--keep] [--session NAME]");
	}

	const path = resolve(file);
	const scenario = parseScenario(parseYaml(readFileSync(path, "utf8")) as unknown, path);

	// Paths in a scenario are relative to the scenario file, not the shell's directory.
	const base = dirname(path);
	const pluginPath = resolvePath(scenario.plugin, base);

	const session = args.session === "default" ? `run-${process.pid}` : args.session;
	const keep = flagBool(args, "keep") === true;

	const meta = await launchSession(session, {
		pluginPath,
		devices:
			scenario.device === undefined ? undefined : Array.isArray(scenario.device) ? scenario.device : [scenario.device],
		...(scenario.node === undefined ? {} : { nodePath: scenario.node }),
	}).catch((cause: unknown) => {
		fail((cause as Error).message);
	});

	if (meta.status !== "ready") {
		fail(`could not start ${pluginPath}:\n${meta.error ?? "unknown error"}`);
	}

	let report: ScenarioReport;
	const client = await DaemonClient.connect(session);
	try {
		report = await runScenario(client, { ...scenario, plugin: pluginPath }, base);
	} finally {
		client.close();
		if (!keep) {
			await closeSession(session);
		}
	}

	emit(report, (value: ScenarioReport) => {
		const lines = [
			`${value.ok ? "PASS" : "FAIL"}  ${value.name}`,
			`plugin: ${value.plugin}`,
			"",
			...value.steps.map((step) => `${step.ok ? "  ok  " : "  FAIL"}  ${String(step.index).padStart(2)}  ${step.name}`),
		];
		if (value.failures.length > 0) {
			lines.push("", "failures:", ...value.failures.map((failure) => `  - ${failure}`));
		}
		if (value.artifacts.length > 0) {
			lines.push("", "artifacts:", ...value.artifacts.map((artifact) => `  ${artifact}`));
		}
		if (keep) {
			lines.push("", `session "${session}" left running (--keep). Close it with: sdtest -s=${session} close`);
		}
		return lines.join("\n");
	});

	if (!report.ok) {
		process.exitCode = 1;
	}
}
