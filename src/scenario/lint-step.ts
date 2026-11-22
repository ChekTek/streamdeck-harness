import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { formatFindings, lintSvg } from "../render/svg-tiny.js";

export type LintStepReport = {
	files: number;
	errors: number;
	warnings: number;
	summary: string[];
};

/** Lints each `.svg` file under `target`. */
export function lintPath(target: string): LintStepReport {
	const root = resolve(target);
	const files: string[] = [];

	const walk = (path: string): void => {
		const stat = statSync(path);
		if (stat.isFile()) {
			if (path.endsWith(".svg")) {
				files.push(path);
			}
			return;
		}
		for (const entry of readdirSync(path)) {
			if (entry !== "node_modules" && !entry.startsWith(".")) {
				walk(join(path, entry));
			}
		}
	};
	walk(root);
	if (files.length === 0) {
		throw new Error(`no .svg files found under: ${root}`);
	}

	const results = files.map((file) => lintSvg(readFileSync(file, "utf8"), relative(process.cwd(), file)));
	return {
		files: results.length,
		errors: results.reduce((total, result) => total + result.errors, 0),
		warnings: results.reduce((total, result) => total + result.warnings, 0),
		summary: results.filter((result) => result.findings.length > 0).map(formatFindings),
	};
}
