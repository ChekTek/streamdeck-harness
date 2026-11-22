import type { ManifestAction, ManifestState } from "../plugin/manifest.js";
import type { Device } from "./device.js";
import type { Controller, Coordinates, Target, TitleParameters } from "./protocol.js";

/** Title parameters that Stream Deck uses when the manifest sets none. */
const DEFAULT_TITLE_PARAMETERS: TitleParameters = {
	fontFamily: "",
	fontSize: 12,
	fontStyle: "",
	fontUnderline: false,
	showTitle: true,
	titleAlignment: "middle",
	titleColor: "#ffffff",
};

export type ImageOverride = {
	/** The `setImage` value: a data URI, a path relative to the manifest, or undefined to reset. */
	image: string | undefined;
	target: Target;
	state: number | undefined;
};

export type Flash = {
	kind: "alert" | "ok";
	at: number;
};

/** One action instance on the emulated device. It holds all that the plugin set on the key. */
export class ActionInstance {
	public readonly context: string;
	public readonly controller: Controller;
	public readonly coordinates: Coordinates | undefined;
	public readonly definition: ManifestAction;

	public readonly device: Device;
	/** Sequence number of the last `willDisappear`. */
	public disappearedAtSeq: number | undefined;
	public readonly flashes: Flash[] = [];

	public readonly imageByState = new Map<number, ImageOverride>();

	public readonly isInMultiAction: boolean;

	public state = 0;

	/** Title from the user or `setTitle`. When undefined, the manifest title applies. */
	public title: string | undefined;

	/** Title per state from `setTitle`. Single-state actions use index 0. */
	public readonly titleByState = new Map<number, string>();

	public readonly uuid: string;

	/** True while the plugin thinks the instance is on screen. */
	public visible = false;

	constructor(options: {
		context: string;
		uuid: string;
		device: Device;
		controller: Controller;
		coordinates: Coordinates | undefined;
		isInMultiAction: boolean;
		definition: ManifestAction;
		title?: string;
		state?: number;
	}) {
		this.context = options.context;
		this.uuid = options.uuid;
		this.device = options.device;
		this.controller = options.controller;
		this.coordinates = options.coordinates;
		this.isInMultiAction = options.isInMultiAction;
		this.definition = options.definition;
		this.title = options.title;
		this.state = options.state ?? 0;
	}

	public get effectiveImage(): ImageOverride | undefined {
		return this.imageByState.get(this.state);
	}

	/** Title for the current state. */
	public get effectiveTitle(): string {
		return this.titleByState.get(this.state) ?? this.title ?? this.manifestState?.Title ?? "";
	}

	public get manifestState(): ManifestState | undefined {
		return this.definition.States?.[this.state];
	}

	public get stateCount(): number {
		return Math.max(this.definition.States?.length ?? 1, 1);
	}

	/** Title parameters: the defaults plus the manifest values for the current state. */
	public get titleParameters(): TitleParameters {
		const state = this.manifestState;
		return {
			fontFamily: state?.FontFamily ?? DEFAULT_TITLE_PARAMETERS.fontFamily,
			fontSize: state?.FontSize ?? DEFAULT_TITLE_PARAMETERS.fontSize,
			fontStyle: state?.FontStyle ?? DEFAULT_TITLE_PARAMETERS.fontStyle,
			fontUnderline: state?.FontUnderline ?? DEFAULT_TITLE_PARAMETERS.fontUnderline,
			showTitle: state?.ShowTitle ?? DEFAULT_TITLE_PARAMETERS.showTitle,
			titleAlignment: state?.TitleAlignment ?? DEFAULT_TITLE_PARAMETERS.titleAlignment,
			titleColor: state?.TitleColor ?? DEFAULT_TITLE_PARAMETERS.titleColor,
		};
	}
}
