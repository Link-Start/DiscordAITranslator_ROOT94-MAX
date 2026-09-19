const test = require("node:test");
const assert = require("node:assert/strict");
const {createDeferredFieldWriter} = require("../src/settings/deferred-field-writes");

function createHarness() {
	const timers = [];
	const writes = [];
	const writer = createDeferredFieldWriter({
		write: (key, value) => writes.push([key, value]),
		setTimer: callback => {
			const timer = {callback, cleared: false};
			timers.push(timer);
			return timer;
		},
		clearTimer: timer => {timer.cleared = true;}
	});
	return {writer, timers, writes};
}

test("rapid field changes collapse into one persisted value", () => {
	const {writer, timers, writes} = createHarness();
	writer.schedule("openai\0key", "a");
	writer.schedule("openai\0key", "ab");
	assert.equal(timers[0].cleared, true);
	timers[1].callback();
	assert.deepEqual(writes, [["openai\0key", "ab"]]);
	assert.equal(writer.pendingCount(), 0);
});

test("blur and lifecycle flushes persist every pending field", () => {
	const {writer, writes} = createHarness();
	writer.schedule("openai\0key", "secret");
	writer.schedule("openai\0model", "gpt-4.1");
	assert.equal(writer.flush("openai\0key"), true);
	assert.equal(writer.flushAll(), 1);
	assert.deepEqual(writes, [["openai\0key", "secret"], ["openai\0model", "gpt-4.1"]]);
});
