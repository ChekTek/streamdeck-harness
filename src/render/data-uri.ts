/**
 * Splits a `data:` URI into its media type and decoded text. Media-type parameters such as
 * `;charset=utf-8` are accepted, and a body that is not valid percent-encoding is taken as
 * written, since plugins commonly send raw SVG. Returns undefined when `uri` is not a data URI.
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

function percentDecode(body: string): string {
	try {
		return decodeURIComponent(body);
	} catch {
		return body;
	}
}

type DataUri = {
	mimeType: string;
	text: string;
};
