const PERCENT = "%".charCodeAt(0);

/**
 * Splits a `data:` URI into its media type and decoded text. Returns undefined when `uri` is
 * not a data URI.
 */
export function parseDataUri(uri: string): DataUri | undefined {
	const comma = uri.indexOf(",");
	if (!uri.startsWith("data:") || comma < 0) {
		return undefined;
	}

	const [mimeType = "", ...parameters] = uri.slice("data:".length, comma).split(";");
	const body = uri.slice(comma + 1);
	const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === "base64");

	return {
		mimeType: mimeType.trim().toLowerCase(),
		text: isBase64 ? Buffer.from(body, "base64").toString("utf8") : percentDecode(body),
	};
}

/**
 * Decodes percent-encoding the same way as Stream Deck. A `%` always uses the two bytes after
 * it, so unencoded text such as `width="100%" height="72"` loses two characters.
 */
function percentDecode(body: string): string {
	const input = Buffer.from(body, "utf8");
	const output = Buffer.alloc(input.length);
	let length = 0;

	for (let index = 0; index < input.length; index++) {
		const byte = input.readUInt8(index);
		if (byte !== PERCENT || index + 2 >= input.length) {
			output.writeUInt8(byte, length++);
			continue;
		}

		const high = hexValue(input.readUInt8(index + 1));
		const low = hexValue(input.readUInt8(index + 2));
		output.writeUInt8((high === undefined ? PERCENT : high << 4) | (low ?? 0), length++);
		index += 2;
	}

	return output.subarray(0, length).toString("utf8");
}

function hexValue(byte: number): number | undefined {
	const value = Number.parseInt(String.fromCharCode(byte), 16);
	return Number.isNaN(value) ? undefined : value;
}

type DataUri = {
	mimeType: string;
	text: string;
};
