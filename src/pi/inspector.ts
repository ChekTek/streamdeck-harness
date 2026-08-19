import { join } from "node:path";
import type { Page } from "playwright";

import type { ActionInstance } from "../host/action.js";
import {
	compactJson,
	errorMessage,
	isJsonObject,
	type JsonObject,
	type JsonValue,
	type RegistrationInfo,
} from "../host/protocol.js";
import type { PluginProject } from "../plugin/manifest.js";
import { getBrowser } from "../render/chromium.js";
import { StaticServer } from "./static-server.js";

/**
 * Width of the property inspector panel. Stream Deck renders the PI inside a fixed-width
 * QtWebEngine view; this is an approximation and is configurable per screenshot.
 */
export const DEFAULT_PI_WIDTH = 345;
export const DEFAULT_PI_HEIGHT = 600;

export type OpenOptions = {
	project: PluginProject;
	instance: ActionInstance;
	info: RegistrationInfo;
	settings: JsonObject;
	hostPort: number;
	width?: number;
	height?: number;
};

export type ConsoleLine = { type: string; text: string };

/**
 * A property inspector rendered headlessly. One at a time, like the real application, which
 * only ever shows the PI of the selected key.
 */
export class Inspector {
	public readonly consoleLines: ConsoleLine[] = [];

	public readonly context: string;
	public readonly pageErrors: string[] = [];

	public readonly url: string;

	readonly #page: Page;
	readonly #server: StaticServer;

	private constructor(options: { context: string; url: string; page: Page; server: StaticServer }) {
		this.context = options.context;
		this.url = options.url;
		this.#page = options.page;
		this.#server = options.server;
	}

	public get page(): Page {
		return this.#page;
	}

	public static async open(options: OpenOptions): Promise<Inspector> {
		const { project, instance } = options;
		const relative = instance.definition.PropertyInspectorPath ?? project.manifest.PropertyInspectorPath;
		if (relative === undefined) {
			throw new Error(`${instance.uuid} declares no PropertyInspectorPath in manifest.json`);
		}

		const server = new StaticServer(project.root);
		await server.listen();
		const url = `${server.origin}/${relative.replace(/^\.?\//, "")}`;

		const payload = compactJson({
			controller: instance.controller,
			isInMultiAction: instance.isInMultiAction,
			settings: options.settings,
			state: instance.state,
		});
		if (instance.coordinates !== undefined) {
			payload.coordinates = compactJson({
				column: instance.coordinates.column,
				row: instance.coordinates.row,
			});
		}
		const actionInfo = compactJson({
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			payload,
		});

		const browser = await getBrowser();
		const page = await browser.newPage({
			viewport: { width: options.width ?? DEFAULT_PI_WIDTH, height: options.height ?? DEFAULT_PI_HEIGHT },
			deviceScaleFactor: 1,
			colorScheme: "dark",
		});

		const inspector = new Inspector({ context: instance.context, url, page, server });
		page.on("console", (message) => inspector.consoleLines.push({ type: message.type(), text: message.text() }));
		page.on("pageerror", (error) => inspector.pageErrors.push(error.message));

		await page.addInitScript(bootstrapScript(options.hostPort, instance.context, options.info, actionInfo));

		try {
			await page.goto(url, { waitUntil: "domcontentloaded" });
		} catch (cause) {
			await inspector.close();
			throw new Error(`could not load ${url}: ${errorMessage(cause)}`);
		}
		return inspector;
	}

	public async click(target: string): Promise<void> {
		const locator =
			target.startsWith("#") || target.startsWith(".") || target.includes("[")
				? this.#page.locator(target)
				: this.#page.getByText(target, { exact: false });
		await locator.first().click({ timeout: 5000 });
	}

	public async close(): Promise<void> {
		await this.#page.close().catch(() => undefined);
		await this.#server.close();
	}

