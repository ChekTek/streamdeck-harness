const PERCENT = "%".charCodeAt(0);

/**
 * Splits a `data:` URI into its media type and decoded text. Media-type parameters such as
 * `;charset=utf-8` are accepted. The body is percent-decoded the way Stream Deck decodes it,
 * so raw SVG passes through except where it contains a `%`. Returns undefined when `uri` is
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
 * Decodes like the Qt decoder Stream Deck uses, which never rejects input: a `%` with two
 * bytes after it always consumes both, whether or not they are hex digits. A first byte that
 * is not a hex digit leaves the `%` in place and a second one counts as zero, so unencoded
 * markup such as `width="100%" height="72"` loses the two characters after the `%`.
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
