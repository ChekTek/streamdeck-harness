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

Run `sdtest help` for the full list, and `sdtest <command> --help` for the arguments of one
command. Add `--json` to a command for JSON output.

`events` shows one line for each message. Add `--payload` to see the payload of each message.

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
- `close` deletes the screenshots and other artifacts of the session. Add `--keep-artifacts`
  to keep them.

`start` can set the state that the plugin finds when it starts:

```bash
sdtest -s=demo start path/to/plugin --global-settings '{"apiKey":"test"}' --env '{"HOME":"/tmp/home"}'
```

- `--global-settings` puts global settings in the host before the plugin starts. The plugin
  gets them when it sends `getGlobalSettings`.
- `--env` sets environment variables for the plugin process. The plugin also gets the
  environment of the shell that ran `start`.
- `--dotenv` reads environment variables from a `.env` file. A value from `--env` wins.

Keep secrets out of the command line. Put secret environment variables in a `.env` file that
git ignores and pass it with `--dotenv`. The session state then holds only the path of the
file. For secret settings, `--global-settings @secrets.json` reads the JSON from a file. The
session state holds a copy of the values of `--global-settings` and `--env` only until the
daemon has read them. Only the owner can read the session state.

## Property inspector

```bash
sdtest -s=demo pi-open com.example.plugin.action
sdtest -s=demo pi-fields
sdtest -s=demo pi-set mode toggle
sdtest -s=demo pi-type hours 12x7
sdtest -s=demo pi-type hours 12x7 --paste
```

`pi-open` returns when the page is ready. The page is ready when:

- It called `connectElgatoStreamDeckSocket` and registered with the mock host.
- No frames are in flight between the page and the host. This covers requests that the host
  answers, such as `getSettings` and `getGlobalSettings`.
- Each component with a `setting` attribute completed its update.
- The body is visible.

The output shows `ready` and the time that the command waited. After the time limit, the
command returns with `ready: false` and the reason. Change the limit with `--timeout`
(default: 5000 ms). With `--no-wait`, the command waits only for the connection.

`ready: true` does not guarantee answers from the plugin to `sendToPlugin`, such as SDPI
`datasource` requests. Use `wait-quiet --quiet <ms>` to allow plugin traffic to settle, then
check the expected fields or events. A quiet period is not proof that the plugin answered:
choose an interval that covers its expected response time.

A scenario `piOpen` step fails if the page is not ready. Set `timeout` in milliseconds to
change its limit, or `wait: false` to check only the connection.

- `pi-visible <selector-or-text>` tells if an element is shown. An element in a hidden parent,
  such as a tab that is not selected, is not shown.
- `pi-set` assigns the value of a field and dispatches `input` and `change`. It sends no key
  events.
- `pi-type` types into a text field with real keyboard input. Use it to test input filters
  (`beforeinput`, key handlers). Each character sends `keydown`, `keypress`, `beforeinput`,
  `input` and `keyup`.
- The keys are those of a US keyboard layout. Shift is held for a character that needs it
  (`A`, `!`). A character that has no key on a US keyboard sends only `beforeinput` and `input`.
- `pi-type` first deletes the current value with Backspace. With `--no-clear`, the text goes
  at the end of the current value.
- `--paste` inserts the text with one clipboard paste (Ctrl+V, or Cmd+V on macOS). The field
  gets `paste`, then `beforeinput` and `input` with the input type `insertFromPaste`. The
  headless browser has its own clipboard. The system clipboard does not change.
- The focus stays in the field. `--blur` moves the focus out, and then `change` fires.

In a scenario, the step is `piType` with `text`, and optionally `clear`, `paste` and `blur`.
The steps `piVisible` and `piHidden` fail when an element is not in that state.

## Scenarios

A scenario file runs a full check in one command. The exit code is not zero when a step fails.

```bash
sdtest run examples/lifecycle-fixture.yaml
```

See [examples](examples) for the steps and assertions.

The top-level keys `globalSettings`, `env` and `dotenv` do the same as `--global-settings`,
`--env` and `--dotenv` of `start`. The path in `dotenv` is relative to the scenario file. To change global settings while the plugin runs, use a `setGlobalSettings` step.

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
action that does not leak. Its property inspector loads local and global settings before
showing its fields. Run `sdtest run examples/pi-readiness.yaml` to check readiness and
immediate field input.

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
