import { type Browser, chromium } from "playwright";

let browser: Browser | undefined;
let starting: Promise<Browser> | undefined;

/** Returns the headless Chromium of the daemon. Starts it on first use. */
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
					? "Chromium is not installed. Run: sdtest install-browser"
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
