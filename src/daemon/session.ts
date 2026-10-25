import { mkdirSync } from "node:fs";

import { Device, isDeviceProfileName } from "../host/device.js";
import { compactJson, errorMessage, type JsonObject } from "../host/protocol.js";
import { buildRegistrationInfo } from "../host/registration.js";
import { MockStreamDeck } from "../host/ws-server.js";
import type { Inspector } from "../pi/inspector.js";
import { PluginProcess } from "../plugin/launch.js";
import { readPluginErrors } from "../plugin/logs.js";
import { loadPlugin, type PluginProject } from "../plugin/manifest.js";
import { closeBrowser } from "../render/chromium.js";
import { artifactsDir } from "./paths.js";

export type SessionOptions = {
	name: string;
	pluginPath: string;
	devices?: string[];
	nodePath?: string;
	inspect?: boolean;
	/** Milliseconds to wait for `registerPlugin` before giving up. */
	registerTimeoutMs?: number;
};

/**
 * One running plugin under test: the mock host, the plugin process, and everything derived
 * from them. Owned by the daemon so a session survives between CLI invocations.
 */
export class Session {
	public readonly artifacts: string;

	public readonly host: MockStreamDeck;
	public inspectorUrl: string | undefined;

	public readonly name: string;

	public readonly plugin: PluginProcess;

	public readonly project: PluginProject;
	/** The property inspector currently open, if any. Stream Deck shows at most one. */
	public propertyInspector: Inspector | undefined;

	public readonly startedAt = Date.now();

	private constructor(options: {
		name: string;
		project: PluginProject;
		host: MockStreamDeck;
		plugin: PluginProcess;
		artifacts: string;
	}) {
		this.name = options.name;
		this.project = options.project;
		this.host = options.host;
		this.plugin = options.plugin;
		this.artifacts = options.artifacts;
	}

	public static async start(options: SessionOptions): Promise<Session> {
		const project = loadPlugin(options.pluginPath);
		const devices = (options.devices ?? ["stream-deck"]).map((name) => {
			if (!isDeviceProfileName(name)) {
				throw new Error(`unknown device profile "${name}"`);
			}
			return new Device(name);
		});

		const artifacts = artifactsDir(options.name);
		mkdirSync(artifacts, { recursive: true });

		const host = new MockStreamDeck({
			manifest: project.manifest,
			info: buildRegistrationInfo({
				pluginUuid: project.manifest.UUID,
				pluginVersion: project.manifest.Version,
				devices,
			}),
			devices,
		});
		const port = await host.listen();

		const plugin = new PluginProcess({
			project,
			port,
			pluginUuid: host.pluginUuid,
			info: host.info,
			nodePath: options.nodePath,
			inspect: options.inspect,
		});

		// A plugin that dies before registering would otherwise hang the handshake wait.
		plugin.on("exit", (exit: { code: number | null; signal: string | null }) => {
			host.failRegistration(
				new Error(`plugin exited before registering (code ${String(exit.code)}, signal ${String(exit.signal)})`),
			);
		});

		const session = new Session({ name: options.name, project, host, plugin, artifacts });

		try {
			await host.waitForPlugin(options.registerTimeoutMs ?? 15_000);
		} catch (cause) {
			const detail = session.failureDetail();
			await session.close();
			throw new Error(`${errorMessage(cause)}\n${detail}`);
		}

		session.inspectorUrl = await plugin.waitForInspector(2000);
		return session;
	}

	public async close(): Promise<void> {
		await this.propertyInspector?.close();
		this.propertyInspector = undefined;
		await closeBrowser();
		await this.plugin.stop();
		await this.host.close();
	}

	public describe(): JsonObject {
		return compactJson({
			session: this.name,
			plugin: this.project.manifest.Name,
			uuid: this.project.manifest.UUID,
			version: this.project.manifest.Version,
			root: this.project.root,
			runtime: this.project.runtime,
			codePath: this.project.codePath,
			nodeBinary: this.project.runtime === "node" ? this.plugin.command : null,
			pid: this.plugin.pid ?? null,
			port: this.host.port,
			inspector: this.inspectorUrl ?? null,
			artifacts: this.artifacts,
			startedAt: new Date(this.startedAt).toISOString(),
			devices: this.host.devices.map((device) =>
				compactJson({
					id: device.id,
					name: device.info.name,
					columns: device.columns,
					rows: device.rows,
				}),
			),
			actions: this.project.manifest.Actions.map((action) =>
				compactJson({
					uuid: action.UUID,
					name: action.Name,
					controllers: action.Controllers ?? ["Keypad"],
					states: action.States?.length ?? 1,
					propertyInspector: action.PropertyInspectorPath ?? this.project.manifest.PropertyInspectorPath ?? null,
				}),
			),
		});
	}

	/** Diagnostics worth printing when startup fails: process output plus the plugin's own error log. */
	public failureDetail(): string {
		const output = this.plugin.output
			.slice(-20)
			.map((line) => `  [${line.stream}] ${line.text}`)
			.join("\n");
		const errors = readPluginErrors(this.project.root, this.startedAt)
			.map((line) => `  [log] ${line.text}`)
			.join("\n");

		return [
			`command: ${this.plugin.command} ${this.plugin.args.slice(0, -1).join(" ")} -info <json>`,
			output.length > 0 ? `process output:\n${output}` : "process output: (none)",
			errors.length > 0 ? `plugin log errors:\n${errors}` : "",
		]
			.filter((part) => part.length > 0)
			.join("\n");
	}
}
