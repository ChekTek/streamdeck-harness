import sax from "sax";

/**
 * SVG Tiny 1.2 / Stream Deck renderer compatibility linter.
 *
 * Stream Deck rasterises key images with Qt's SVG renderer, which targets SVG Tiny 1.2.
 * Chromium renders far more than that, so a screenshot alone will happily show a key that
 * is blank or wrong on real hardware. This lint is the compatibility truth; the screenshot
 * is only what the artwork is meant to look like.
 *
 * Findings carry `source: "tiny12"` when the construct is absent from the SVG Tiny 1.2
 * element/attribute set, and `source: "renderer"` when it exists but Qt ignores or
 * mishandles it. Both matter; the distinction tells you whether to blame the spec or the app.
 */

export type FindingSeverity = "error" | "warning";

export type Finding = {
	severity: FindingSeverity;
	source: "parse" | "renderer" | "tiny12";
	rule: string;
	message: string;
	fix?: string;
	line: number;
	column: number;
};

export type LintResult = {
	file: string;
	findings: Finding[];
	errors: number;
	warnings: number;
};

/** Elements defined by SVG Tiny 1.2 (W3C element index). */
const TINY_ELEMENTS = new Set([
	"a",
	"animate",
	"animateColor",
	"animateMotion",
	"animateTransform",
	"animation",
	"audio",
	"circle",
	"defs",
	"desc",
	"discard",
	"ellipse",
	"font",
	"font-face",
	"font-face-src",
	"font-face-uri",
	"foreignObject",
	"g",
	"glyph",
	"handler",
	"hkern",
	"image",
	"line",
	"linearGradient",
	"listener",
	"metadata",
	"missing-glyph",
	"mpath",
	"path",
	"polygon",
	"polyline",
	"prefetch",
	"radialGradient",
	"rect",
	"script",
	"set",
	"solidColor",
	"stop",
	"svg",
	"switch",
	"tbreak",
	"text",
	"textArea",
	"title",
	"tspan",
	"use",
	"video",
]);

/** Elements outside Tiny 1.2 that Stream Deck drops outright, with the usual workaround. */
const UNSUPPORTED_ELEMENTS: Record<string, string> = {
	filter:
		"Draw the effect explicitly -- e.g. a drop shadow becomes a duplicated shape offset by a few units at a lower fill-opacity.",
	mask: "Use a solid shape in the background colour, or split the artwork into non-overlapping paths.",
	clipPath: "Pre-clip the geometry in your editor so the path data is already trimmed.",
	pattern: "Repeat the motif as explicit shapes, or embed a raster tile as a data URI.",
	marker: "Draw arrowheads and end caps as explicit paths.",
	symbol: "Replace with a <g> in <defs> referenced by <use>.",
	textPath: "Position each glyph with <tspan> x/y, or convert the text to paths.",
	tref: "Inline the text content.",
	style: "Move CSS declarations onto the elements as presentation attributes (fill, stroke, opacity...).",
	foreignObject: "Not rendered by Stream Deck. Express the content as native SVG shapes or text.",
	altGlyph: "Convert the text to paths.",
	glyphRef: "Convert the text to paths.",
	view: "Remove it; Stream Deck renders the root viewBox only.",
	cursor: "Remove it; there is no pointer on a Stream Deck key.",
};

/** Attributes Stream Deck ignores or cannot honour, with what to do instead. */
const UNSUPPORTED_ATTRIBUTES: Record<
	string,
	{ severity: FindingSeverity; source: "renderer" | "tiny12"; fix: string }
> = {
	filter: { severity: "error", source: "tiny12", fix: "Draw the effect explicitly instead of referencing a <filter>." },
	mask: { severity: "error", source: "tiny12", fix: "Remove the mask reference and trim the geometry instead." },
	"clip-path": {
		severity: "error",
		source: "tiny12",
		fix: "Pre-clip the path data instead of referencing a <clipPath>.",
	},
	"marker-start": { severity: "error", source: "tiny12", fix: "Draw the marker as an explicit path." },
	"marker-mid": { severity: "error", source: "tiny12", fix: "Draw the marker as an explicit path." },
	"marker-end": { severity: "error", source: "tiny12", fix: "Draw the marker as an explicit path." },
	"mix-blend-mode": {
		severity: "error",
		source: "tiny12",
		fix: "Flatten the blend in your editor and use plain fills.",
	},
	isolation: { severity: "error", source: "tiny12", fix: "Remove it; it only has meaning with mix-blend-mode." },
	"paint-order": {
		severity: "warning",
		source: "renderer",
		fix: "Draw the stroke as a separate underlying shape to control ordering.",
	},
	"dominant-baseline": {
		severity: "warning",
		source: "tiny12",
		fix: "Ignored by Stream Deck -- set the y coordinate to the baseline you want.",
	},
	"alignment-baseline": {
		severity: "warning",
		source: "tiny12",
		fix: "Ignored by Stream Deck -- set the y coordinate to the baseline you want.",
	},
};

