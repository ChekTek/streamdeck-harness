# streamdeck-harness

Headless test harness for Stream Deck plugins. It mocks the Stream Deck backend, launches
the real plugin process, and drives it from a CLI — so a plugin can be exercised without
installing it, without a device, and without taking over the desktop.

Everything runs detached and headless. The harness never links into Stream Deck's plugins
folder and never emits a `streamdeck://` URL, so a running Stream Deck app is unaffected.

```bash
pnpm install
pnpm build
pnpm browser          # one-time: download Chromium for Playwright
pnpm link --global    # optional: put `sdtest` on PATH
```

## What it checks

| Question | Command |
|---|---|
| What does this key actually render? | `screenshot` |
| Will this artwork survive Stream Deck's renderer? | `lint-svg` |
| Does the action release what `onWillAppear` acquired? | `check-lifecycle` |
| Does the property inspector work, and what does it save? | `pi-open`, `pi-set`, `pi-fields` |
| What did the plugin actually say over the wire? | `events`, `violations`, `logs` |

## Sessions

A session is a detached daemon holding one plugin process, the mock host, and a headless
Chromium. Commands are short-lived clients against it, like `playwright-cli`.

```bash
sdtest -s=scp start ~/Code/plugin-steam-connect-pro
sdtest -s=scp add com.chektek.steam-connect-pro.status --settings '{"mode":"set","status":"online"}'
sdtest -s=scp press com.chektek.steam-connect-pro.status
sdtest -s=scp screenshot com.chektek.steam-connect-pro.status
sdtest -s=scp close
```

Add `--json` to any command for machine-readable output. Sessions self-terminate after
`--idle-timeout` minutes (default 15). `sdtest list` shows what is running.

An action is referenced by its context id, or by its action UUID when only one instance of
it exists — which is the usual case.

## Scenarios

A whole check in one call, which is the right shape for CI and for agents:

```bash
sdtest run examples/steam-connect-pro.yaml
```

See [examples/steam-connect-pro.yaml](examples/steam-connect-pro.yaml) for the step and
assertion vocabulary. Exit code is non-zero when any step fails.

## What the mock implements

The full SDK v3 plugin and property-inspector protocol: every documented event and command,
plus `resources`, `secrets`, and the optional `id` used by experimental message identifiers.
Unknown events are recorded rather than dropped.

Two behaviours are worth calling out because plugins depend on them:

- **`id` echo.** A `getSettings` / `getGlobalSettings` / `getResources` / `getSecrets`
  carrying an `id` gets its response tagged with the same `id`. Plugins that set
  `useExperimentalMessageIdentifiers = true` deadlock at startup without this.
- **Settings propagate to the other side only.** A plugin's `setSettings` notifies the
  property inspector, not the plugin; the inspector's `setSettings` notifies the plugin.
  This is what makes the "never write settings back from `onDidReceiveSettings`" rule
  meaningful.

Out of scope for now: dials and encoders (`dialRotate`, `dialDown`, `touchTap`,
`setFeedback` are recorded but inert), multi-actions, and profile switching.

## Runtimes

- **Node** plugins (a `Nodejs` block in the manifest) are launched with `--inspect`, giving
  exact heap, external-memory, and active-handle readings. Use `--node <path>` to run under
  Stream Deck's bundled Node instead of whatever is on `PATH`.
- **Native** plugins (`CodePathMac` / `CodePathWin`, no `Nodejs` block) are spawned
  directly. No debugger, so the lifecycle check falls back to RSS plus the
  language-agnostic after-disappear check.

## Fidelity limits

Read these before trusting a green result.

- **Chromium is not QtWebEngine.** Key screenshots and property-inspector screenshots are
  rendered by Chromium, which supports far more than Stream Deck's Qt-based SVG renderer.
  A key can look perfect in a screenshot and render blank on hardware — which is exactly
  why `lint-svg` exists. Trust the lint over the picture.
- **Title rendering is an approximation.** Font size is scaled against a 72px key; Stream
  Deck's text shadow and glyph hinting are not reproduced.
- **The property inspector panel width is a guess** (345px default, `--width` to change).
- **RSS is noisy.** For native plugins the memory figure is indicative, not conclusive.
- **The harness mocks the protocol, not the plugin's side effects.** The plugin runs for
  real: pressing a key runs its actual handler, so it will hit live APIs, spawn processes,
  and open URLs. Commands sent through the SDK (`openUrl`, `switchToProfile`) are recorded
  and left inert, but a plugin that calls `open()` or `fetch()` itself is not intercepted.
  Point plugins at test credentials, and expect real network traffic.

## Fixtures

[`fixtures/leaky`](fixtures/leaky) is a dependency-free plugin whose actions leak in known,
distinct ways — an uncleared silent timer, a timer that keeps drawing to a dead key, a
retained `Buffer`, a retained JS array — plus one that behaves correctly. It exists so the
lifecycle check can be shown to detect what it claims to, rather than trusted:

```bash
sdtest -s=fix start fixtures/leaky
sdtest -s=fix check-lifecycle com.sdtest.fixture.timer-leak --cycles 6 --interact none
sdtest -s=fix close
```

Restart the session between checks: a leaking action keeps emitting, and its noise would
otherwise be mixed into the next measurement (the report says so when it happens).

[`fixtures/native`](fixtures/native) exercises the native launch path — no `Nodejs` block,
no inspector — standing in for a Rust or C++ plugin. macOS/Linux only.

## Layout

```
src/host/      the mock Stream Deck: protocol, devices, action instances, settings, transcript
src/plugin/    manifest parsing, process launch, Node inspector client, log reading
src/render/    key compositing, Chromium screenshots, the SVG Tiny 1.2 linter
src/pi/        property inspector static server and page driver
src/checks/    the appear/disappear lifecycle check
src/scenario/  declarative scenario runner
src/daemon/    session daemon and its RPC methods
src/cli/       argument parsing, output formatting, commands
```

Protocol types in `src/host/protocol.ts` are ported from the Rust SDK at
`~/Code/streamdeck-rs`, which models the SDK v3 surface more completely than the published
reference.

## License

MIT
