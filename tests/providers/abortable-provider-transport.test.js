const test = require("node:test");
const assert = require("node:assert/strict");
const {createProviderAttemptOwner} = require("../../src/providers/provider-attempt-owner");
const {createAbortableProviderTransport} = require("../../src/providers/abortable-provider-transport");

function deferred() {
	let resolve, reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {resolve = resolvePromise; reject = rejectPromise;});
	return {promise, resolve, reject};
}

function response({status = 200, contentType = "application/json", body = "ok", reader = null} = {}) {
	return {
		status,
		headers: {get: name => name.toLowerCase() === "content-type" ? contentType : null},
		text: () => Promise.resolve(body),
		body: reader ? {getReader: () => reader} : null
	};
}

test("text transport preserves response and finishes every attempt resource", async () => {
	const owner = createProviderAttemptOwner({clearTimeout() {}});
	const token = owner.begin();
	let options = null;
	const transport = createAbortableProviderTransport({attemptOwner: owner, fetchFunction: (_url, nextOptions) => {options = nextOptions; return Promise.resolve(response({body: "json"}));}, setTimeout: () => 7});
	const result = await transport.requestText({token, url: "fixture://text", options: {method: "POST"}, timeoutMs: 100});
	assert.deepEqual(result, {ok: true, errorKind: null, status: 200, body: "json", contentType: "application/json", retryAfterMs: null});
	assert.equal(options.method, "POST");
	assert.equal(options.timeout, 0);
	assert.ok(options.signal);
	assert.equal(owner.getSnapshot().active, 0);
	assert.equal(owner.getSnapshot().timerCount, 0);
});

test("timeout and external cancellation physically abort the fetch signal", async () => {
	for (const mode of ["timeout", "external"]) {
		const timers = [];
		const owner = createProviderAttemptOwner({clearTimeout() {}});
		const token = owner.begin();
		let signal = null;
		const transport = createAbortableProviderTransport({
			attemptOwner: owner,
			setTimeout(callback) {timers.push(callback); return timers.length;},
			fetchFunction(_url, options) {
				signal = options.signal;
				return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
			}
		});
		const running = transport.requestText({token, url: "fixture://hang", timeoutMs: 10});
		await new Promise(resolve => setImmediate(resolve));
		if (mode === "timeout") timers[0]();
		else owner.abort(token, "edited");
		const result = await running;
		assert.equal(signal.aborted, true);
		assert.equal(result.errorKind, mode === "timeout" ? "timeout" : "abort");
		assert.equal(owner.getSnapshot().active, 0);
	}
});

test("text transport captures numeric and HTTP-date Retry-After without exporting headers", async () => {
	for (const [raw, expected] of [["2.5", 2500], ["Thu, 01 Jan 1970 00:00:03 GMT", 2000]]) {
		const owner = createProviderAttemptOwner();
		const token = owner.begin();
		const transport = createAbortableProviderTransport({attemptOwner: owner, now: () => 1000, fetchFunction: () => Promise.resolve({status: 429, headers: {get: name => name.toLowerCase() === "retry-after" ? raw : "application/json"}, text: () => Promise.resolve("{}")})});
		const result = await transport.requestText({token, url: "fixture://retry", timeoutMs: 0});
		assert.equal(result.retryAfterMs, expected);
		assert.equal(Object.prototype.hasOwnProperty.call(result, "headers"), false);
	}
});

test("stream transport attaches an exact reader and finish releases it", async () => {
	let cancelCount = 0;
	const reader = {cancel() {cancelCount++; return Promise.resolve();}};
	const owner = createProviderAttemptOwner({clearTimeout() {}});
	const token = owner.begin();
	const transport = createAbortableProviderTransport({attemptOwner: owner, fetchFunction: () => Promise.resolve(response({contentType: "text/event-stream; charset=utf-8", reader})), setTimeout: () => 1});
	const handle = await transport.openStream({token, url: "fixture://stream"});
	assert.equal(handle.ok, true);
	assert.equal(handle.reader, reader);
	assert.equal(owner.getSnapshot().readerCount, 1);
	assert.equal(handle.finish(), true);
	assert.equal(handle.finish(), false);
	assert.equal(owner.getSnapshot().active, 0);
	assert.equal(cancelCount, 0);
});

test("wrong stream content type closes the attempt without exposing a reader", async () => {
	const owner = createProviderAttemptOwner();
	const token = owner.begin();
	const transport = createAbortableProviderTransport({attemptOwner: owner, fetchFunction: () => Promise.resolve(response({contentType: "application/json", body: "{}"}))});
	const result = await transport.openStream({token, url: "fixture://json", timeoutMs: 0});
	assert.deepEqual(result, {ok: false, errorKind: "content_type", status: 200, contentType: "application/json", body: "{}"});
	assert.equal(owner.getSnapshot().active, 0);
});

test("aborting an open stream cancels its reader exactly once", async () => {
	let cancels = 0;
	const reader = {cancel() {cancels++; return Promise.resolve();}};
	const owner = createProviderAttemptOwner();
	const token = owner.begin();
	const transport = createAbortableProviderTransport({attemptOwner: owner, fetchFunction: () => Promise.resolve(response({contentType: "text/event-stream", reader}))});
	const handle = await transport.openStream({token, url: "fixture://stream", timeoutMs: 0});
	assert.equal(handle.abort("channel-switch"), true);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(cancels, 1);
	assert.equal(handle.abort("again"), false);
	assert.equal(owner.getSnapshot().active, 0);
});
