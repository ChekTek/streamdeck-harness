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
import type { UiTraffic } from "../host/ws-server.js";
import type { PluginProject } from "../plugin/manifest.js";
import { getBrowser } from "../render/chromium.js";
import { StaticServer } from "./static-server.js";

/** Default width of the property inspector. This is an estimate of the Stream Deck panel. */
export const DEFAULT_PI_WIDTH = 345;
export const DEFAULT_PI_HEIGHT = 600;

/** The characters that need the Shift key on a US keyboard. */
const US_SHIFT_CHARACTERS = '~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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

export type TypeOptions = {
	/** Deletes the current value with Backspace first. Default: true. When false, the text goes at the end. */
	clear?: boolean;
	/** Inserts the text with one clipboard paste and not key by key. */
	paste?: boolean;
	/** Moves the focus out of the field after the text, so `change` fires. */
	blur?: boolean;
};

declare global {
	interface Window {
		__sdtestConnected?: boolean;
		__sdtestTraffic?: UiTraffic;
	}
}

/** Time between two readiness checks, in milliseconds. */
const READY_POLL_MS = 10;

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
	 * Sets an SDPI component by its `setting` attribute. It assigns the value of the inner
	 * control and dispatches `input` and `change`. No key events fire.
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

	/**
	 * Types into the text field of an SDPI component with real keyboard input on a US keyboard
	 * layout. Each character sends `keydown`, `keypress`, `beforeinput`, `input` and `keyup`. Shift
	 * is held for a character that needs it. A character that has no key on a US keyboard sends
	 * only `beforeinput` and `input`.
	 */
	public async typeField(setting: string, text: string, options: TypeOptions = {}): Promise<JsonObject> {
		const focused = await this.#page.evaluate(
			async ({ setting: name, clear }: PiTypeArg) => {
				type SdpiHost = HTMLElement & {
					focusElement?: HTMLElement | { value?: HTMLElement };
					updateComplete?: Promise<boolean>;
				};

				const node = document.querySelector(`[setting="${name}"]`);
				if (node === null) {
					const known = [...document.querySelectorAll("[setting]")].map((candidate) => candidate.getAttribute("setting"));
					return {
						ok: false as const,
						error: `no component with setting="${name}". Present: ${known.join(", ") || "(none)"}`,
					};
				}

				// SAFETY: SDPI elements have focusElement and updateComplete.
				const element = node as SdpiHost;
				await element.updateComplete?.catch(() => undefined);

				const ref = element.focusElement;
				const inner = ref instanceof HTMLElement ? ref : (ref?.value ?? undefined);
				const isTextField =
					inner instanceof HTMLTextAreaElement ||
					(inner instanceof HTMLInputElement && ["text", "search", "url", "tel", "password"].includes(inner.type));
				if (!isTextField) {
					return { ok: false as const, error: `"${name}" is not a text field. Use pi-set for it.` };
				}

				if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
					return { ok: false as const, error: `"${name}" is hidden.` };
				}

				inner.focus();
				if (!inner.matches(":focus")) {
					return { ok: false as const, error: `"${name}" cannot take focus. It is hidden or disabled.` };
				}
				inner.setSelectionRange(clear ? 0 : inner.value.length, inner.value.length);
				return { ok: true as const, hasValue: inner.value !== "" };
			},
			{ setting, clear: options.clear ?? true },
		);
		if (!focused.ok) {
			throw new Error(focused.error);
		}

		const keyboard = this.#page.keyboard;
		if ((options.clear ?? true) && focused.hasValue) {
			await keyboard.press("Backspace");
		}
		if (options.paste === true) {
			await this.#paste(text);
		} else {
			for (const character of text) {
				if (US_SHIFT_CHARACTERS.includes(character)) {
					await keyboard.down("Shift");
					await keyboard.press(character);
					await keyboard.up("Shift");
				} else {
					await keyboard.type(character);
				}
			}
		}

		const value = await this.#page.evaluate(
			async ({ setting: name, blur }: PiBlurArg) => {
				type SdpiHost = HTMLElement & {
					updateComplete?: Promise<boolean>;
					value?: boolean | number | string | null;
				};

				if (blur) {
					let active = document.activeElement;
					while (active?.shadowRoot?.activeElement) {
						active = active.shadowRoot.activeElement;
					}
					if (active instanceof HTMLElement) {
						active.blur();
					}
				}

				// SAFETY: SDPI elements have value and updateComplete.
				const element = document.querySelector(`[setting="${name}"]`) as SdpiHost | null;
				await element?.updateComplete?.catch(() => undefined);
				return element?.value ?? null;
			},
			{ setting, blur: options.blur ?? false },
		);
		return compactJson({ setting, value });
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

	/**
	 * Waits until the page is ready: it registered with the host, no frame is in flight between
	 * them, each component with a `setting` attribute completed its update, and the body is
	 * visible. `hostTraffic` reads the frame counts of the host. Returns undefined when the page
	 * is ready, or what it still waits for after `timeoutMs`.
	 */
	public async waitForReady(hostTraffic: () => UiTraffic | undefined, timeoutMs: number): Promise<string | undefined> {
		const deadline = Date.now() + timeoutMs;
		let confirmed = false;
		for (;;) {
			let blocker: string | undefined;
			try {
				const readiness = await this.#readReadiness(Math.max(deadline - Date.now(), 0));
				blocker = blockerOf(readiness, hostTraffic());
			} catch (cause) {
				if (!errorMessage(cause).includes("Execution context was destroyed")) {
					throw cause;
				}
				blocker = "the page navigated";
			}
			if (blocker === undefined && confirmed) {
				return undefined;
			}
			if (blocker !== undefined && Date.now() >= deadline) {
				return blocker;
			}
			confirmed = blocker === undefined;
			if (!confirmed) {
				await new Promise((done) => setTimeout(done, READY_POLL_MS));
			}
		}
	}

	/**
	 * Pastes `text` into the focused field through the clipboard of the headless browser. The
	 * field gets `paste`, then `beforeinput` and `input` with the input type `insertFromPaste`.
	 */
	async #paste(text: string): Promise<void> {
		const context = this.#page.context();
		await context.grantPermissions(["clipboard-write"], { origin: this.#server.origin });
		try {
			await this.#page.evaluate(async (data) => navigator.clipboard.writeText(data), text);
		} finally {
			await context.clearPermissions();
		}
		await this.#page.keyboard.press("ControlOrMeta+v");
	}

	/** Reads the readiness state of the page. Waits at most `budgetMs` for the component updates. */
	async #readReadiness(budgetMs: number): Promise<PageReadiness> {
		return this.#page.evaluate(async (budget) => {
			type SdpiHost = Element & { updateComplete?: Promise<boolean> };
			const bound = [...document.querySelectorAll("[setting]")];
			const updates = await Promise.race([
				// SAFETY: SDPI elements have updateComplete. lib.dom does not declare it.
				Promise.allSettled(bound.map((element) => (element as SdpiHost).updateComplete)),
				new Promise<false>((done) => setTimeout(done, budget, false)),
			]);
			const updatesComplete = updates !== false && updates.every(({ status }) => status === "fulfilled");
			return {
				connected: window.__sdtestConnected === true,
				traffic: window.__sdtestTraffic ?? { received: 0, sent: 0 },
				undefinedTags: bound.filter((element) => !element.matches(":defined")).map((element) => element.localName),
				updatesComplete,
				visible: document.body?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false,
			};
		}, budgetMs);
	}
}