/**
 * `rgba()`, `hsla()`, the slash-alpha form, and 4/8-digit hex all encode alpha in the colour,
 * which SVG Tiny 1.2 expresses with a separate `*-opacity` property instead.
 */
const HEX_ALPHA = /^#(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_ALPHA = /^(?:rgba|hsla)\(/i;
const SLASH_ALPHA = /^(?:rgb|hsl)\([^)]*\/[^)]*\)$/i;
const CSS_VAR = /var\(\s*--/;
const OPACITY_ATTRIBUTES = new Set(["fill", "stroke", "stop-color", "color", "solid-color", "flood-color"]);

function encodesAlpha(value: string): boolean {
	const trimmed = value.trim();
	return HEX_ALPHA.test(trimmed) || FUNCTIONAL_ALPHA.test(trimmed) || SLASH_ALPHA.test(trimmed);
}

export function lintSvg(source: string, file = "<inline>"): LintResult {
	const findings: Finding[] = [];
	const parser = sax.parser(true, { position: true, xmlns: false });
	const lineStarts = indexLines(source);

	let rootSeen = false;

	// sax reports the position *after* the tag it just parsed; `startTagPosition` is the
	// offset of the opening `<`, which is what an editor should jump to.
	const at = (): { line: number; column: number } =>
		parser.startTagPosition > 0
			? offsetToPosition(lineStarts, parser.startTagPosition - 1)
			: { line: parser.line + 1, column: parser.column + 1 };

	const add = (finding: Omit<Finding, "column" | "line">): void => {
		findings.push({ ...finding, ...at() });
	};

	parser.onopentag = (node): void => {
		const name = node.name;

		const unsupported = UNSUPPORTED_ELEMENTS[name];
		if (unsupported !== undefined) {
			add({
				severity: "error",
				source: TINY_ELEMENTS.has(name) ? "renderer" : "tiny12",
				rule: `element/${name}`,
				message: `<${name}> is not rendered by Stream Deck`,
				fix: unsupported,
			});
		} else if (name.startsWith("fe") && name.length > 2) {
			add({
				severity: "error",
				source: "tiny12",
				rule: "element/filter-primitive",
				message: `<${name}> is a filter primitive; Stream Deck renders no filters`,
				fix: "Draw the effect explicitly with plain shapes.",
			});
		} else if (!TINY_ELEMENTS.has(name)) {
			add({
				severity: "warning",
				source: "tiny12",
				rule: "element/unknown",
				message: `<${name}> is not part of SVG Tiny 1.2 and may be dropped`,
			});
		}

		if (name === "svg") {
			if (rootSeen) {
				add({
					severity: "warning",
					source: "tiny12",
					rule: "element/nested-svg",
					message: "nested <svg> elements are unreliable in Stream Deck",
					fix: "Flatten into a single root <svg> with <g transform=...>.",
				});
			} else {
				rootSeen = true;
				if (node.attributes.viewBox === undefined) {
					add({
						severity: "warning",
						source: "renderer",
						rule: "root/no-viewbox",
						message: "root <svg> has no viewBox, so it will not scale to the key",
						fix: 'Add viewBox="0 0 144 144" to match the key raster size.',
					});
				}
			}
		}

		checkAttributes(name, node.attributes as Record<string, string>, add);

		if (name === "text" && node.attributes["font-family"] === undefined) {
			add({
				severity: "warning",
				source: "renderer",
				rule: "text/no-font-family",
				message: "<text> has no font-family; Stream Deck picks a fallback that differs from your preview",
				fix: "Set font-family explicitly, or convert the text to paths for a guaranteed result.",
			});
		}
	};

	parser.onerror = (error): void => {
		findings.push({
			severity: "error",
			source: "parse",
			rule: "parse/invalid-xml",
			message: error.message.split("\n")[0] ?? error.message,
			...at(),
		});
		parser.resume();
	};

	try {
		parser.write(source).close();
	} catch (cause) {
		findings.push({
			severity: "error",
			source: "parse",
			rule: "parse/failed",
			message: (cause as Error).message.split("\n")[0] ?? "could not parse",
			line: parser.line + 1,
			column: parser.column + 1,
		});
	}

	if (!rootSeen && findings.every((finding) => finding.source !== "parse")) {
		findings.push({
			severity: "error",
			source: "parse",
			rule: "parse/no-svg",
			message: "no root <svg> element",
			line: 1,
			column: 1,
		});
	}

	return {
		file,
		findings,
		errors: findings.filter((finding) => finding.severity === "error").length,
		warnings: findings.filter((finding) => finding.severity === "warning").length,
	};
}

function checkAttributes(
	element: string,
	attributes: Record<string, string>,
	add: (finding: Omit<Finding, "column" | "line">) => void,
): void {
	for (const [name, value] of Object.entries(attributes)) {
		const rule = UNSUPPORTED_ATTRIBUTES[name];
		if (rule !== undefined) {
			add({
				severity: rule.severity,
				source: rule.source,
				rule: `attribute/${name}`,
				message: `${name}="${truncate(value)}" is not honoured by Stream Deck`,
				fix: rule.fix,
			});
		}

		if (CSS_VAR.test(value)) {
			add({
				severity: "error",
				source: "tiny12",
				rule: "attribute/css-var",
				message: `${name} uses a CSS custom property, which Stream Deck cannot resolve`,
				fix: "Inline the literal value.",
			});
		}

		if (name === "style") {
			checkStyleDeclarations(value, add);
		}

		if (OPACITY_ATTRIBUTES.has(name) && encodesAlpha(value)) {
			add({
				severity: "error",
				source: "tiny12",
				rule: "attribute/alpha-colour",
				message: `${name}="${truncate(value)}" encodes alpha in the colour`,
				fix: `Use a 6-digit hex colour plus ${name}-opacity.`,
			});
		}

		if ((name === "href" || name === "xlink:href") && isExternalReference(value)) {
			add({
				severity: "error",
				source: "renderer",
				rule: "attribute/external-reference",
				message: `${name}="${truncate(value)}" points outside the document`,
				fix: "Embed the asset as a data: URI -- Stream Deck does not fetch external files for key images.",
			});
		}
	}

	if (element === "image" && (attributes.width === undefined || attributes.height === undefined)) {
		add({
			severity: "warning",
			source: "renderer",
			rule: "image/no-size",
			message: "<image> has no explicit width/height; Stream Deck's intrinsic sizing differs from a browser's",
			fix: "Set width and height in user units.",
		});
	}
}

/**
 * Applies the attribute rules to CSS declarations inside a `style` attribute. Qt honours
 * `style` itself -- what it cannot honour are the same properties that fail as attributes.
 */
function checkStyleDeclarations(style: string, add: (finding: Omit<Finding, "column" | "line">) => void): void {
	for (const declaration of style.split(";")) {
		const separator = declaration.indexOf(":");
		if (separator < 0) {
			continue;
		}
		const property = declaration.slice(0, separator).trim();
		const value = declaration.slice(separator + 1).trim();

		const rule = UNSUPPORTED_ATTRIBUTES[property];
		if (rule !== undefined) {
			add({
				severity: rule.severity,
				source: rule.source,
				rule: `style/${property}`,
				message: `style declaration "${property}: ${truncate(value)}" is not honoured by Stream Deck`,
				fix: rule.fix,
			});
		}

		if (CSS_VAR.test(value)) {
			add({
				severity: "error",
				source: "tiny12",
				rule: "style/css-var",
				message: `style declaration "${property}" uses a CSS custom property, which Stream Deck cannot resolve`,
				fix: "Inline the literal value.",
			});
		}

		if (OPACITY_ATTRIBUTES.has(property) && encodesAlpha(value)) {
			add({
				severity: "error",
				source: "tiny12",
				rule: "style/alpha-colour",
				message: `style declaration "${property}: ${truncate(value)}" encodes alpha in the colour`,
				fix: `Use an opaque colour plus ${property}-opacity.`,
			});
		}
	}
}

/** Character offsets at which each line begins, for translating sax offsets to line/column. */
function indexLines(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n") {
			starts.push(index + 1);
		}
	}
	return starts;
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; column: number } {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (lineStarts[mid]! <= offset) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return { line: low + 1, column: offset - lineStarts[low]! + 1 };
}

function isExternalReference(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("data:");
}

function truncate(value: string, limit = 48): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}...`;
}

/** Renders findings the way compilers do, so editors and agents can jump straight to them. */
export function formatFindings(result: LintResult): string {
	if (result.findings.length === 0) {
		return `${result.file}: clean`;
	}
	return result.findings
		.map((finding) => {
			const head = `${result.file}:${finding.line}:${finding.column}: ${finding.severity} [${finding.rule}] ${finding.message}`;
			return finding.fix === undefined ? head : `${head}\n    fix: ${finding.fix}`;
		})
		.join("\n");
}
