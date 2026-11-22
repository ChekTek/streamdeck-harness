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

/** Default width of the property inspector. This is an estimate of the Stream Deck panel. */
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

/** A headless property inspector. Only one is open at a time. */
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

		let page: Page;
		try {
			const browser = await getBrowser();
			page = await browser.newPage({
				viewport: { width: options.width ?? DEFAULT_PI_WIDTH, height: options.height ?? DEFAULT_PI_HEIGHT },
				deviceScaleFactor: 1,
				colorScheme: "dark",
			});
		} catch (cause) {
			await server.close();
			throw cause;
		}

		const inspector = new Inspector({ context: instance.context, url, page, server });
		page.on("console", (message) => inspector.consoleLines.push({ type: message.type(), text: message.text() }));
		page.on("pageerror", (error) => inspector.pageErrors.push(error.message));

		try {
			await page.addInitScript(bootstrapScript(options.hostPort, instance.context, options.info, actionInfo));
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

	/** Lists the SDPI components that have a `setting` attribute, with their values. */
	public async fields(): Promise<JsonObject[]> {
		const rows = await this.#page.evaluate(() => {
			type SdpiHost = HTMLElement & { disabled?: boolean; value?: boolean | number | string | null };
			return [...document.querySelectorAll("[setting]")].map((element) => {
				const item = element.closest("sdpi-item");
				// SAFETY: SDPI elements have `value` and `disabled`. lib.dom does not declare them.
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
	 * Sets an SDPI component by its `setting` attribute. It changes the inner control, so the
	 * change handlers of the page run.
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

				// SAFETY: SDPI elements have value, focusElement and updateComplete.
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

	/** Waits until the page connects to the host. Returns false after `timeoutMs`. */
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
 * Script that runs before the page scripts. SDPI replaces `connectElgatoStreamDeckSocket`,
 * so an accessor calls the new function when the page assigns it.
 */
function bootstrapScript(hostPort: number, uuid: string, info: RegistrationInfo, actionInfo: JsonObject): string {
	const args = [String(hostPort), uuid, "registerPropertyInspector", JSON.stringify(info), JSON.stringify(actionInfo)];

	return `(() => {
  const args = ${JSON.stringify(args)};
  const colors = ${JSON.stringify(info.colors)};
  let implementation;
  let invoked = false;

  const failed = (error) => {
    window.__sdtestConnectError = String(error);
    console.error("connectElgatoStreamDeckSocket failed: " + String(error));
  };

  const invoke = () => {
    if (invoked || implementation == null) return;
    invoked = true;
    try {
      const result = implementation(...args);
      Promise.resolve(result).then(() => { window.__sdtestConnected = true; }, failed);
    } catch (error) {
      failed(error);
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

  // Apply the Stream Deck theme colours to the page.
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
