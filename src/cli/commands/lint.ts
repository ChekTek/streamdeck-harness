import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { findPluginRoot } from "../../plugin/manifest.js";
import { formatFindings, type LintResult, lintSvg } from "../../render/svg-tiny.js";
import { type Args, flagBool } from "../args.js";
import { emit, fail } from "../output.js";

function collect(target: string, into: string[]): void {
	const stat = statSync(target);
	if (stat.isFile()) {
		if (target.endsWith(".svg")) {
			into.push(target);
		}
		return;
	}
	for (const entry of readdirSync(target)) {
		if (entry === "node_modules" || entry.startsWith(".")) {
			continue;
		}
		collect(join(target, entry), into);
	}
}

/**
 * Lints SVGs against SVG Tiny 1.2 and the Stream Deck renderer. Runs without a session:
 * it is static analysis, not a live check.
 */
export function lintCommand(args: Args): void {
	const inputs = args.positional.length > 0 ? args.positional : ["."];
	const files: string[] = [];

	for (const input of inputs) {
		const target = resolve(input);
		try {
			// A plugin root is the common case; lint its shipped artwork rather than its source tree.
			collect(statSync(target).isDirectory() ? tryPluginImages(target) : target, files);
		} catch (cause) {
			fail((cause as Error).message);
		}
	}

	if (files.length === 0) {
		fail(`no .svg files found under: ${inputs.join(", ")}`);
	}

	const results = files.map((file) => lintSvg(readFileSync(file, "utf8"), relative(process.cwd(), file)));
	const errors = results.reduce((total, result) => total + result.errors, 0);
	const warnings = results.reduce((total, result) => total + result.warnings, 0);
	const failOnWarning = flagBool(args, "strict") === true;

	emit({ files: results.length, errors, warnings, results }, () =>
		[
			...results.filter((result) => result.findings.length > 0).map(formatFindings),
			"",
			`${results.length} file(s), ${errors} error(s), ${warnings} warning(s)`,
		].join("\n"),
	);

	if (errors > 0 || (failOnWarning && warnings > 0)) {
		process.exitCode = 1;
	}
}

/** Narrows a plugin project to its `imgs` folder when one exists, so source trees are not scanned. */
function tryPluginImages(target: string): string {
	try {
		const root = findPluginRoot(target);
		const images = join(root, "imgs");
		return statSync(images).isDirectory() ? images : root;
	} catch {
		return target;
	}
}

export type { LintResult };
