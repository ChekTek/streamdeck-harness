import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
	errorMessage,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	type JsonObject,
	parseJsonValue,
	type Controller,
} from "../host/protocol.js";

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

	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(readFileSync(manifestPath, "utf8"));
	} catch (cause) {
		throw new Error(`manifest.json is not valid JSON: ${errorMessage(cause)}`);
	}

	const manifest = parseManifest(parsed);

	const expectedFolder = `${manifest.UUID}.sdPlugin`;
	if (basename(root) !== expectedFolder) {
		throw new Error(`folder is ${basename(root)} but manifest UUID expects ${expectedFolder}`);
	}

	const runtime = manifest.Nodejs === undefined ? "native" : "node";
	const codePath = resolveCodePath(root, manifest, runtime);

	return { root, manifestPath, manifest, runtime, codePath };
}

function parseManifest(value: JsonValue): Manifest {
	if (!isJsonObject(value) || !isJsonString(value.UUID) || value.UUID.length === 0) {
		throw new Error("manifest.json has no UUID");
	}
	if (!isJsonString(value.Name) || !isJsonString(value.Version)) {
		throw new Error("manifest.json is missing Name or Version");
	}
	if (!Array.isArray(value.Actions)) {
		throw new Error("manifest.json has no Actions array");
	}

	const manifest: Manifest = {
		Name: value.Name,
		Version: value.Version,
		UUID: value.UUID,
		Actions: value.Actions.map((action, index) => parseManifestAction(action, index)),
	};
	if (isJsonString(value.Author)) {
		manifest.Author = value.Author;
	}
	if (isJsonString(value.CodePath)) {
		manifest.CodePath = value.CodePath;
	}
	if (isJsonString(value.CodePathMac)) {
		manifest.CodePathMac = value.CodePathMac;
	}
	if (isJsonString(value.CodePathWin)) {
		manifest.CodePathWin = value.CodePathWin;
	}
	if (isJsonString(value.PropertyInspectorPath)) {
		manifest.PropertyInspectorPath = value.PropertyInspectorPath;
	}
	if (isJsonObject(value.Nodejs)) {
		const nodejs: NonNullable<Manifest["Nodejs"]> = {};
		if (isJsonString(value.Nodejs.Version)) {
			nodejs.Version = value.Nodejs.Version;
		}
		if (isJsonString(value.Nodejs.Debug)) {
			nodejs.Debug = value.Nodejs.Debug;
		}
		manifest.Nodejs = nodejs;
	}
	if (isJsonNumber(value.SDKVersion)) {
		manifest.SDKVersion = value.SDKVersion;
	}
	return manifest;
}

function parseManifestAction(value: JsonValue, index: number): ManifestAction {
	if (!isJsonObject(value) || !isJsonString(value.Name) || !isJsonString(value.UUID)) {
		throw new Error(`manifest.json Actions[${index}] is missing Name or UUID`);
	}
	const action: ManifestAction = { Name: value.Name, UUID: value.UUID };
	if (isJsonString(value.Icon)) {
		action.Icon = value.Icon;
	}
	if (isJsonString(value.Tooltip)) {
		action.Tooltip = value.Tooltip;
	}
	if (isJsonString(value.PropertyInspectorPath)) {
		action.PropertyInspectorPath = value.PropertyInspectorPath;
	}
	if (Array.isArray(value.Controllers)) {
		action.Controllers = value.Controllers.filter(
			(controller): controller is Controller => controller === "Encoder" || controller === "Keypad",
		);
	}
	if (Array.isArray(value.States)) {
		action.States = value.States.filter((state) => isJsonObject(state)).map(parseManifestState);
	}
	if (isJsonBoolean(value.SupportedInMultiActions)) {
		action.SupportedInMultiActions = value.SupportedInMultiActions;
	}
	if (isJsonBoolean(value.UserTitleEnabled)) {
		action.UserTitleEnabled = value.UserTitleEnabled;
	}
	if (isJsonBoolean(value.VisibleInActionsList)) {
		action.VisibleInActionsList = value.VisibleInActionsList;
	}
	return action;
}

function parseManifestState(value: JsonObject): ManifestState {
	if (!isJsonString(value.Image)) {
		return { Image: "" };
	}
	const state: ManifestState = { Image: value.Image };
	if (isJsonString(value.MultiActionImage)) {
		state.MultiActionImage = value.MultiActionImage;
	}
	if (isJsonString(value.Name)) {
		state.Name = value.Name;
	}
	if (isJsonString(value.Title)) {
		state.Title = value.Title;
	}
	if (isJsonBoolean(value.ShowTitle)) {
		state.ShowTitle = value.ShowTitle;
	}
	if (isJsonString(value.TitleColor)) {
		state.TitleColor = value.TitleColor;
	}
	if (isJsonString(value.TitleAlignment)) {
		state.TitleAlignment = value.TitleAlignment;
	}
	if (isJsonString(value.FontFamily)) {
		state.FontFamily = value.FontFamily;
	}
	if (isJsonNumber(value.FontSize)) {
		state.FontSize = value.FontSize;
	}
	if (isJsonString(value.FontStyle)) {
		state.FontStyle = value.FontStyle;
	}
	if (isJsonBoolean(value.FontUnderline)) {
		state.FontUnderline = value.FontUnderline;
	}
	return state;
}

function resolveCodePath(root: string, manifest: Manifest, runtime: "native" | "node"): string {
	const platformPath = process.platform === "win32" ? manifest.CodePathWin : manifest.CodePathMac;
	const relative = platformPath ?? manifest.CodePath;
	if (relative === undefined) {
		throw new Error(`manifest.json declares neither CodePath nor ${process.platform === "win32" ? "CodePathWin" : "CodePathMac"}`);
	}

	const absolute = join(root, relative);
	if (!existsSync(absolute)) {
		const hint = runtime === "node" ? "run the plugin's build script first" : "build the binary first";
		throw new Error(`CodePath points at a missing file: ${absolute} (${hint})`);
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
