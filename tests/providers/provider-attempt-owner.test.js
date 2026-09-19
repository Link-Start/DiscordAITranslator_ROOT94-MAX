const test = require("node:test");
const assert = require("node:assert/strict");
const {createProviderCompatibilityBudget, createProviderAttemptOwner} = require("../../src/providers/provider-attempt-owner");

test("attempt owner tracks exact resources and finishes once", () => {
	const cleared = [];
	const owner = createProviderAttemptOwner({clearTimeout: timer => cleared.push(timer)});
	const token = owner.begin({logicalRequestId: "private-logical-id", role: "primary"});
	assert.equal(owner.attachReader(token, {cancel() {}}), true);
	assert.equal(owner.attachDecoder(token, {}), true);
	assert.equal(owner.attachTimer(token, 42), true);
	assert.equal(owner.setBufferBytes(token, 123), true);
	assert.deepEqual(owner.getSnapshot(), {generation: 0, active: 1, highWater: 1, controllerCount: 1, readerCount: 1, decoderCount: 1, timerCount: 1, logicalSignalCount: 0, bufferBytes: 123});
	assert.equal(JSON.stringify(owner.getSnapshot()).includes("private-logical-id"), false);
	assert.equal(owner.finish(token), true);
	assert.equal(owner.finish(token), false);
	assert.deepEqual(cleared, [42]);
	assert.deepEqual(owner.getSnapshot(), {generation: 0, active: 0, highWater: 1, controllerCount: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
});

test("abort synchronously signals the controller cancels the reader and rejects late writes", async () => {
	const owner = createProviderAttemptOwner();
	const token = owner.begin();
	let readerCancels = 0;
	owner.attachReader(token, {cancel() {readerCancels++; return Promise.resolve();}});
	const signal = owner.getSignal(token);
	assert.equal(signal.aborted, false);
	assert.equal(owner.abort(token, "edited"), true);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(signal.aborted, true);
	assert.equal(readerCancels, 1);
	assert.equal(owner.owns(token), false);
	assert.equal(owner.attachReader(token, {}), false);
	assert.equal(owner.setBufferBytes(token, 999), false);
	assert.equal(owner.abort(token), false);
});

test("abortAll resolves an existing drain and invalidates the old generation", async () => {
	const owner = createProviderAttemptOwner();
	const tokens = [owner.begin(), owner.begin(), owner.begin()];
	const draining = owner.drain();
	assert.equal(owner.abortAll("plugin-stopped"), 3);
	await draining;
	assert.equal(owner.getSnapshot().generation, 1);
	assert.equal(owner.getSnapshot().active, 0);
	for (const token of tokens) assert.equal(owner.finish(token), false);
	const fresh = owner.begin();
	assert.equal(fresh.generation, 1);
	assert.equal(owner.finish(fresh), true);
});

test("one hundred cancellation cycles leave every attempt resource at zero", () => {
	const owner = createProviderAttemptOwner({clearTimeout() {}});
	for (let cycle = 0; cycle < 100; cycle++) {
		const logical = new AbortController();
		const token = owner.begin({logicalRequestId: `logical-${cycle}`, signal: logical.signal});
		owner.attachReader(token, {cancel() {}});
		owner.attachDecoder(token, {});
		owner.attachTimer(token, cycle + 1);
		owner.setBufferBytes(token, 1024);
		logical.abort("cycle");
	}
	assert.deepEqual(owner.getSnapshot(), {generation: 0, active: 0, highWater: 1, controllerCount: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
});

test("an already-cancelled logical signal never leaves a physical attempt owned", () => {
	const logical = new AbortController();
	logical.abort("stale-before-dispatch");
	const owner = createProviderAttemptOwner();
	const token = owner.begin({logicalRequestId: "request-1", signal: logical.signal});
	assert.equal(owner.owns(token), false);
	assert.equal(owner.getSnapshot().active, 0);
	assert.equal(owner.getSnapshot().logicalSignalCount, 0);
});

test("one logical compatibility budget allows at most one retry across reasons", () => {
	const budget = createProviderCompatibilityBudget();
	assert.equal(budget.consume("stream_to_nonstream"), true);
	assert.equal(budget.consume("reasoning_shape"), false);
	assert.deepEqual(budget.getSnapshot(), {limit: 1, used: 1, remaining: 0, reasons: ["stream_to_nonstream"]});
	assert.equal(Object.isFrozen(budget.getSnapshot()), true);
	assert.equal(Object.isFrozen(budget.getSnapshot().reasons), true);
});
