import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

import { findAction, type Manifest } from "../plugin/manifest.js";
import { lintSvg } from "../render/svg-tiny.js";
import { ActionInstance } from "./action.js";
import { type Device, newIdentifier } from "./device.js";
import {
	type AppearPayload,
	type Controller,
	type Coordinates,
	type Frame,
	isPluginCommand,
	isUiCommand,
	type JsonObject,
	type JsonValue,
	REGISTER_PLUGIN,
	REGISTER_PROPERTY_INSPECTOR,
	type RegistrationInfo,
} from "./protocol.js";
import { Recorder } from "./recorder.js";
import { SettingsStore } from "./stores.js";

export type AddActionOptions = {
	uuid: string;
	device?: Device;
	coordinates?: Coordinates;
	controller?: Controller;
	settings?: JsonObject;
	state?: number;
	title?: string;
	isInMultiAction?: boolean;
	/** When false the instance is created but no `willAppear` is sent yet. */
	appear?: boolean;
};

/**
 * A mock Stream Deck backend: one WebSocket server that speaks the plugin protocol on one
 * side and the property inspector protocol on the other, with the host owning device
 * state and settings exactly as the real application does.
 */
export class MockStreamDeck extends EventEmitter {
	public readonly devices: Device[];
	public readonly pluginUuid = newIdentifier();

	public readonly recorder = new Recorder();

	public readonly settings = new SettingsStore();

	readonly #manifest: Manifest;
	readonly #info: RegistrationInfo;
	readonly #actions = new Map<string, ActionInstance>();
	readonly #uiSockets = new Map<string, WebSocket>();
	/** Payloads already linted, so a plugin redrawing a key 60x a second is linted once. */
	readonly #lintedImages = new Set<string>();

	#server: WebSocketServer | undefined;
	#pluginSocket: WebSocket | undefined;
	#port = 0;
	#registered: Promise<void>;
	#resolveRegistered!: () => void;
	#rejectRegistered!: (reason: Error) => void;

