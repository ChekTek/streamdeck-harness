import { isJsonObject, isJsonString, type JsonValue } from "../host/protocol.js";

/** A value that must not be in output, and the text that replaces it. */
export type Secret = {
	value: string;
	label: string;
};

/**
 * Shortest value that is a secret. A shorter value, such as `1` or `true`, is also in text that
 * is not secret.
 */
export const MIN_SECRET_LENGTH = 8;

/** Makes a secret from each variable of an env file. The label is the name of the variable. */
export function secretsFromEnv(env: NodeJS.ProcessEnv): Secret[] {
	const secrets: Secret[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && value.length >= MIN_SECRET_LENGTH) {
			secrets.push({ value, label: `<${name}>` });
		}
	}
	// A secret that contains a different secret is replaced first.
	return secrets.sort((first, second) => second.value.length - first.value.length);
}

/** Replaces each secret in `text` by its label. */
export function redactText(text: string, secrets: readonly Secret[]): string {
	let redacted = text;
	for (const secret of secrets) {
		redacted = redacted.replaceAll(secret.value, secret.label);
	}
	return redacted;
}

/** Returns a copy of `value` in which each secret in a string value is replaced by its label. */
export function redactJson(value: JsonValue, secrets: readonly Secret[]): JsonValue {
	if (secrets.length === 0) {
		return value;
	}
	if (isJsonString(value)) {
		return redactText(value, secrets);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactJson(entry, secrets));
	}
	if (isJsonObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry, secrets)]));
	}
	return value;
}
