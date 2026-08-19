import { platform, release } from "node:os";

import { Device } from "./device.js";
import type { RegistrationInfo } from "./protocol.js";

/**
 * Colors and font captured from a real Stream Deck 7.5 `-info` payload. The property
 * inspector renders against these, so they are reproduced verbatim rather than invented.
 */
const APPLICATION_COLORS = {
	buttonPressedBackgroundColor: "#303030FF",
	buttonPressedBorderColor: "#646464FF",
	buttonPressedTextColor: "#969696FF",
	disabledColor: "#007AFF7F",
	highlightColor: "#007AFFFF",
	mouseDownColor: "#2EA8FFFF",
} as const;

/** Stream Deck version the harness reports itself as. */
export const EMULATED_STREAM_DECK_VERSION = "7.5.0.22877";

function currentPlatform(): string {
	switch (platform()) {
		case "darwin":
			return "mac";
		case "win32":
			return "windows";
		default:
			return platform();
	}
}

export type RegistrationOptions = {
	pluginUuid: string;
	pluginVersion: string;
	devices: Device[];
	language?: string;
	devicePixelRatio?: number;
};

export function buildRegistrationInfo(options: RegistrationOptions): RegistrationInfo {
	return {
		application: {
			font: currentPlatform() === "mac" ? ".AppleSystemUIFont" : "Segoe UI",
			language: options.language ?? "en",
			platform: currentPlatform(),
			platformVersion: release(),
			version: EMULATED_STREAM_DECK_VERSION,
		},
		colors: { ...APPLICATION_COLORS },
		devicePixelRatio: options.devicePixelRatio ?? 2,
		devices: options.devices.map((device) => ({
			id: device.id,
			name: device.info.name,
			size: device.info.size,
			type: device.info.type,
		})),
		plugin: {
			uuid: options.pluginUuid,
			version: options.pluginVersion,
		},
	};
}
