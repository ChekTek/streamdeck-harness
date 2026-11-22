# streamdeck-harness

A headless test harness for Stream Deck plugins. It runs the real plugin against a mock
Stream Deck. You do not need a device, and the Stream Deck app is not affected.

## Install

Node.js 24 or later is necessary.

```bash
npm install -g @chektek/streamdeck-harness
sdtest install-browser    # downloads Chromium one time
```

To install from source:

```bash
pnpm install
pnpm build
pnpm link --global
sdtest install-browser
```

## Commands

| Task                                           | Command                                     |
| ---------------------------------------------- | ------------------------------------------- |
| See what a key shows                           | `screenshot`                                |
| Check SVG files for Stream Deck                | `lint-svg`                                  |
| Find resources that an action does not release | `check-lifecycle`                           |
| Test the property inspector                    | `pi-open`, `pi-set`, `pi-type`, `pi-fields` |
| Read the messages and logs                     | `events`, `violations`, `logs`              |

Run `sdtest help` for the full list. Add `--json` to a command for JSON output.

## Sessions

A session is a background process that holds one plugin. Each command connects to it.

```bash
sdtest -s=demo start path/to/plugin
sdtest -s=demo add com.example.plugin.action --settings '{"mode":"set"}'
sdtest -s=demo press com.example.plugin.action
sdtest -s=demo screenshot com.example.plugin.action
sdtest -s=demo close
```

- Refer to an action by its context id, or by its action UUID when only one instance exists.
- A session stops after 15 minutes without use. Change this with `--idle-timeout`.
- `sdtest list` shows the sessions.

## Property inspector

```bash
sdtest -s=demo pi-open com.example.plugin.action
sdtest -s=demo pi-set mode toggle
sdtest -s=demo pi-type hours 12x7
sdtest -s=demo pi-type hours 12x7 --paste
```

- `pi-set` assigns the value of a field and dispatches `input` and `change`. It sends no key
  events.
- `pi-type` types into a text field with real keyboard input. Use it to test input filters
  (`beforeinput`, key handlers). Each character sends `keydown`, `keypress`, `beforeinput`,
  `input` and `keyup`.
- `pi-type` first deletes the current value with Backspace. With `--no-clear`, the text goes
  at the end of the current value.
- `--paste` inserts the text with one clipboard paste (Ctrl+V, or Cmd+V on macOS). The field
  gets `paste`, then `beforeinput` and `input` with the input type `insertFromPaste`. The
  headless browser has its own clipboard. The system clipboard does not change.
- The focus stays in the field. `--blur` moves the focus out, and then `change` fires.

In a scenario, the step is `piType` with `text`, and optionally `clear`, `paste` and `blur`.

## Scenarios

A scenario file runs a full check in one command. The exit code is not zero when a step fails.

```bash
sdtest run examples/lifecycle-fixture.yaml
```

See [examples](examples) for the steps and assertions.

## Mock host

The mock supports the SDK v3 protocol for plugins and property inspectors. It records
unknown events.

- A request with an `id` gets a response with the same `id`.
- `setSettings` from the plugin notifies only the property inspector. `setSettings` from the
  property inspector notifies only the plugin.
- Not supported: dials, multi-actions and profile switching. The mock records these commands
  but does nothing.

## Plugin types

- **Node** plugins start with `--inspect`. The harness reads exact memory and handle counts.
  Use `--node <path>` to select the Node binary.
- **Native** plugins start directly. The lifecycle check uses RSS and the commands that the
  plugin sends after `willDisappear`.

## Limits

- Chromium draws the screenshots. It supports more SVG than Stream Deck. Trust `lint-svg`
  more than the screenshot.
- The title text is an estimate.
- The property inspector width is an estimate (345 px). Change it with `--width`.
- RSS is not exact. For native plugins, memory results are only an indication.
- The plugin runs for real. It can call APIs, start processes and open URLs. Use test
  credentials.

## Fixtures

[`fixtures/leaky`](fixtures/leaky) is a plugin with actions that leak in known ways, and one
action that does not leak.

```bash
sdtest -s=fix start fixtures/leaky
sdtest -s=fix check-lifecycle com.sdtest.fixture.timer-leak --cycles 6 --interact none
sdtest -s=fix close
```

Start a new session for each check. A leaking action adds noise to the next check.

## Release

Each push to `main` stages a new version on npm and creates a GitHub release. The version is
public on npm after a maintainer approves it. The major and minor numbers come from
`package.json`. The run number of the workflow is the patch number.

## License

MIT
