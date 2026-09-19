const test = require("node:test");
const assert = require("node:assert/strict");
const {createLiveRequestRegistry} = require("../src/orchestrator/live-request-registry");
const {createProviderAttemptOwner} = require("../src/providers/provider-attempt-owner");

function createRegistry(overrides = {}) {
	return createLiveRequestRegistry(Object.assign({
		isRuntimeActive: () => true,
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}:${message.content}`
	}, overrides));
}

test("live request invalidation synchronously aborts its logical signal", () => {
	const registry = createRegistry();
	const request = registry.createRequest({id: "m1", content: "before"}, "c1");
	const events = [];
	request.signal.addEventListener("abort", () => events.push(["abort", request.signal.reason]));

	assert.equal(request.signal.aborted, false);
	registry.invalidateRequests("c1");

	assert.equal(request.signal.aborted, true);
	assert.deepEqual(events, [["abort", "channel-invalidated"]]);
	assert.equal(registry.isRequestCurrent(request), false);
});

test("finish edit delete and restart retire each exact logical cancellation source once", () => {
	const registry = createRegistry();
	const finished = registry.createRequest({id: "finish", content: "a"}, "c1");
	const edited = registry.createRequest({id: "edit", content: "b"}, "c1");
	const deleted = registry.createRequest({id: "delete", content: "c"}, "c1");
	const restarted = registry.createRequest({id: "restart", content: "d"}, "c1");

	assert.equal(registry.finishRequest(finished), true);
	assert.equal(registry.finishRequest(finished), false);
	assert.equal(registry.invalidateRequestForMessage("edit", "c1", "c1:changed"), true);
	assert.equal(registry.removeMessage("delete", "c1"), true);
	registry.restartRequestGeneration();

	assert.equal(finished.signal.reason, "request-finished");
	assert.equal(edited.signal.reason, "source-invalidated");
	assert.equal(deleted.signal.reason, "source-deleted");
	assert.equal(restarted.signal.reason, "runtime-restarted");
});

test("logical cancellation synchronously aborts an attached physical attempt and zeros resources", () => {
	const clearedTimers = [];
	let readerCancels = 0;
	const registry = createRegistry();
	const request = registry.createRequest({id: "m1", content: "before"}, "c1");
	const attempts = createProviderAttemptOwner({clearTimeout: timer => clearedTimers.push(timer)});
	const token = attempts.begin({logicalRequestId: request.id, role: "primary", signal: request.signal});
	const physicalSignal = attempts.getSignal(token);
	attempts.attachReader(token, {cancel() {readerCancels++; return Promise.resolve();}});
	attempts.attachDecoder(token, {});
	attempts.attachTimer(token, "timer-1");
	attempts.setBufferBytes(token, 17);

	registry.invalidateRequests("c1");

	assert.equal(physicalSignal.aborted, true);
	assert.equal(readerCancels, 1);
	assert.deepEqual(clearedTimers, ["timer-1"]);
	assert.deepEqual(attempts.getSnapshot(), {
		generation: 0,
		active: 0,
		highWater: 1,
		controllerCount: 0,
		readerCount: 0,
		decoderCount: 0,
		timerCount: 0,
		logicalSignalCount: 0,
		bufferBytes: 0
	});
});
