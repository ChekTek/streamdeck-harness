import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json; charset=utf-8",
} as const;

function contentTypeFor(extension: string): string {
	for (const [suffix, type] of Object.entries(CONTENT_TYPES)) {
		if (suffix === extension) {
			return type;
		}
	}
	return "application/octet-stream";
}

function isTcpAddress(value: AddressInfo | string | null): value is AddressInfo {
	return value !== null && typeof value === "object";
}

/**
 * Serves the `.sdPlugin` folder over loopback HTTP. The property inspector cannot run from
 * `file://` -- relative script paths and module loading both break there.
 */
export class StaticServer {
	readonly #root: string;
	#server: Server | undefined;
	#port = 0;

	constructor(root: string) {
		this.#root = resolve(root);
	}

	public get origin(): string {
		return `http://127.0.0.1:${this.#port}`;
	}

	public async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server === undefined) {
			return;
		}
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	}

	public async listen(): Promise<number> {
		const server = createServer((request, response) => {
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			const decoded = decodeURIComponent(requestUrl.pathname);
			const target = join(this.#root, normalize(decoded));

			// Reject anything that escapes the plugin folder.
			if (target !== this.#root && !target.startsWith(this.#root + sep)) {
				response.writeHead(403).end("forbidden");
				return;
			}
			if (!existsSync(target) || !statSync(target).isFile()) {
				response.writeHead(404).end("not found");
				return;
			}

			response.writeHead(200, {
				"content-type": contentTypeFor(extname(target).toLowerCase()),
				"cache-control": "no-store",
			});
			createReadStream(target).pipe(response);
		});

		this.#server = server;
		await new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				done();
			});
		});

		const address = server.address();
		if (!isTcpAddress(address)) {
			throw new Error("expected a TCP listen address");
		}
		this.#port = address.port;
		return this.#port;
	}
}
