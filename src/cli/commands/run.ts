import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";

import { secretsFromEnv } from "../../daemon/redact.js";
import { errorMessage, parseJsonValue, type JsonValue } from "../../host/protocol.js";
import { resolvePath, runScenario } from "../../scenario/run.js";
import { parseScenario, type ScenarioReport } from "../../scenario/schema.js";
import { type Args, flagBool } from "../args.js";
import { DaemonClient } from "../client.js";
import { emit, fail } from "../output.js";
import { closeSession, launchSession } from "./sessions.js";

export const RUN_USAGE = "run <scenario.yaml> [--keep] [--session NAME]";

/** Runs a scenario file in its own session and prints one report. */
export async function runCommand(args: Args): Promise<void> {
	const file = args.positional[0];
	if (file === undefined) {
		fail(`usage: sdtest ${RUN_USAGE}`);
	}

	const path = resolve(file);
	const scenario = parseScenario(yamlToJson(readFileSync(path, "utf8")), path);

	// Scenario paths are relative to the scenario file.
	const base = dirname(path);
	const pluginPath = resolvePath(scenario.plugin, base);

	const session = args.session === "default" ? `run-${process.pid}` : args.session;
	const keep = flagBool(args, "keep") === true;

	const launch = {
		pluginPath,
		devices:
			scenario.device === undefined ? undefined : Array.isArray(scenario.device) ? scenario.device : [scenario.device],
		nodePath: scenario.node,
		globalSettings: scenario.globalSettings,
		env: scenario.env,
		envFile: scenario.dotenv === undefined ? undefined : resolvePath(scenario.dotenv, base),
	};
	const meta = await launchSession(session, launch).catch((cause: unknown) => {
		fail(errorMessage(cause));
	});

	if (meta.status !== "ready") {
		fail(`could not start ${pluginPath}:\n${meta.error ?? "unknown error"}`);
	}

	let report: ScenarioReport;
	const client = await DaemonClient.connect(session);
	try {
		const secrets =
			launch.envFile === undefined ? [] : secretsFromEnv(parseEnv(readFileSync(launch.envFile, "utf8")));
		report = await runScenario(client, { ...scenario, plugin: pluginPath }, base, secrets);
	} finally {
		client.close();
		if (!keep) {
			await closeSession(session, true);
		}
	}

	emit(parseJsonValue(JSON.stringify(report)), () => {
		const lines = [
			`${report.ok ? "PASS" : "FAIL"}  ${report.name}`,
			`plugin: ${report.plugin}`,
			"",
			...report.steps.map((step) => `${step.ok ? "  ok  " : "  FAIL"}  ${String(step.index).padStart(2)}  ${step.name}`),
		];
		if (report.failures.length > 0) {
			lines.push("", "failures:", ...report.failures.map((failure) => `  - ${failure}`));
		}
		if (report.artifacts.length > 0) {
			lines.push("", "artifacts:", ...report.artifacts.map((artifact) => `  ${artifact}`));
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

function yamlToJson(text: string): JsonValue {
	return parseYaml(text);
}
