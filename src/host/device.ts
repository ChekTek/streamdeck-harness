import { randomBytes } from "node:crypto";

import { type DeviceInfo, DeviceTypeCode } from "./protocol.js";

/**
 * Named device profiles the harness can emulate. Sizes and type codes match the
 * devices captured from a real Stream Deck 7.5 registration payload.
 */
export const DEVICE_PROFILES = {
	"stream-deck": { name: "Stream Deck", size: { columns: 5, rows: 3 }, type: DeviceTypeCode.StreamDeck },
	mini: { name: "Stream Deck Mini", size: { columns: 3, rows: 2 }, type: DeviceTypeCode.StreamDeckMini },
	xl: { name: "Stream Deck XL", size: { columns: 8, rows: 4 }, type: DeviceTypeCode.StreamDeckXL },
	mobile: { name: "Stream Deck Mobile", size: { columns: 3, rows: 2 }, type: DeviceTypeCode.StreamDeckMobile },
	plus: { name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: DeviceTypeCode.StreamDeckPlus },
	neo: { name: "Stream Deck Neo", size: { columns: 4, rows: 2 }, type: DeviceTypeCode.StreamDeckNeo },
	virtual: { name: "Virtual Stream Deck", size: { columns: 2, rows: 2 }, type: DeviceTypeCode.VirtualStreamDeck },
} as const satisfies Record<string, DeviceInfo>;

export type DeviceProfileName = keyof typeof DEVICE_PROFILES;

export function isDeviceProfileName(value: string): value is DeviceProfileName {
	return Object.hasOwn(DEVICE_PROFILES, value);
}

/** Stream Deck identifiers are 32 lowercase hex characters; plugin code logs and sometimes parses them. */
export function newIdentifier(): string {
	return randomBytes(16).toString("hex");
}

export class Device {
	public readonly id: string;
	public readonly info: DeviceInfo;

	constructor(profile: DeviceProfileName, id = newIdentifier()) {
		this.id = id;
		const profileInfo = DEVICE_PROFILES[profile];
		this.info = {
			name: profileInfo.name,
			size: { columns: profileInfo.size.columns, rows: profileInfo.size.rows },
			type: profileInfo.type,
		};
	}

	public get columns(): number {
		return this.info.size.columns;
	}

	public get rows(): number {
		return this.info.size.rows;
	}

	public contains(column: number, row: number): boolean {
		return column >= 0 && row >= 0 && column < this.columns && row < this.rows;
	}
}