	/**
	 * Lists the SDPI components on the page by their `setting` attribute, with the value and
	 * visibility each currently has. Components live in shadow roots, so this reads them from
	 * inside the page rather than through the accessibility tree.
	 */
	public async fields(): Promise<JsonObject[]> {
		const rows = await this.#page.evaluate(() => {
			type SdpiHost = HTMLElement & { disabled?: boolean; value?: boolean | number | string | null };
			return [...document.querySelectorAll("[setting]")].map((element) => {
				const item = element.closest("sdpi-item");
				// SAFETY: SDPI custom elements publish `value` and `disabled` on the host; lib.dom does not.
				const host = element as SdpiHost;
				return {
					setting: element.getAttribute("setting"),
					tag: element.tagName.toLowerCase(),
					label: item?.getAttribute("label") ?? null,
					title: item?.getAttribute("title") ?? null,
					global: element.getAttribute("global") === "true" || element.hasAttribute("global"),
					value: host.value ?? null,
					visible: host.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
					disabled: host.disabled ?? false,
				};
			});
		});
		return rows.map((row) =>
			compactJson({
				setting: row.setting,
				tag: row.tag,
				label: row.label,
				title: row.title,
				global: row.global,
				value: row.value,
				visible: row.visible,
				disabled: row.disabled,
			}),
		);
	}

	public async screenshot(directory: string, stem: string, fullPage = true): Promise<string> {
		const path = join(directory, `${stem}.png`);
		await this.#page.screenshot({ path, fullPage });
		return path;
	}

	/**
	 * Writes a value into an SDPI component by its `setting` attribute. Setting `.value` is
	 * what the component's own bindings observe; typing into the shadow DOM is unreliable.
	 */
	/**
	 * Writes a value into an SDPI component by its `setting` attribute, driving the inner
	 * control the way a user would. SDPI exposes `focusElement` as a Lit ref (`{ value }`),
	 * not an element, and page code commonly listens on that inner control -- so setting the
	 * custom element's `value` alone would save the setting without running the page's own
	 * change handlers.
	 */
	public async setField(setting: string, value: JsonValue): Promise<JsonObject> {
		const result = await this.#page.evaluate(
			async ({ setting: name, value: next }: PiFieldArg) => {
				type SdpiHost = HTMLElement & {
					disabled?: boolean;
					focusElement?: HTMLElement | { value?: HTMLElement };
					updateComplete?: Promise<boolean>;
					value?: boolean | number | string | null;
				};

				const node = document.querySelector(`[setting="${name}"]`);
				if (node === null) {
					const known = [...document.querySelectorAll("[setting]")].map((candidate) => candidate.getAttribute("setting"));
					return {
						ok: false as const,
						error: `no component with setting="${name}". Present: ${known.join(", ") || "(none)"}`,
					};
				}

				// SAFETY: SDPI custom elements publish value/focusElement/updateComplete on the host.
				const element = node as SdpiHost;
				await element.updateComplete?.catch(() => undefined);

				const ref = element.focusElement;
				const inner = ref instanceof HTMLElement ? ref : (ref?.value ?? undefined);

				if (inner instanceof HTMLInputElement && (inner.type === "checkbox" || inner.type === "radio")) {
					inner.checked = Boolean(next);
				} else if (
					inner instanceof HTMLInputElement ||
					inner instanceof HTMLSelectElement ||
					inner instanceof HTMLTextAreaElement
				) {
					inner.value = next === null || next === undefined ? "" : String(next);
				} else if (next === true || next === false) {
					element.value = next;
				} else if (next === null || next === undefined) {
					element.value = null;
				} else {
					element.value = String(next);
				}

				const fire = (target: EventTarget | undefined): void => {
					target?.dispatchEvent(new Event("input", { bubbles: true }));
					target?.dispatchEvent(new Event("change", { bubbles: true }));
				};
				fire(inner);
				fire(element);

				await element.updateComplete?.catch(() => undefined);
				return { ok: true as const, value: element.value ?? null };
			},
			{ setting, value: toPiFieldValue(value) },
		);

		if (!result.ok) {
			throw new Error(result.error);
		}
		return compactJson({ setting, value: result.value });
	}

	public async snapshot(): Promise<string> {
		return this.#page.locator("body").ariaSnapshot();
	}

	/** Resolves once the page has called `connectElgatoStreamDeckSocket`. */
	public async waitForConnect(timeoutMs: number): Promise<boolean> {
		try {
			await this.#page.waitForFunction("window.__sdtestConnected === true", undefined, {
				timeout: timeoutMs,
			});
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Runs before any page script. SDPI's bundle reads any pre-existing
 * `window.connectElgatoStreamDeckSocket` and then assigns its own implementation, so the
 * harness cannot simply define the global up front, and polling for it races page load.
 * Installing an accessor lets the harness call the implementation the instant it appears.
 */
function bootstrapScript(hostPort: number, uuid: string, info: RegistrationInfo, actionInfo: JsonObject): string {
	const args = [String(hostPort), uuid, "registerPropertyInspector", JSON.stringify(info), JSON.stringify(actionInfo)];

	return `(() => {
  const args = ${JSON.stringify(args)};
  const colors = ${JSON.stringify(info.colors)};
  let implementation;
  let invoked = false;

  const invoke = () => {
    if (invoked || implementation == null) return;
    invoked = true;
    try {
      const result = implementation(...args);
      Promise.resolve(result).then(
        () => { window.__sdtestConnected = true; },
        (error) => { window.__sdtestConnectError = String(error); },
      );
      window.__sdtestConnected = true;
    } catch (error) {
      window.__sdtestConnectError = String(error);
    }
  };

  const ready = (fn) => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else queueMicrotask(fn);
  };

  Object.defineProperty(window, "connectElgatoStreamDeckSocket", {
    configurable: true,
    get() { return implementation; },
    set(value) { implementation = value; ready(invoke); },
  });

  // Stream Deck exposes its theme colours to the property inspector; reproduce them so
  // screenshots are not styled against browser defaults.
  ready(() => {
    const style = document.createElement("style");
    style.textContent = ":root {" + Object.entries(colors).map(([k, v]) => "--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + ":" + v).join(";") + "}";
    document.head?.appendChild(style);
  });
})();`;
}

type PiFieldArg = {
	setting: string;
	value: boolean | number | string | null;
};

function toPiFieldValue(value: JsonValue): boolean | number | string | null {
	if (value === null || value === true || value === false) {
		return value;
	}
	if (Array.isArray(value) || isJsonObject(value)) {
		return JSON.stringify(value);
	}
	return value;
}
