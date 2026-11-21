import { type ChildProcessByStdio, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

import type { RegistrationInfo } from "../host/protocol.js";
import type { PluginProject } from "./manifest.js";

/** Matches the line Node prints on stderr when started with `--inspect`. */
const INSPECTOR_LINE = /Debugger listening on (ws:\/\/\S+)/;

export type LaunchOptions = {
	project: PluginProject;
	port: number;
	pluginUuid: string;
	info: RegistrationInfo;
	/** Node binary to use for Node plugins. Defaults to the one running the harness. */
	nodePath?: string;
	/** Set false to skip `--inspect` (disables heap and handle measurement). */
	inspect?: boolean;
	env?: NodeJS.ProcessEnv;
};

export type OutputLine = {
	stream: "stderr" | "stdout";
	at: number;
	text: string;
};

/**
 * The plugin process under test. Launched with exactly the arguments Stream Deck passes:
 * `-port`, `-pluginUUID`, `-registerEvent`, `-info`.
 */
export class PluginProcess extends EventEmitter {
	public readonly args: string[];

	public readonly command: string;
	public readonly output: OutputLine[] = [];

	public readonly runtime: "native" | "node";

	#child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	#inspectorUrl: string | undefined;
	#exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	readonly #startedAt = Date.now();

	constructor(options: LaunchOptions) {
		super();
		const { project, port, pluginUuid, info } = options;
		const pluginArgs = [
			"-port",
			String(port),
			"-pluginUUID",
			pluginUuid,
			"-registerEvent",
			"registerPlugin",
			"-info",
			JSON.stringify(info),
		];

		this.runtime = project.runtime;
		if (project.runtime === "node") {
			this.command = options.nodePath ?? process.execPath;
			this.args = [...(options.inspect === false ? [] : ["--inspect=0"]), project.codePath, ...pluginArgs];
		} else {
			this.command = project.codePath;
			this.args = pluginArgs;
		}

		this.#child = spawn(this.command, this.args, {
			// Stream Deck runs plugins from inside the .sdPlugin folder; the SDK's log
			// directory is resolved relative to it.
			cwd: project.root,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		this.#pipe("stdout", this.#child.stdout);
		this.#pipe("stderr", this.#child.stderr);

		this.#child.on("exit", (code, signal) => {
			this.#exit = { code, signal };
			this.#child = undefined;
			this.emit("exit", this.#exit);
		});
		this.#child.on("error", (error) => this.emit("error", error));
	}

	public get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
		return this.#exit;
	}

	public get inspectorUrl(): string | undefined {
		return this.#inspectorUrl;
	}

	public get pid(): number | undefined {
		return this.#child?.pid;
	}

	public get running(): boolean {
		return this.#child !== undefined;
	}

	#pipe(stream: "stderr" | "stdout", source: NodeJS.ReadableStream): void {
		let buffer = "";
		source.setEncoding("utf8");
		source.on("data", (chunk: string) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const text = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				this.#line(stream, text);
				index = buffer.indexOf("\n");
			}
		});
		source.on("end", () => {
			if (buffer.length > 0) {
				this.#line(stream, buffer);
				buffer = "";
			}
		});
	}

	#line(stream: "stderr" | "stdout", text: string): void {
		this.output.push({ stream, at: Date.now() - this.#startedAt, text });
		const match = INSPECTOR_LINE.exec(text);
		if (match?.[1] !== undefined && this.#inspectorUrl === undefined) {
			this.#inspectorUrl = match[1];
			this.emit("inspector", this.#inspectorUrl);
		}
		this.emit("line", { stream, text });
	}

	public async stop(graceMs = 2000): Promise<void> {
		const child = this.#child;
		if (child === undefined) {
			return;
		}

		child.kill("SIGTERM");
		const exited = await Promise.race([
			new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
		]);
		if (!exited) {
			child.kill("SIGKILL");
		}
	}

	/** Resolves with the inspector WebSocket URL, or undefined if the plugin is native. */
	public async waitForInspector(timeoutMs: number): Promise<string | undefined> {
		if (this.runtime !== "node") {
			return undefined;
		}
		if (this.#inspectorUrl !== undefined) {
			return this.#inspectorUrl;
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.off("inspector", onUrl);
				resolve(undefined);
			}, timeoutMs);
			const onUrl = (url: string): void => {
				clearTimeout(timer);
				resolve(url);
			};
			this.once("inspector", onUrl);
		});
	}
}
