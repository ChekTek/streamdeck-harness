import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { compactJson } from "../../host/protocol.js";
import { emit, fail } from "../output.js";

/** Downloads the Chromium that the bundled Playwright uses. */
export function installBrowserCommand(): void {
	const playwright = dirname(createRequire(import.meta.url).resolve("playwright/package.json"));
	const { status, error } = spawnSync(
		process.execPath,
		[join(playwright, "cli.js"), "install", "chromium", "--only-shell"],
		{ stdio: ["ignore", process.stderr, process.stderr], windowsHide: true },
	);
	if (status !== 0) {
		fail(`could not install Chromium${error === undefined ? "" : `: ${error.message}`}`);
	}

	emit(compactJson({ browser: "chromium", installed: true }), () => "Chromium is installed.");
}