	constructor(options: { manifest: Manifest; info: RegistrationInfo; devices: Device[] }) {
		super();
		this.#manifest = options.manifest;
		this.#info = options.info;
		this.devices = options.devices;
		this.#registered = new Promise((resolve, reject) => {
			this.#resolveRegistered = resolve;
			this.#rejectRegistered = reject;
		});
	}

	public get defaultDevice(): Device {
		const device = this.devices[0];
		if (device === undefined) {
			throw new Error("no emulated devices configured");
		}
		return device;
	}

	public get info(): RegistrationInfo {
		return this.#info;
	}

	public get pluginConnected(): boolean {
		return this.#pluginSocket !== undefined;
	}

	public get port(): number {
		return this.#port;
	}

	public action(context: string): ActionInstance {
		const instance = this.#actions.get(context);
		if (instance === undefined) {
			throw new Error(`no action instance with context ${context}`);
		}
		return instance;
	}

	// ---------------------------------------------------------------- device driving

	public addAction(options: AddActionOptions): ActionInstance {
		const definition = findAction(this.#manifest, options.uuid);
		const device = options.device ?? this.defaultDevice;
		const controller = options.controller ?? definition.Controllers?.[0] ?? "Keypad";
		const isInMultiAction = options.isInMultiAction ?? false;
		const coordinates = isInMultiAction ? undefined : (options.coordinates ?? this.#nextFreeSlot(device));

		if (coordinates !== undefined && !device.contains(coordinates.column, coordinates.row)) {
			throw new Error(
				`coordinates ${coordinates.column},${coordinates.row} are outside ${device.info.name} (${device.columns}x${device.rows})`,
			);
		}

		const instance = new ActionInstance({
			context: newIdentifier(),
			uuid: options.uuid,
			device,
			controller,
			coordinates,
			isInMultiAction,
			definition,
			title: options.title ?? "",
			state: options.state ?? 0,
		});

		this.#actions.set(instance.context, instance);
		this.settings.set(instance.context, options.settings ?? {});

		if (options.appear !== false) {
			this.appear(instance);
		}
		return instance;
	}

	public allActions(): ActionInstance[] {
		return [...this.#actions.values()];
	}

	public appear(instance: ActionInstance): void {
		instance.visible = true;
		instance.disappearedAtSeq = undefined;
		this.#sendToPlugin({
			event: "willAppear",
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			payload: this.#appearPayload(instance) as unknown as JsonValue,
		});
		// The real app emits titleParametersDidChange immediately after willAppear.
		this.#emitTitleParameters(instance);
	}

	public async close(): Promise<void> {
		for (const socket of this.#uiSockets.values()) {
			socket.close();
		}
		this.#uiSockets.clear();
		this.#pluginSocket?.close();
		this.#pluginSocket = undefined;

		const server = this.#server;
		if (server === undefined) {
			return;
		}
		this.#server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	public disappear(instance: ActionInstance): void {
		if (!instance.visible) {
			return;
		}
		instance.visible = false;
		this.#sendToPlugin({
			event: "willDisappear",
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			payload: this.#appearPayload(instance) as unknown as JsonValue,
		});
		instance.disappearedAtSeq = this.recorder.nextSeq;
	}

	public failRegistration(reason: Error): void {
		this.#rejectRegistered(reason);
	}

	public findByUuid(uuid: string): ActionInstance[] {
		return this.allActions().filter((instance) => instance.uuid === uuid);
	}

	public hasUi(context: string): boolean {
		return this.#uiSockets.has(context);
	}

	public keyDown(instance: ActionInstance, userDesiredState?: number): void {
		this.#sendToPlugin({
			event: "keyDown",
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			payload: {
				...this.#appearPayload(instance),
				...(userDesiredState === undefined ? {} : { userDesiredState }),
			} as unknown as JsonValue,
		});
	}

	public keyUp(instance: ActionInstance, userDesiredState?: number): void {
		this.#sendToPlugin({
			event: "keyUp",
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			payload: {
				...this.#appearPayload(instance),
				...(userDesiredState === undefined ? {} : { userDesiredState }),
			} as unknown as JsonValue,
		});
	}

	public async listen(): Promise<number> {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		this.#server = server;

		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});

		this.#port = (server.address() as AddressInfo).port;
		server.on("connection", (socket) => this.#onConnection(socket));
		return this.#port;
	}

	public propertyInspectorDidDisappear(instance: ActionInstance): void {
		this.#sendToPlugin({
			event: "propertyInspectorDidDisappear",
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
		});
	}

	public pushGlobalSettings(settings: JsonObject): void {
		this.settings.setGlobal(settings);
		this.#sendToPlugin(globalSettingsFrame(this.settings.getGlobal()));
	}

	public pushSecrets(secrets: JsonObject): void {
		this.settings.setSecrets(secrets);
		this.#sendToPlugin({ event: "didReceiveSecrets", payload: { secrets: this.settings.getSecrets() } });
	}

	/** Pushes settings from the harness, as if the user edited them in the property inspector. */
	public pushSettings(instance: ActionInstance, settings: JsonObject): void {
		this.settings.set(instance.context, settings);
		this.#sendToPlugin(this.#settingsFrame("didReceiveSettings", instance));
	}

	public removeAction(instance: ActionInstance): void {
		this.disappear(instance);
		const socket = this.#uiSockets.get(instance.context);
		if (socket !== undefined) {
			socket.close();
			this.#uiSockets.delete(instance.context);
		}
		this.#actions.delete(instance.context);
		this.settings.forget(instance.context);
	}

	/** Sends an arbitrary event to the plugin; used by the scenario runner for system events. */
	public sendRaw(frame: Frame): void {
		this.#sendToPlugin(frame);
	}

	/** Resolves once the plugin has completed the `registerPlugin` handshake. */
	public async waitForPlugin(timeoutMs: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`plugin did not register within ${timeoutMs}ms`)), timeoutMs);
		});
		try {
			await Promise.race([this.#registered, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	// ---------------------------------------------------------------- connections

	#onConnection(socket: WebSocket): void {
		socket.once("message", (raw) => {
			let frame: Frame;
			try {
				frame = JSON.parse(String(raw)) as Frame;
			} catch {
				this.recorder.violation("bad-registration", `registration frame is not JSON: ${String(raw).slice(0, 200)}`);
				socket.close();
				return;
			}

			if (frame.event === REGISTER_PLUGIN) {
				this.#attachPlugin(socket, frame);
			} else if (frame.event === REGISTER_PROPERTY_INSPECTOR) {
				this.#attachUi(socket, frame);
			} else {
				this.recorder.violation("bad-registration", `first frame was "${frame.event}", expected a register event`);
				socket.close();
			}
		});
	}

	#attachPlugin(socket: WebSocket, frame: Frame): void {
		if (frame.uuid !== this.pluginUuid) {
			this.recorder.violation(
				"bad-registration",
				`plugin registered with uuid ${String(frame.uuid)}, expected ${this.pluginUuid}`,
			);
		}

		this.#pluginSocket = socket;
		this.recorder.record("from-plugin", frame);

		socket.on("message", (raw) => this.#onPluginMessage(String(raw)));
		socket.on("close", () => {
			this.#pluginSocket = undefined;
			this.emit("plugin-disconnected");
		});

		this.#resolveRegistered();
		this.emit("plugin-registered");

		// The real app announces devices immediately after the handshake.
		for (const device of this.devices) {
			this.#sendToPlugin({
				event: "deviceDidConnect",
				device: device.id,
				deviceInfo: device.info as unknown as JsonValue,
			});
		}
	}

	#attachUi(socket: WebSocket, frame: Frame): void {
		const context = typeof frame.uuid === "string" ? frame.uuid : "";
		if (!this.#actions.has(context)) {
			this.recorder.violation("bad-registration", `property inspector registered for unknown context ${context}`);
		}

		this.#uiSockets.set(context, socket);
		this.recorder.record("from-pi", frame);

		socket.on("message", (raw) => this.#onUiMessage(context, String(raw)));
		socket.on("close", () => {
			if (this.#uiSockets.get(context) === socket) {
				this.#uiSockets.delete(context);
			}
		});

		const instance = this.#actions.get(context);
		if (instance !== undefined) {
			this.#sendToPlugin({
				event: "propertyInspectorDidAppear",
				action: instance.uuid,
				context,
				device: instance.device.id,
			});
		}
		this.emit("pi-registered", context);
	}

	// ---------------------------------------------------------------- outbound

	#sendToPlugin(frame: Frame): void {
		this.recorder.record("to-plugin", frame);
		this.#pluginSocket?.send(JSON.stringify(frame));
	}

	#sendToUi(context: string, frame: Frame): void {
		const socket = this.#uiSockets.get(context);
		this.recorder.record("to-pi", frame);
		socket?.send(JSON.stringify(frame));
	}

	// ---------------------------------------------------------------- plugin commands

	#onPluginMessage(raw: string): void {
		let frame: Frame;
		try {
			frame = JSON.parse(raw) as Frame;
		} catch {
			this.recorder.violation("bad-frame", `plugin sent non-JSON: ${raw.slice(0, 200)}`);
			return;
		}

		const entry = this.recorder.record("from-plugin", frame);
		if (!isPluginCommand(frame.event)) {
			this.recorder.violation("unknown-command", `plugin sent unrecognised command "${frame.event}"`, {
				detail: frame,
			});
			return;
		}

		const context = typeof frame.context === "string" ? frame.context : undefined;
		const instance = context === undefined ? undefined : this.#actions.get(context);
		const payload = (frame.payload ?? {}) as JsonObject;

		// A command naming a context that has already disappeared is the primary
		// language-agnostic leak signal, so flag it here rather than only in the check.
		if (
			instance !== undefined &&
			!instance.visible &&
			instance.disappearedAtSeq !== undefined &&
			isVisualCommand(frame.event)
		) {
			this.recorder.violation(
				"after-disappear",
				`plugin sent "${frame.event}" for context ${context} after willDisappear`,
				{
					context,
					action: instance.uuid,
					detail: { commandSeq: entry.seq, disappearedAtSeq: instance.disappearedAtSeq },
				},
			);
		}

		switch (frame.event) {
			case "getSettings":
				if (instance !== undefined) {
					this.#sendToPlugin(this.#settingsFrame("didReceiveSettings", instance, frame.id));
				}
				break;
			case "setSettings":
				if (context !== undefined) {
					this.settings.set(context, payload);
					// Real Stream Deck notifies the *other* side only.
					if (this.#uiSockets.has(context) && instance !== undefined) {
						this.#sendToUi(context, this.#settingsFrame("didReceiveSettings", instance));
					}
				}
				break;
			case "getGlobalSettings":
				this.#sendToPlugin(globalSettingsFrame(this.settings.getGlobal(), frame.id));
				break;
			case "setGlobalSettings":
				this.settings.setGlobal(payload);
				for (const uiContext of this.#uiSockets.keys()) {
					this.#sendToUi(uiContext, globalSettingsFrame(this.settings.getGlobal()));
				}
				break;
			case "getSecrets":
				this.#sendToPlugin({
					event: "didReceiveSecrets",
					...(frame.id === undefined ? {} : { id: frame.id }),
					payload: { secrets: this.settings.getSecrets() },
				});
				break;
			case "getResources":
				if (instance !== undefined) {
					this.#sendToPlugin(this.#settingsFrame("didReceiveResources", instance, frame.id));
				}
				break;
			case "setResources":
				if (context !== undefined) {
					this.settings.setResources(context, payload);
					if (this.#uiSockets.has(context) && instance !== undefined) {
						this.#sendToUi(context, this.#settingsFrame("didReceiveResources", instance));
					}
				}
				break;
			case "setTitle":
				this.#applyTitle(instance, payload);
				break;
			case "setImage":
				this.#applyImage(instance, payload);
				break;
			case "setState":
				this.#applyState(instance, payload);
				break;
			case "showAlert":
			case "showOk":
				instance?.flashes.push({ kind: frame.event === "showAlert" ? "alert" : "ok", at: entry.at });
				break;
			case "sendToPropertyInspector":
				if (context !== undefined && instance !== undefined) {
					this.#sendToUi(context, {
						event: "sendToPropertyInspector",
						action: instance.uuid,
						context,
						payload: frame.payload ?? null,
					});
				}
				break;
			default:
				// openUrl, logMessage, switchToProfile, setTriggerDescription, setFeedback,
				// setFeedbackLayout: recorded above, inert here.
				break;
		}

		this.emit("plugin-command", entry);
	}

	#applyTitle(instance: ActionInstance | undefined, payload: JsonObject): void {
		if (instance === undefined) {
			return;
		}
		const title = typeof payload.title === "string" ? payload.title : "";
		const state = typeof payload.state === "number" ? payload.state : undefined;

		if (state === undefined) {
			instance.title = title;
			instance.titleByState.clear();
		} else {
			instance.titleByState.set(state, title);
		}
		this.#emitTitleParameters(instance);
	}

	#applyImage(instance: ActionInstance | undefined, payload: JsonObject): void {
		if (instance === undefined) {
			return;
		}
		const image = typeof payload.image === "string" && payload.image.length > 0 ? payload.image : undefined;
		const target = (typeof payload.target === "number" ? payload.target : 0) as 0 | 1 | 2;
		const state = typeof payload.state === "number" ? payload.state : undefined;

		if (image !== undefined) {
			this.#lintImagePayload(instance, image);
		}

		if (state === undefined) {
			if (image === undefined) {
				instance.imageByState.clear();
			} else {
				for (let index = 0; index < instance.stateCount; index++) {
					instance.imageByState.set(index, { image, target, state: undefined });
				}
			}
			return;
		}

		if (image === undefined) {
			instance.imageByState.delete(state);
		} else {
			instance.imageByState.set(state, { image, target, state });
		}
	}

	/**
	 * Lints inline SVG sent through `setImage`. Chromium will render constructs Stream Deck
	 * silently drops, so the screenshot alone would not reveal the problem.
	 */
	#lintImagePayload(instance: ActionInstance, image: string): void {
		const match = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(image);
		if (match === null) {
			return;
		}

		const key = `${image.length}:${image.slice(0, 64)}:${image.slice(-64)}`;
		if (this.#lintedImages.has(key)) {
			return;
		}
		this.#lintedImages.add(key);

		const body = match[2] ?? "";
		const svg = match[1] === undefined ? decodeURIComponent(body) : Buffer.from(body, "base64").toString("utf8");
		const result = lintSvg(svg, `setImage(${instance.uuid})`);

		for (const finding of result.findings) {
			if (finding.severity !== "error") {
				continue;
			}
			this.recorder.violation("svg-tiny", `${finding.rule}: ${finding.message}`, {
				context: instance.context,
				action: instance.uuid,
				detail: { line: finding.line, column: finding.column, fix: finding.fix },
			});
		}
	}

	#applyState(instance: ActionInstance | undefined, payload: JsonObject): void {
		if (instance === undefined) {
			return;
		}
		const state = typeof payload.state === "number" ? payload.state : 0;
		if (state < 0 || state >= instance.stateCount) {
			this.recorder.violation(
				"state-out-of-range",
				`setState(${state}) but ${instance.uuid} declares ${instance.stateCount} state(s) in manifest.json`,
				{ context: instance.context, action: instance.uuid },
			);
			return;
		}
		instance.state = state;
		this.#emitTitleParameters(instance);
	}

	// ---------------------------------------------------------------- ui commands

	#onUiMessage(context: string, raw: string): void {
		let frame: Frame;
		try {
			frame = JSON.parse(raw) as Frame;
		} catch {
			this.recorder.violation("bad-frame", `property inspector sent non-JSON: ${raw.slice(0, 200)}`);
			return;
		}

		const entry = this.recorder.record("from-pi", frame);
		if (!isUiCommand(frame.event)) {
			this.recorder.violation("unknown-command", `property inspector sent unrecognised command "${frame.event}"`, {
				detail: frame,
			});
			return;
		}

		const instance = this.#actions.get(context);
		const payload = (frame.payload ?? {}) as JsonObject;

		switch (frame.event) {
			case "getSettings":
				if (instance !== undefined) {
					this.#sendToUi(context, this.#settingsFrame("didReceiveSettings", instance, frame.id));
				}
				break;
			case "setSettings":
				this.settings.set(context, payload);
				if (instance !== undefined) {
					this.#sendToPlugin(this.#settingsFrame("didReceiveSettings", instance));
				}
				break;
			case "getGlobalSettings":
				this.#sendToUi(context, globalSettingsFrame(this.settings.getGlobal(), frame.id));
				break;
			case "setGlobalSettings":
				this.settings.setGlobal(payload);
				this.#sendToPlugin(globalSettingsFrame(this.settings.getGlobal()));
				break;
			case "getResources":
				if (instance !== undefined) {
					this.#sendToUi(context, this.#settingsFrame("didReceiveResources", instance, frame.id));
				}
				break;
			case "setResources":
				this.settings.setResources(context, payload);
				if (instance !== undefined) {
					this.#sendToPlugin(this.#settingsFrame("didReceiveResources", instance));
				}
				break;
			case "sendToPlugin":
				if (instance !== undefined) {
					this.#sendToPlugin({
						event: "sendToPlugin",
						action: instance.uuid,
						context,
						payload: frame.payload ?? null,
					});
				}
				break;
			default:
				// openUrl: recorded, inert.
				break;
		}

		this.emit("ui-command", entry);
	}

	// ---------------------------------------------------------------- helpers

	#nextFreeSlot(device: Device): Coordinates {
		const taken = new Set(
			this.allActions()
				.filter((instance) => instance.device === device && instance.coordinates !== undefined)
				.map((instance) => `${instance.coordinates!.column},${instance.coordinates!.row}`),
		);

		for (let row = 0; row < device.rows; row++) {
			for (let column = 0; column < device.columns; column++) {
				if (!taken.has(`${column},${row}`)) {
					return { column, row };
				}
			}
		}
		throw new Error(`${device.info.name} is full (${device.columns}x${device.rows})`);
	}

	#appearPayload(instance: ActionInstance): AppearPayload {
		return {
			controller: instance.controller,
			...(instance.coordinates === undefined ? {} : { coordinates: instance.coordinates }),
			isInMultiAction: instance.isInMultiAction,
			resources: this.settings.getResources(instance.context),
			settings: this.settings.get(instance.context),
			// Stream Deck omits `state` for single-state actions; matched against a real transcript.
			...(instance.stateCount > 1 ? { state: instance.state } : {}),
		};
	}

	#settingsFrame(event: "didReceiveResources" | "didReceiveSettings", instance: ActionInstance, id?: string): Frame {
		return {
			event,
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			...(id === undefined ? {} : { id }),
			payload: this.#appearPayload(instance) as unknown as JsonValue,
		};
	}

	#emitTitleParameters(instance: ActionInstance): void {
		if (!instance.visible) {
			return;
		}
		this.#sendToPlugin({
			event: "titleParametersDidChange",
			action: instance.uuid,
			context: instance.context,
			device: instance.device.id,
			payload: {
				...this.#appearPayload(instance),
				state: instance.state,
				title: instance.effectiveTitle,
				titleParameters: instance.titleParameters,
			} as unknown as JsonValue,
		});
	}
}

function globalSettingsFrame(settings: JsonObject, id?: string): Frame {
	return {
		event: "didReceiveGlobalSettings",
		...(id === undefined ? {} : { id }),
		payload: { settings },
	};
}

/** Commands that only make sense while a key is on screen. */
function isVisualCommand(event: string): boolean {
	return (
		event === "setImage" ||
		event === "setTitle" ||
		event === "setState" ||
		event === "showAlert" ||
		event === "showOk" ||
		event === "setFeedback"
	);
}
