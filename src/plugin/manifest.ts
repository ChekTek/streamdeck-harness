import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { Controller } from "../host/protocol.js";

export type ManifestState = {
	Image: string;
	MultiActionImage?: string;
	Name?: string;
	Title?: string;
	ShowTitle?: boolean;
	TitleColor?: string;
	TitleAlignment?: string;
	FontFamily?: string;
	FontSize?: number;
	FontStyle?: string;
	FontUnderline?: boolean;
};

export type ManifestAction = {
	Name: string;
	UUID: string;
	Icon?: string;
	Tooltip?: string;
	PropertyInspectorPath?: string;
	Controllers?: Controller[];
	States?: ManifestState[];
	SupportedInMultiActions?: boolean;
	UserTitleEnabled?: boolean;
	VisibleInActionsList?: boolean;
};

export type Manifest = {
	Name: string;
	Version: string;
	Author?: string;
	UUID: string;
	Actions: ManifestAction[];
	CodePath?: string;
	CodePathMac?: string;
	CodePathWin?: string;
	PropertyInspectorPath?: string;
	Nodejs?: { Version?: string; Debug?: string };
	SDKVersion?: number;
	[key: string]: unknown;
};

export type PluginProject = {
	/** Absolute path of the `*.sdPlugin` folder. */
	root: string;
	/** Absolute path of `manifest.json`. */
	manifestPath: string;
	manifest: Manifest;
	/** `node` when the manifest declares a `Nodejs` block, otherwise a native binary. */
	runtime: "native" | "node";
	/** Absolute path of the entry point for the current platform. */
	codePath: string;
};

/**
 * Resolves a user-supplied path to a `*.sdPlugin` folder. Accepts the folder itself, a
 * `manifest.json`, or a project root containing exactly one `*.sdPlugin` folder.
 */
export function findPluginRoot(input: string): string {
	const target = resolve(input);
	if (!existsSync(target)) {
		throw new Error(`path does not exist: ${target}`);
	}

	if (statSync(target).isFile()) {
		if (basename(target) !== "manifest.json") {
			throw new Error(`expected a .sdPlugin folder or manifest.json, got: ${target}`);
		}
		return dirname(target);
	}

	if (target.endsWith(".sdPlugin")) {
		return target;
	}

	const candidates = readdirSync(target)
		.filter((name) => name.endsWith(".sdPlugin"))
		.map((name) => join(target, name))
		.filter((path) => statSync(path).isDirectory());

	if (candidates.length === 1) {
		return candidates[0]!;
	}
	if (candidates.length === 0) {
		throw new Error(`no *.sdPlugin folder found in ${target}`);
	}
	throw new Error(`multiple *.sdPlugin folders in ${target}; pass one explicitly:\n  ${candidates.join("\n  ")}`);
}

export function loadPlugin(input: string): PluginProject {
	const root = findPluginRoot(input);
	const manifestPath = join(root, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`no manifest.json in ${root}`);
	}

	let manifest: Manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	} catch (cause) {
		throw new Error(`manifest.json is not valid JSON: ${(cause as Error).message}`);
	}

	if (typeof manifest.UUID !== "string" || manifest.UUID.length === 0) {
		throw new Error("manifest.json has no UUID");
	}
	if (!Array.isArray(manifest.Actions)) {
		throw new Error("manifest.json has no Actions array");
	}

	const expectedFolder = `${manifest.UUID}.sdPlugin`;
	if (basename(root) !== expectedFolder) {
		throw new Error(`folder is ${basename(root)} but manifest UUID expects ${expectedFolder}`);
	}

	const runtime = manifest.Nodejs === undefined ? "native" : "node";
	const codePath = resolveCodePath(root, manifest, runtime);

	return { root, manifestPath, manifest, runtime, codePath };
}

function resolveCodePath(root: string, manifest: Manifest, runtime: "native" | "node"): string {
	const platformKey = process.platform === "win32" ? "CodePathWin" : "CodePathMac";
	const relative = manifest[platformKey] ?? manifest.CodePath;
	if (relative === undefined) {
		throw new Error(`manifest.json declares neither CodePath nor ${platformKey}`);
	}

	const absolute = join(root, relative);
	if (!existsSync(absolute)) {
		const hint = runtime === "node" ? "run the plugin's build script first" : "build the binary first";
		throw new Error(`${platformKey ?? "CodePath"} points at a missing file: ${absolute} (${hint})`);
	}
	return absolute;
}

export function findAction(manifest: Manifest, uuid: string): ManifestAction {
	const action = manifest.Actions.find((candidate) => candidate.UUID === uuid);
	if (action !== undefined) {
		return action;
	}

	const known = manifest.Actions.map((candidate) => candidate.UUID).join("\n  ");
	throw new Error(`no action ${uuid} in manifest. Known actions:\n  ${known}`);
}

/**
 * Manifest image paths are extensionless -- Stream Deck appends the extension itself.
 * Resolution order matches the app: SVG first, then the high-DPI raster, then the raster.
 */
export function resolveImagePath(root: string, relative: string): string | undefined {
	const base = join(root, relative);
	for (const candidate of [`${base}.svg`, `${base}@2x.png`, `${base}.png`, base]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}