/** Tells what the page still waits for. Returns undefined when it is ready. */
function blockerOf(state: PageReadiness, hostTraffic: UiTraffic | undefined): string | undefined {
	if (!state.connected) {
		return "the page did not call connectElgatoStreamDeckSocket";
	}
	if (hostTraffic === undefined) {
		return "the page did not register with the host";
	}
	if (state.traffic.sent !== hostTraffic.received || state.traffic.received !== hostTraffic.sent) {
		return "frames are in flight between the page and the host";
	}
	if (state.undefinedTags.length > 0) {
		return `custom elements are not defined: ${[...new Set(state.undefinedTags)].join(", ")}`;
	}
	if (!state.updatesComplete) {
		return "a component with a setting attribute did not complete its update";
	}
	if (!state.visible) {
		return "the page body is hidden";
	}
	return undefined;
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

  // Count the frames on the socket to the host. The harness compares them with the counts of the host.
  const traffic = (window.__sdtestTraffic = { received: 0, sent: 0 });
  const send = WebSocket.prototype.send;
  let hostSocket;
  WebSocket.prototype.send = function (data) {
    send.call(this, data);
    const url = new URL(this.url);
    if (url.port !== args[0] || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
    if (hostSocket !== this) {
      hostSocket = this;
      traffic.received = 0;
      traffic.sent = 0;
      this.addEventListener("message", () => { if (hostSocket === this) traffic.received++; });
    }
    traffic.sent++;
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

type PageReadiness = {
	connected: boolean;
	traffic: UiTraffic;
	undefinedTags: string[];
	updatesComplete: boolean;
	visible: boolean;
};

type PiFieldArg = {
	setting: string;
	value: boolean | number | string | null;
};

type PiTypeArg = {
	setting: string;
	clear: boolean;
};

type PiBlurArg = {
	setting: string;
	blur: boolean;
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
