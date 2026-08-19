import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Session } from "../daemon/session.js";
import type { JsonObject } from "../host/protocol.js";
import { InspectorClient, readRss, summariseHeapSnapshot } from "../plugin/inspector-client.js";

export type LifecycleOptions = {
	uuid: string;
	cycles: number;
	warmup: number;
	settings: JsonObject;
	interact: "none" | "press";
	quietMs: number;
	timeoutMs: number;
	maxBytesPerCycle: number;
	maxHandlesPerCycle: number;
	heapSnapshot: boolean;
};

export type Sample = {
	cycle: number;
	/** V8 JS heap after a forced GC. */
	heapUsed: number | undefined;
	/** Memory held outside the JS heap -- Buffers, ArrayBuffers, native allocations. */
	external: number | undefined;
	/** `heapUsed + external`: everything the plugin is holding on to. */
	retained: number | undefined;
	rss: number | undefined;
	handles: Record<string, number>;
};

export type LifecycleReport = {
	action: string;
	runtime: "native" | "node";
	measurement: "inspector" | "rss";
	cycles: number;
	warmup: number;
	samples: Sample[];
	/** Slope of `heapUsed + external` across the kept cycles. */
	retainedBytesPerCycle: number | undefined;
	retainedSlopeStdError: number | undefined;
	heapBytesPerCycle: number | undefined;
	externalBytesPerCycle: number | undefined;
	rssBytesPerCycle: number | undefined;
	handlesPerCycle: Record<string, number>;
	commandsAfterDisappear: number;
	afterDisappearDetail: string[];
	/** Cycles in which the plugin never stopped sending frames. */
	settleTimeouts: number;
	otherLiveActions: number;
	verdict: "inconclusive" | "leak" | "pass";
	reasons: string[];
	heapSnapshotPath?: string;
	topRetainers?: Array<{ name: string; count: number; selfSize: number }>;
	note: string;
};

export const LIFECYCLE_DEFAULTS = {
	cycles: 10,
	warmup: 2,
	quietMs: 400,
	timeoutMs: 3_000,
	maxBytesPerCycle: 64 * 1024,
	maxHandlesPerCycle: 0,
} as const;

/**
 * Drives an action through repeated appear/interact/disappear cycles and reports whether it
 * gives back what it took.
 *
 * Three independent signals, strongest last:
 *  - heap growth per cycle, measured after a forced GC;
 *  - active libuv handles per cycle, which names the leaked resource type outright;
 *  - whether the plugin sent any command for a context *after* that context's willDisappear,
 *    which needs no runtime introspection and so works for native plugins too.
 *
 * The slope is fitted across the kept cycles rather than comparing first to last, so one-time
 * lazy initialisation is not mistaken for a leak.
 */
export async function checkLifecycle(session: Session, options: LifecycleOptions): Promise<LifecycleReport> {
	const inspector =
		session.inspectorUrl === undefined
			? undefined
			: await InspectorClient.connect(session.inspectorUrl).catch(() => undefined);
	const measurement = inspector === undefined ? "rss" : "inspector";
	const startSeq = session.host.recorder.nextSeq;

	try {
		// A leaking action from an earlier check keeps sending frames forever, which would be
		// read as this action's noise. Report how many others are live so the caller can tell.
		const otherLiveActions = session.host.allActions().filter((candidate) => candidate.visible).length;

		const instance = session.host.addAction({ uuid: options.uuid, settings: options.settings, appear: false });
		const samples: Sample[] = [];
		const total = options.warmup + options.cycles;
		let settleTimeouts = 0;

		for (let cycle = 0; cycle < total; cycle++) {
			session.host.appear(instance);
			settleTimeouts += await settle(session, options);

			if (options.interact === "press") {
				session.host.keyDown(instance);
				await delay(40);
				session.host.keyUp(instance);
				settleTimeouts += await settle(session, options);
			}

			session.host.disappear(instance);
			settleTimeouts += await settle(session, options);

			samples.push(await sample(session, inspector, cycle));
		}

		const kept = samples.slice(options.warmup);
		const fitOf = (pick: (entry: Sample) => number | undefined): { slope: number; stdError: number } | undefined => {
			const series = kept.map(pick).filter((value): value is number => value !== undefined);
			return series.length === kept.length && kept.length >= 3 ? fitSlope(series) : undefined;
		};

		const retainedFit = fitOf((entry) => entry.retained);
		const heapFit = fitOf((entry) => entry.heapUsed);
		const externalFit = fitOf((entry) => entry.external);
		const rssFit = fitOf((entry) => entry.rss);
		const handlesPerCycle = handleSlopes(kept);

		const afterDisappear = session.host.recorder
			.violations(startSeq)
			.filter((violation) => violation.kind === "after-disappear" && violation.context === instance.context);

		const report = verdictFor(
			{
				action: options.uuid,
				runtime: session.project.runtime,
				measurement,
				cycles: options.cycles,
				warmup: options.warmup,
				samples,
				retainedBytesPerCycle: retainedFit?.slope,
				retainedSlopeStdError: retainedFit?.stdError,
				heapBytesPerCycle: heapFit?.slope,
				externalBytesPerCycle: externalFit?.slope,
				rssBytesPerCycle: rssFit?.slope,
				handlesPerCycle,
				commandsAfterDisappear: afterDisappear.length,
				afterDisappearDetail: afterDisappear.slice(0, 5).map((violation) => violation.message),
				settleTimeouts,
				otherLiveActions,
				verdict: "pass",
				reasons: [],
				note:
					measurement === "inspector"
						? "Memory and handle counts read from the plugin's Node inspector after a forced GC. Retained = JS heap + external (Buffers, ArrayBuffers)."
						: "No Node inspector available, so only RSS and the after-disappear check apply. RSS is noisy; treat small movements as nothing.",
			},
			options,
		);

		if (report.verdict !== "pass" && options.heapSnapshot && inspector !== undefined) {
			const json = await inspector.takeHeapSnapshot();
			const path = join(session.artifacts, `${options.uuid.split(".").pop() ?? "action"}-leak.heapsnapshot`);
			writeFileSync(path, json);
			report.heapSnapshotPath = path;
			report.topRetainers = summariseHeapSnapshot(json);
		}

		session.host.removeAction(instance);
		return report;
	} finally {
		inspector?.close();
	}
}

