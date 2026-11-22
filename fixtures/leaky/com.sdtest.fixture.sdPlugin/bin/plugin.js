/** Fixture plugin for the lifecycle check. Each action leaks in a different way, or does not leak. */
const args = process.argv.slice(2);
const arg = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};

const port = arg("-port");
const uuid = arg("-pluginUUID");
const registerEvent = arg("-registerEvent");

const socket = new WebSocket(`ws://127.0.0.1:${port}`);

/** State for each context id. */
const timers = new Map();
const retained = new Map();

const send = (message) => socket.send(JSON.stringify(message));

socket.addEventListener("open", () => {
	send({ event: registerEvent, uuid });
});

socket.addEventListener("message", (message) => {
	const { event, action, context } = JSON.parse(message.data);

	if (event === "willAppear") {
		onWillAppear(action, context);
	} else if (event === "willDisappear") {
		onWillDisappear(action, context);
	} else if (event === "keyDown") {
		send({ event: "setTitle", context, payload: { title: "hit" } });
	}
});

function onWillAppear(action, context) {
	switch (action) {
		case "com.sdtest.fixture.clean":
			timers.set(
				context,
				setInterval(() => {}, 50),
			);
			break;

		case "com.sdtest.fixture.timer-leak":
			// Not cleared and not visible on the socket. Only the handle count shows it.
			setInterval(() => {}, 50);
			break;

		case "com.sdtest.fixture.chatty-leak":
			// Not cleared. It continues to draw to a key that is gone.
			setInterval(() => send({ event: "setTitle", context, payload: { title: String(Date.now()) } }), 50);
			break;

		case "com.sdtest.fixture.heap-leak": {
			// Buffers are outside the V8 heap. Only `external` shows this.
			const existing = retained.get("buffers") ?? [];
			existing.push(Buffer.alloc(512 * 1024, 1));
			retained.set("buffers", existing);
			break;
		}

		case "com.sdtest.fixture.js-heap-leak": {
			const existing = retained.get("objects") ?? [];
			existing.push(Array.from({ length: 20000 }, (_, index) => ({ index, label: `retained-${index}` })));
			retained.set("objects", existing);
			break;
		}

		default:
			break;
	}
}

function onWillDisappear(action, context) {
	if (action === "com.sdtest.fixture.clean") {
		clearInterval(timers.get(context));
		timers.delete(context);
	}
	// The other actions release nothing.
}
