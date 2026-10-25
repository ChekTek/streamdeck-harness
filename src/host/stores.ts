import type { JsonObject } from "./protocol.js";

/**
 * Settings storage owned by the host, exactly as the real app owns it: the plugin and the
 * property inspector both read and write through the socket, neither holds the truth.
 */
export class SettingsStore {
	#global: JsonObject = {};
	#secrets: JsonObject = {};
	readonly #perContext = new Map<string, JsonObject>();
	readonly #resources = new Map<string, JsonObject>();

	public forget(context: string): void {
		this.#perContext.delete(context);
		this.#resources.delete(context);
	}

	public get(context: string): JsonObject {
		return structuredClone(this.#perContext.get(context) ?? {});
	}

	public getGlobal(): JsonObject {
		return structuredClone(this.#global);
	}

	public getResources(context: string): JsonObject {
		return structuredClone(this.#resources.get(context) ?? {});
	}

	public getSecrets(): JsonObject {
		return structuredClone(this.#secrets);
	}

	public set(context: string, settings: JsonObject): void {
		this.#perContext.set(context, structuredClone(settings));
	}

	public setGlobal(settings: JsonObject): void {
		this.#global = structuredClone(settings);
	}

	public setResources(context: string, resources: JsonObject): void {
		this.#resources.set(context, structuredClone(resources));
	}

	public setSecrets(secrets: JsonObject): void {
		this.#secrets = structuredClone(secrets);
	}
}
