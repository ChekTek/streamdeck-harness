/**
 * Stream Deck WebSocket protocol types.
 *
 * Ported from the Rust SDK at ~/Code/streamdeck-rs
 * (`crates/streamdeck-plugin/src/protocol/{events,commands,types}.rs`), which models
 * the SDK v3 surface more completely than the published docs -- including `resources`,
 * `secrets`, and the optional `id` used by experimental message identifiers.
 */

export type JsonValue = JsonValue[] | boolean | number | string | { [key: string]: JsonValue } | null;
export type JsonObject = { [key: string]: JsonValue };

/** Numeric device type as it appears in `RegistrationInfo.devices[].type`. */
export const DeviceTypeCode = {
	StreamDeck: 0,
	StreamDeckMini: 1,
	StreamDeckXL: 2,
	StreamDeckMobile: 3,
	CorsairGKeys: 4,
	StreamDeckPedal: 5,
	CorsairVoyager: 6,
	StreamDeckPlus: 7,
	ScufController: 8,
	StreamDeckNeo: 9,
	StreamDeckStudio: 10,
	VirtualStreamDeck: 11,
	Galleon100Sd: 12,
	StreamDeckPlusXl: 13,
} as const;

export type Controller = "Encoder" | "Keypad";

/** Hardware vs software update target for `setTitle` / `setImage`. */
export type Target = 0 | 1 | 2;

export type Coordinates = {
	column: number;
	row: number;
};

export type Size = {
	columns: number;
	rows: number;
};

export type DeviceInfo = {
	name: string;
	size: Size;
	type: number;
};

export type TitleParameters = {
	fontFamily: string;
	fontSize: number;
	fontStyle: string;
	fontUnderline: boolean;
	showTitle: boolean;
	titleAlignment: string;
	titleColor: string;
};

export type RegistrationInfo = {
	application: {
		font: string;
		language: string;
		platform: string;
		platformVersion: string;
		version: string;
	};
	colors: Record<string, string>;
	devicePixelRatio: number;
	devices: Array<{ id: string; name: string; size: Size; type: number }>;
	plugin: {
		uuid: string;
		version: string;
	};
};

/** Payload carried by `willAppear`, `willDisappear`, `didReceiveSettings`, `didReceiveResources`. */
export type AppearPayload = {
	controller: Controller;
	coordinates?: Coordinates;
	isInMultiAction: boolean;
	resources: JsonObject;
	settings: JsonObject;
	state?: number;
};

export type KeyGesturePayload = AppearPayload & {
	userDesiredState?: number;
};

export type TitleParametersPayload = AppearPayload & {
	title: string;
	titleParameters: TitleParameters;
};

/** Every event name the mock host can send to a plugin. */
export const PLUGIN_EVENTS = [
	"applicationDidLaunch",
	"applicationDidTerminate",
	"deviceDidChange",
	"deviceDidConnect",
	"deviceDidDisconnect",
	"dialDown",
	"dialRotate",
	"dialUp",
	"didReceiveDeepLink",
	"didReceiveGlobalSettings",
	"didReceiveResources",
	"didReceiveSecrets",
	"didReceiveSettings",
	"keyDown",
	"keyUp",
	"propertyInspectorDidAppear",
	"propertyInspectorDidDisappear",
	"sendToPlugin",
	"systemDidWakeUp",
	"titleParametersDidChange",
	"touchTap",
	"willAppear",
	"willDisappear",
] as const;

export type PluginEventName = (typeof PLUGIN_EVENTS)[number];

/** Every command name a plugin can send to the host. */
export const PLUGIN_COMMANDS = [
	"getGlobalSettings",
	"getResources",
	"getSecrets",
	"getSettings",
	"logMessage",
	"openUrl",
	"sendToPropertyInspector",
	"setFeedback",
	"setFeedbackLayout",
	"setGlobalSettings",
	"setImage",
	"setResources",
	"setSettings",
	"setState",
	"setTitle",
	"setTriggerDescription",
	"showAlert",
	"showOk",
	"switchToProfile",
] as const;

export type PluginCommandName = (typeof PLUGIN_COMMANDS)[number];

/** Every command the property inspector can send to the host. */
export const UI_COMMANDS = [
	"getGlobalSettings",
	"getResources",
	"getSettings",
	"openUrl",
	"sendToPlugin",
	"setGlobalSettings",
	"setResources",
	"setSettings",
] as const;

export type UiCommandName = (typeof UI_COMMANDS)[number];

/** Events the host sends to the property inspector. */
export const UI_EVENTS = [
	"didReceiveGlobalSettings",
	"didReceiveResources",
	"didReceiveSettings",
	"sendToPropertyInspector",
] as const;

/** A frame as it travels over either socket. Unknown shapes are preserved verbatim. */
export type Frame = JsonObject & {
	event: string;
	action?: string;
	context?: string;
	device?: string;
	id?: string;
	payload?: JsonValue;
	uuid?: string;
};

const pluginCommandSet: ReadonlySet<string> = new Set(PLUGIN_COMMANDS);
const uiCommandSet: ReadonlySet<string> = new Set(UI_COMMANDS);

export function isPluginCommand(name: string): name is PluginCommandName {
	return pluginCommandSet.has(name);
}

export function isUiCommand(name: string): name is UiCommandName {
	return uiCommandSet.has(name);
}

export function isJsonString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number";
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
	return typeof value === "boolean";
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFrame(value: JsonValue): value is Frame {
	return isJsonObject(value) && isJsonString(value.event);
}

/** `JSON.parse` returns `any`; this is the typed wire boundary. */
export function parseJsonValue(text: string): JsonValue {
	return JSON.parse(text);
}

export function parseJsonObject(text: string, label: string): JsonObject {
	const value = parseJsonValue(text);
	if (!isJsonObject(value)) {
		throw new Error(`${label} is not a JSON object`);
	}
	return value;
}

export function parseFrame(text: string): Frame {
	const value = parseJsonValue(text);
	if (!isFrame(value)) {
		throw new Error("expected a protocol frame");
	}
	return value;
}

/** Copies defined values into a JSON object, omitting keys whose values are undefined. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JsonObject return annotation is open-dictionary widening
export function compactJson(fields: { [key: string]: JsonValue | undefined }) {
	const result: JsonObject = {};
	for (const key of Object.keys(fields)) {
		const value = fields[key];
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Registration event names accepted on the WebSocket. */
export const REGISTER_PLUGIN = "registerPlugin";
export const REGISTER_PROPERTY_INSPECTOR = "registerPropertyInspector";
