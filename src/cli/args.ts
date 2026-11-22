import { parseJsonObject, type JsonObject } from "../host/protocol.js";

export type Args = {
	session: string;
	verb: string;
	positional: string[];
	flags: Map<string, boolean | string>;
};

const DEFAULT_SESSION = "default";

/** Flags without a value. `--no-<name>` sets a flag to false. */
const BOOLEAN_FLAGS = new Set([
	"all",
	"appear",
	"full-page",
	"heap-snapshot",
	"in-place",
	"inspect",
	"json",
	"keep",
	"multi-action",
	"raw",
	"since-start",
	"strict",
]);

function isFlagString(value: boolean | string | undefined): value is string {
	return typeof value === "string";
}

function isFlagBoolean(value: boolean | string | undefined): value is boolean {
	return typeof value === "boolean";
}

/** Parses `sdtest -s=<session> <verb> [positional] [--flag value] [--bool]`. */
export function parseArgs(argv: string[]): Args {
	let session = process.env.SDTEST_SESSION ?? DEFAULT_SESSION;
	const positional: string[] = [];
	const flags = new Map<string, boolean | string>();
	let verb: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;

		if (arg.startsWith("-s=")) {
			session = arg.slice(3);
			continue;
		}
		if (arg === "-s" || arg === "--session") {
			session = argv[++index] ?? session;
			continue;
		}
		if (arg.startsWith("--")) {
			const body = arg.slice(2);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				flags.set(body.slice(0, eq), body.slice(eq + 1));
				continue;
			}
			const next = argv[index + 1];
			if (body.startsWith("no-") && BOOLEAN_FLAGS.has(body.slice(3))) {
				flags.set(body.slice(3), false);
				continue;
			}
			if (BOOLEAN_FLAGS.has(body)) {
				if (next === "true" || next === "false") {
					flags.set(body, next);
					index++;
				} else {
					flags.set(body, true);
				}
				continue;
			}
			if (next !== undefined && !next.startsWith("-")) {
				flags.set(body, next);
				index++;
			} else {
				flags.set(body, true);
			}
			continue;
		}
		if (verb === undefined) {
			verb = arg;
		} else {
			positional.push(arg);
		}
	}

	return { session, verb: verb ?? "help", positional, flags };
}

export function flagString(args: Args, name: string): string | undefined {
	const value = args.flags.get(name);
	return isFlagString(value) ? value : undefined;
}

export function flagNumber(args: Args, name: string): number | undefined {
	const value = flagString(args, name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		throw new Error(`--${name} expects a number, got "${value}"`);
	}
	return parsed;
}

export function flagBool(args: Args, name: string): boolean | undefined {
	const value = args.flags.get(name);
	if (value === undefined) {
		return undefined;
	}
	if (isFlagBoolean(value)) {
		return value;
	}
	return value !== "false" && value !== "0";
}

export function flagList(args: Args, name: string): string[] | undefined {
	const value = flagString(args, name);
	return value
		?.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Reads a JSON flag. `@path` reads the JSON from a file. */
export function flagJson(args: Args, name: string): JsonObject | undefined {
	const value = flagString(args, name);
	if (value === undefined) {
		return undefined;
	}
	try {
		return parseJsonObject(value, `--${name}`);
	} catch (cause) {
		throw new Error(`--${name} is not a JSON object: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
