export type Args = {
	session: string;
	verb: string;
	positional: string[];
	flags: Map<string, boolean | string>;
};

const DEFAULT_SESSION = "default";

/**
 * Minimal parser for `sdtest -s=<session> <verb> [positional] [--flag value] [--bool]`.
 * `-s=name`, `-s name`, and `--session name` are all accepted, matching playwright-cli.
 */
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
	return typeof value === "string" ? value : undefined;
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
	if (typeof value === "boolean") {
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

/** Parses a JSON flag, accepting `@path` to read from a file. */
export function flagJson(args: Args, name: string): Record<string, unknown> | undefined {
	const value = flagString(args, name);
	if (value === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (cause) {
		throw new Error(`--${name} is not a JSON object: ${(cause as Error).message}`);
	}
}
