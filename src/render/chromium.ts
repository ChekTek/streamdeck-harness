import { type Browser, chromium } from "playwright";

let browser: Browser | undefined;
let starting: Promise<Browser> | undefined;

/**
 * One headless Chromium per daemon, shared by key rendering and the property inspector.
 * Always headless: the point of the harness is that the user keeps their desktop.
 */
export async function getBrowser(): Promise<Browser> {
	if (browser !== undefined && browser.isConnected()) {
		return browser;
	}
	starting ??= chromium
		.launch({ headless: true, args: ["--force-color-profile=srgb", "--disable-lcd-text"] })
		.then((launched) => {
			browser = launched;
			starting = undefined;
			return launched;
		})
		.catch((cause: unknown) => {
			starting = undefined;
			const message = cause instanceof Error ? cause.message : String(cause);
			throw new Error(
				message.includes("Executable doesn't exist")
					? "Chromium is not installed. Run: pnpm --dir <harness> browser  (or: npx playwright install chromium)"
					: message,
			);
		});
	return starting;
}

export async function closeBrowser(): Promise<void> {
	const current = browser;
	browser = undefined;
	await current?.close();
}