/**
 * Waits for the plugin to stop sending frames, and gives up quickly if it never does.
 * An action that leaks a repeating timer never goes quiet, so an unbounded wait here would
 * make every later cycle pay the full timeout. Returns 1 when the wait timed out.
 */
async function settle(session: Session, options: LifecycleOptions): Promise<number> {
	try {
		await session.host.recorder.waitForQuiet(options.quietMs, options.timeoutMs);
		return 0;
	} catch {
		return 1;
	}
}

async function sample(session: Session, inspector: InspectorClient | undefined, cycle: number): Promise<Sample> {
	if (inspector !== undefined) {
		await inspector.collectGarbage();
		// A second pass collects anything the first pass made unreachable.
		await inspector.collectGarbage();
		const memory = await inspector.memoryUsage();
		return {
			cycle,
			heapUsed: memory?.heapUsed,
			external: memory?.external,
			retained: memory === undefined ? undefined : memory.heapUsed + memory.external,
			rss: memory?.rss,
			handles: await inspector.activeResources(),
		};
	}

	const pid = session.plugin.pid;
	return {
		cycle,
		heapUsed: undefined,
		external: undefined,
		retained: undefined,
		rss: pid === undefined ? undefined : await readRss(pid),
		handles: {},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

type SlopeFit = {
	slope: number;
	stdError: number;
};

/** Least-squares slope per cycle, with the standard error needed to tell signal from noise. */
function fitSlope(values: number[]): SlopeFit {
	const n = values.length;
	const meanX = (n - 1) / 2;
	const meanY = values.reduce((total, value) => total + value, 0) / n;

	let sxy = 0;
	let sxx = 0;
	for (let index = 0; index < n; index++) {
		sxy += (index - meanX) * (values[index]! - meanY);
		sxx += (index - meanX) ** 2;
	}
	const slope = sxx === 0 ? 0 : sxy / sxx;

	let residual = 0;
	for (let index = 0; index < n; index++) {
		residual += (values[index]! - (meanY + slope * (index - meanX))) ** 2;
	}
	const stdError = n > 2 && sxx > 0 ? Math.sqrt(residual / (n - 2) / sxx) : Number.POSITIVE_INFINITY;
	return { slope, stdError };
}

function handleSlopes(samples: Sample[]): LifecycleReport["handlesPerCycle"] {
	const types = new Set(samples.flatMap((entry) => Object.keys(entry.handles)));
	const slopes: Record<string, number> = {};

	for (const type of types) {
		const series = samples.map((entry) => entry.handles[type] ?? 0);
		const fit = fitSlope(series);
		if (Math.abs(fit.slope) >= 0.5) {
			slopes[type] = Number(fit.slope.toFixed(2));
		}
	}
	return slopes;
}

function verdictFor(report: LifecycleReport, options: LifecycleOptions): LifecycleReport {
	const reasons: string[] = [];
	let verdict: LifecycleReport["verdict"] = "pass";

	if (report.commandsAfterDisappear > 0) {
		verdict = "leak";
		reasons.push(
			`${report.commandsAfterDisappear} command(s) referenced the key after willDisappear -- something started in onWillAppear is still running. Clear timers, listeners, and subscriptions in onWillDisappear.`,
		);
	}

	const growingHandles = Object.entries(report.handlesPerCycle).filter(
		([, slope]) => slope > options.maxHandlesPerCycle,
	);
	if (growingHandles.length > 0) {
		verdict = "leak";
		reasons.push(
			...growingHandles.map(
				([type, slope]) =>
					`${type} handles grow by ${slope} per appear/disappear cycle -- ${handleHint(type)}.`,
			),
		);
	}

	const retainedSlope = report.retainedBytesPerCycle;
	if (retainedSlope !== undefined && retainedSlope > options.maxBytesPerCycle) {
		const stdError = report.retainedSlopeStdError ?? Number.POSITIVE_INFINITY;
		const breakdown = `JS heap ${formatBytes(report.heapBytesPerCycle ?? 0)}/cycle, external ${formatBytes(report.externalBytesPerCycle ?? 0)}/cycle`;

		if (retainedSlope > 2 * stdError) {
			verdict = "leak";
			reasons.push(
				`retained memory grows ${formatBytes(retainedSlope)} per cycle (${breakdown}; standard error ${formatBytes(stdError)}), above the ${formatBytes(options.maxBytesPerCycle)} threshold.`,
			);
		} else if (verdict === "pass") {
			verdict = "inconclusive";
			reasons.push(
				`retained memory trends ${formatBytes(retainedSlope)} per cycle (${breakdown}) but the standard error is ${formatBytes(stdError)}, so it is not distinguishable from noise. Re-run with more --cycles.`,
			);
		}
	}

	if (report.measurement === "rss" && verdict === "pass") {
		const rssSlope = report.rssBytesPerCycle;
		if (rssSlope !== undefined && rssSlope > options.maxBytesPerCycle) {
			verdict = "inconclusive";
			reasons.push(
				`RSS grows ${formatBytes(rssSlope)} per cycle, but RSS includes allocator behaviour the harness cannot force to settle. Confirm by hand.`,
			);
		}
	}

	if (report.settleTimeouts > 0) {
		reasons.push(
			`the plugin never stopped sending frames in ${report.settleTimeouts} wait(s) -- something is emitting continuously. Measurements were taken anyway and may be noisy.`,
		);
	}

	if (report.otherLiveActions > 0) {
		reasons.push(
			`${report.otherLiveActions} other action instance(s) were live during this run and their traffic is mixed into the measurements. Restart the session to isolate: sdtest close && sdtest start ...`,
		);
	}

	if (reasons.length === 0) {
		reasons.push("No growth in heap or handles across cycles, and no commands after willDisappear.");
	}
	return { ...report, verdict, reasons };
}

/** What each libuv handle type usually means when it grows once per cycle. */
const HANDLE_HINTS = {
	Timeout: "a setTimeout/setInterval is never cleared; keep the id and clearInterval it in onWillDisappear",
	Immediate: "a setImmediate chain keeps rescheduling itself",
	TCPSocketWrap: "a TCP connection is opened per appear and never closed",
	TCPWRAP: "a TCP connection is opened per appear and never closed",
	TLSWRAP: "a TLS connection is opened per appear and never closed",
	FSReqCallback: "file handles are opened per appear and never closed",
	FSEventWrap: "a file watcher is added per appear and never closed",
	ChildProcess: "a child process is spawned per appear and never killed",
	MessagePort: "a worker or MessageChannel port is created per appear and never closed",
} as const;

function handleHint(type: string): string {
	for (const [name, hint] of Object.entries(HANDLE_HINTS)) {
		if (name === type) {
			return hint;
		}
	}
	return "this resource is created on appear and never released on disappear";
}

function formatBytes(value: number): string {
	if (!Number.isFinite(value)) {
		return "unknown";
	}
	const sign = value < 0 ? "-" : "";
	const magnitude = Math.abs(value);
	if (magnitude < 1024) {
		return `${sign}${Math.round(magnitude)} B`;
	}
	if (magnitude < 1024 * 1024) {
		return `${sign}${(magnitude / 1024).toFixed(1)} KiB`;
	}
	return `${sign}${(magnitude / 1024 / 1024).toFixed(2)} MiB`;
}
