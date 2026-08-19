import type { ManifestAction, ManifestState } from "../plugin/manifest.js";
import type { Device } from "./device.js";
import type { Controller, Coordinates, Target, TitleParameters } from "./protocol.js";

/** Default title parameters Stream Deck reports when the manifest overrides nothing. */
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
	/** The raw `setImage` payload value: a data URI, a manifest-relative path, or undefined to revert. */
	image: string | undefined;
	target: Target;
	state: number | undefined;
};

export type Flash = {
	kind: "alert" | "ok";
	at: number;
};

/**
 * One action instance on the emulated device -- the harness equivalent of a key placed on
 * a profile. Holds everything the plugin has set on it so a key can be rendered and asserted.
 */
export class ActionInstance {
	public readonly context: string;
	public readonly controller: Controller;
	public readonly coordinates: Coordinates | undefined;
	public readonly definition: ManifestAction;

	public readonly device: Device;
	/** Seq of the `willDisappear` most recently sent, used by the lifecycle check. */
	public disappearedAtSeq: number | undefined;
	public readonly flashes: Flash[] = [];

	public readonly imageByState = new Map<number, ImageOverride>();

	public readonly isInMultiAction: boolean;

	public state = 0;

	public title: string;

	/** Per-state title override set via `setTitle`; index 0 is used for single-state actions. */
	public readonly titleByState = new Map<number, string>();

	public readonly uuid: string;

	/** Whether the plugin currently believes this instance is on screen. */
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
		this.title = options.title ?? "";
		this.state = options.state ?? 0;
	}

	public get effectiveImage(): ImageOverride | undefined {
		return this.imageByState.get(this.state);
	}

	/** Effective title for the current state, preferring a `setTitle` override. */
	public get effectiveTitle(): string {
		return this.titleByState.get(this.state) ?? this.title;
	}

	public get manifestState(): ManifestState | undefined {
		return this.definition.States?.[this.state];
	}

	public get stateCount(): number {
		return Math.max(this.definition.States?.length ?? 1, 1);
	}

	/**
	 * Title parameters as Stream Deck computes them: defaults, overlaid with the manifest
	 * state's typography fields.
	 */
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
