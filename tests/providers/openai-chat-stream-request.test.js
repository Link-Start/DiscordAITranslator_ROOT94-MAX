const test = require("node:test");
const assert = require("node:assert/strict");
const {createProviderAttemptOwner} = require("../../src/providers/provider-attempt-owner");
const {createAbortableProviderTransport} = require("../../src/providers/abortable-provider-transport");
const {createOpenAiChatStreamRequest} = require("../../src/providers/openai-chat-stream-request");

function response({status = 200, contentType = "text/event-stream", body = "", reader = null} = {}) {
	return {
		status,
		headers: {get: name => name.toLowerCase() === "content-type" ? contentType : null},
		text: () => Promise.resolve(body),
		body: reader ? {getReader: () => reader} : null
	};
}

function readerFromStrings(parts, {onRead = () => {}} = {}) {
	const chunks = parts.map(part => new TextEncoder().encode(part));
	let index = 0;
	let cancels = 0;
	return {
		async read() {
			onRead(index);
			if (index >= chunks.length) return {done: true, value: undefined};
			return {done: false, value: chunks[index++]};
		},
		cancel() {cancels++; return Promise.resolve();},
		getCancelCount: () => cancels
	};
}

function createHarness(fetchFunction, {now = Date.now, setTimeout = undefined} = {}) {
	const owner = createProviderAttemptOwner();
	const transport = createAbortableProviderTransport(Object.assign({fetchFunction, attemptOwner: owner}, setTimeout ? {setTimeout} : {}));
	const requester = createOpenAiChatStreamRequest({transport, attemptOwner: owner, now});
	return {owner, transport, request: requester.request};
}

test("OpenAI Chat stream request adds stream true, measures body TTFT and releases every resource", async () => {
	let fetchOptions = null;
	let clock = 100;
	const reader = readerFromStrings([
		`data: ${JSON.stringify({choices: [{delta: {role: "assistant", reasoning_content: "hidden"}, finish_reason: null}]})}\n\n`,
		`data: ${JSON.stringify({choices: [{delta: {content: "你"}, finish_reason: null}]})}\n\n`,
		`data: ${JSON.stringify({choices: [{delta: {content: "好"}, finish_reason: "stop"}], usage: {completion_tokens: 2}})}\n\n`,
		"data: [DONE]\n\n"
	], {onRead(index) {clock = [110, 145, 160, 175, 180][index] || clock;}});
	const harness = createHarness((_url, options) => {
		fetchOptions = options;
		return Promise.resolve(response({reader}));
	}, {now: () => clock});
	const payload = {model: "fixture", messages: [{role: "user", content: "hello"}], reasoning_effort: "low"};
	const result = await harness.request({
		url: "https://fixture.test/v1/chat/completions",
		requestOptions: {method: "post", headers: {Authorization: "Bearer fixture"}},
		payload,
		logicalRequestId: "live-1",
		role: "primary",
		isCurrent: () => true
	});

	assert.equal(JSON.parse(fetchOptions.body).stream, true);
	assert.equal(JSON.parse(fetchOptions.body).reasoning_effort, "low", "streaming never strips reasoning controls");
	assert.equal(fetchOptions.timeout, 0);
	assert.deepEqual(payload, {model: "fixture", messages: [{role: "user", content: "hello"}], reasoning_effort: "low"}, "the original payload is immutable input");
	assert.equal(result.mode, "stream");
	assert.equal(result.text, "你好");
	assert.equal(result.ttftMs, 45);
	assert.equal(result.streamChunkCount, 2);
	assert.equal(result.usage.completion_tokens, 2);
	assert.equal(reader.getCancelCount(), 1);
	assert.equal(harness.owner.getSnapshot().active, 0);
	assert.equal(harness.owner.getSnapshot().readerCount, 0);
	assert.equal(harness.owner.getSnapshot().timerCount, 0);
});

test("a JSON 200 response is returned from the original streaming attempt without another fetch", async () => {
	let fetches = 0;
	const body = JSON.stringify({choices: [{message: {content: "直接 JSON"}}]});
	const harness = createHarness(() => {
		fetches++;
		return Promise.resolve(response({contentType: "application/json", body}));
	});
	const result = await harness.request({url: "https://fixture.test", requestOptions: {}, payload: {model: "m"}, logicalRequestId: "live-json"});
	assert.equal(fetches, 1);
	assert.equal(result.mode, "response");
	assert.equal(result.status, 200);
	assert.equal(result.body, body);
	assert.equal(result.contentType, "application/json");
	assert.equal(harness.owner.getSnapshot().active, 0);
});

test("a truncated stream after body text discards its attempt buffer", async () => {
	const reader = readerFromStrings([`data: ${JSON.stringify({choices: [{delta: {content: "partial"}, finish_reason: null}]})}\n\n`]);
	const harness = createHarness(() => Promise.resolve(response({reader})));
	const result = await harness.request({url: "https://fixture.test", requestOptions: {}, payload: {}, logicalRequestId: "live-truncated"});
	assert.equal(result.mode, "error");
	assert.equal(result.errorKind, "truncated");
	assert.equal(result.hadText, true);
	assert.equal(Object.prototype.hasOwnProperty.call(result, "text"), false, "partial text never leaves the failed attempt");
	assert.equal(harness.owner.getSnapshot().bufferBytes, 0);
	assert.equal(harness.owner.getSnapshot().active, 0);
});

test("logical cancellation physically aborts an open reader and settles once", async () => {
	const logical = new AbortController();
	let rejectRead = null;
	let cancels = 0;
	const reader = {
		read: () => new Promise((_resolve, reject) => {rejectRead = reject;}),
		cancel() {cancels++; if (rejectRead) rejectRead(new Error("cancelled")); return Promise.resolve();}
	};
	const harness = createHarness(() => Promise.resolve(response({reader})));
	const pending = harness.request({url: "https://fixture.test", requestOptions: {}, payload: {}, logicalRequestId: "live-cancel", signal: logical.signal});
	await new Promise(resolve => setImmediate(resolve));
	logical.abort("edited");
	const result = await pending;
	assert.equal(result.mode, "error");
	assert.equal(result.errorKind, "abort");
	assert.equal(cancels, 1);
	assert.equal(harness.owner.getSnapshot().active, 0);
	assert.equal(harness.owner.getSnapshot().logicalSignalCount, 0);
});

test("the plugin timeout physically aborts an open stream and reports timeout", async () => {
	const timers = [];
	let rejectRead = null;
	const reader = {
		read: () => new Promise((_resolve, reject) => {rejectRead = reject;}),
		cancel() {if (rejectRead) rejectRead(new Error("timeout")); return Promise.resolve();}
	};
	const harness = createHarness(() => Promise.resolve(response({reader})), {setTimeout(callback) {timers.push(callback); return timers.length;}});
	const pending = harness.request({url: "https://fixture.test", requestOptions: {}, payload: {}, logicalRequestId: "live-timeout", timeoutMs: 10});
	await new Promise(resolve => setImmediate(resolve));
	timers[0]();
	const result = await pending;
	assert.equal(result.mode, "error");
	assert.equal(result.errorKind, "timeout");
	assert.equal(harness.owner.getSnapshot().active, 0);
	assert.equal(harness.owner.getSnapshot().timerCount, 0);
});
