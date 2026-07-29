const test = require("node:test");
const assert = require("node:assert/strict");
const {createDisplayRepaintScheduler, BUSY_RETRY_DELAY_MS} = require("../../src/display/repaint-scheduler");

test("a render interrupted by user interaction is retried as one scheduled repaint", async () => {
	const timers = [];
	const renders = [];
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => {
			renders.push(messageIds);
			return Promise.resolve(renders.length === 1 ? {retryIds: messageIds} : {confirmedIds: messageIds});
		},
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		lastRenderUsedFallback: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});

	scheduler.schedule("c1", "m1", 0);
	const initialTimer = timers.shift();
	assert.equal(initialTimer.delay, 0);
	initialTimer.callback();
	await Promise.resolve();

	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, BUSY_RETRY_DELAY_MS);
	timers.shift().callback();
	await Promise.resolve();
	assert.deepEqual(renders, [["m1"], ["m1"]]);
});
