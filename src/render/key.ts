import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { ActionInstance } from "../host/action.js";
import { type PluginProject, resolveImagePath } from "../plugin/manifest.js";
import { type LintResult, lintSvg } from "./svg-tiny.js";

export type KeyImage = {
	/** Where the pixels came from. */
	origin: "manifest" | "none" | "setImage";
	/** `data:` URI the page can load directly. */
	dataUri: string | undefined;
	/** Absolute path when the image resolved to a file on disk. */
	path: string | undefined;
	mimeType: string | undefined;
	/** Decoded SVG markup, when the image is an SVG. Cheaper for an agent to read than a screenshot. */
	svg: string | undefined;
	/** Tiny 1.2 lint of that markup. */
	lint: LintResult | undefined;
	/** Set when the image could not be resolved at all. */
	error: string | undefined;
};

const MIME_BY_EXTENSION: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Resolves what a key is currently showing: a `setImage` override if the plugin set one,
 * otherwise the manifest image for the current state.
 */
export function resolveKeyImage(project: PluginProject, instance: ActionInstance): KeyImage {
	const override = instance.effectiveImage?.image;
	if (override !== undefined) {
		return override.startsWith("data:") ? fromDataUri(override) : fromFile(project, override, "setImage");
	}

	const manifestImage = instance.manifestState?.Image;
	if (manifestImage === undefined) {
		return blank("action declares no image for this state in manifest.json");
	}
	return fromFile(project, manifestImage, "manifest");
}

function blank(error?: string): KeyImage {
	return {
		origin: "none",
		dataUri: undefined,
		path: undefined,
		mimeType: undefined,
		svg: undefined,
		lint: undefined,
		error,
	};
}

function fromDataUri(uri: string): KeyImage {
	const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
	if (match === null) {
		return { ...blank("setImage payload is not a valid data URI"), origin: "setImage", dataUri: uri };
	}

	const [, mimeType = "", base64, body = ""] = match;
	const decoded = base64 === undefined ? decodeURIComponent(body) : Buffer.from(body, "base64").toString("utf8");
	const isSvg = mimeType.includes("svg");

	return {
		origin: "setImage",
		dataUri: uri,
		path: undefined,
		mimeType,
		svg: isSvg ? decoded : undefined,
		lint: isSvg ? lintSvg(decoded, "setImage payload") : undefined,
		error: undefined,
	};
}

function fromFile(project: PluginProject, relative: string, origin: "manifest" | "setImage"): KeyImage {
	const path = resolveImagePath(project.root, relative);
	if (path === undefined) {
		return { ...blank(`no file for "${relative}" (tried .svg, @2x.png, .png)`), origin };
	}

	const extension = path.slice(path.lastIndexOf("."));
	const mimeType = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
	const bytes = readFileSync(path);
	const isSvg = mimeType === "image/svg+xml";
	const svg = isSvg ? bytes.toString("utf8") : undefined;

	return {
		origin,
		dataUri: `data:${mimeType};base64,${bytes.toString("base64")}`,
		path,
		mimeType,
		svg,
		lint: svg === undefined ? undefined : lintSvg(svg, basename(path)),
		error: undefined,
	};
}

/**
 * Builds the page the screenshot is taken from: the key image with the title composited on
 * top the way Stream Deck draws it.
 *
 * The title layer is an approximation. Stream Deck rasterises titles with Qt at a font size
 * expressed against a 72px key, so the size is scaled by `size / 72`; its subtle text shadow
 * and glyph hinting are not reproduced.
 */
export function keyHtml(instance: ActionInstance, image: KeyImage, size: number): string {
	const parameters = instance.titleParameters;
	const title = instance.effectiveTitle;
	const showTitle = parameters.showTitle && title.length > 0;

	const justify =
		parameters.titleAlignment === "top" ? "flex-start" : parameters.titleAlignment === "bottom" ? "flex-end" : "center";
	const fontPx = parameters.fontSize * (size / 72);
	const fontFamily = parameters.fontFamily.length > 0 ? `${JSON.stringify(parameters.fontFamily)}, ` : "";
	const style = parameters.fontStyle.toLowerCase();

	return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #000; }
  #key {
    position: relative; width: ${size}px; height: ${size}px; overflow: hidden;
    background: #000; display: flex; align-items: ${justify}; justify-content: center;
  }
  #key img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  #title {
    position: relative; z-index: 1; width: 100%; box-sizing: border-box; padding: ${Math.round(size * 0.04)}px;
    text-align: center; white-space: pre-wrap; word-break: break-word; line-height: 1.1;
    font-family: ${fontFamily}system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: ${fontPx}px;
    font-weight: ${style.includes("bold") ? "700" : "400"};
    font-style: ${style.includes("italic") ? "italic" : "normal"};
    text-decoration: ${parameters.fontUnderline ? "underline" : "none"};
    color: ${parameters.titleColor};
  }
  #missing {
    position: absolute; inset: 0; display: grid; place-items: center; color: #ff5555;
    font: ${Math.round(size / 12)}px/1.2 system-ui, sans-serif; text-align: center; padding: 8px;
  }
</style>
<div id="key">
  ${image.dataUri === undefined ? `<div id="missing">${escapeHtml(image.error ?? "no image")}</div>` : `<img src="${image.dataUri}" alt="">`}
  ${showTitle ? `<div id="title">${escapeHtml(title)}</div>` : ""}
</div>`;
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"]/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character,
	);
}
