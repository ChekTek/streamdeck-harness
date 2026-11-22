import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const LOGS = "logs";

/** Retries cover Windows, where a file stays locked for a moment after its process exits. */
const REMOVE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

/**
 * Copies the `.sdPlugin` folder `source` into `directory` and returns the path of the copy.
 * The `logs` folder is not copied. A link is copied as a link and its target is not read.
 */
export function copyPlugin(source: string, directory: string): string {
	const from = realpathSync(source);
	const to = join(directory, basename(source));
	rmSync(directory, REMOVE);
	copyFolder(from, to, { from, to });
	return to;
}

/** Removes the copy in `directory`. `keepLogs` keeps the log files of the plugin. */
export function removePluginCopy(directory: string, keepLogs = false): void {
	if (!keepLogs) {
		rmSync(directory, REMOVE);
		return;
	}
	for (const root of readdirSync(directory)) {
		for (const entry of readdirSync(join(directory, root))) {
			if (entry !== LOGS) {
				rmSync(join(directory, root, entry), REMOVE);
			}
		}
	}
}

type Roots = { from: string; to: string };

function copyFolder(from: string, to: string, roots: Roots): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (from === roots.from && entry.name === LOGS) {
			continue;
		}
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (entry.isSymbolicLink()) {
			copyLink(source, target, roots);
		} else if (entry.isDirectory()) {
			copyFolder(source, target, roots);
		} else if (entry.isFile()) {
			copyFileSync(source, target, constants.COPYFILE_FICLONE);
		}
	}
}

/** Makes the link again. A target inside the plugin folder becomes the same path inside the copy. */
function copyLink(from: string, to: string, roots: Roots): void {
	const text = readlinkSync(from);
	const target = resolve(dirname(from), text);
	const inside = relative(roots.from, target);
	const internal = !inside.startsWith("..") && !isAbsolute(inside);
	const link = !internal ? target : isAbsolute(text) ? join(roots.to, inside) : text;

	if (process.platform !== "win32") {
		symlinkSync(link, to);
		return;
	}
	if (!existsSync(from)) {
		return;
	}
	if (statSync(from).isDirectory()) {
		// A junction needs no privilege on Windows. A symbolic link does.
		symlinkSync(resolve(dirname(to), link), to, "junction");
		return;
	}
	try {
		symlinkSync(link, to, "file");
	} catch {
		copyFileSync(from, to);
	}
}
