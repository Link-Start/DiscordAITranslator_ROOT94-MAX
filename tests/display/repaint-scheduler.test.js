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

test("a permanently unconfirmed mounted row stops after three targeted repaint attempts", async () => {
	const timers = [];
	const renders = [];
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => {
			renders.push(messageIds);
			return Promise.resolve({missingIds: messageIds, retryIds: messageIds});
		},
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});

	scheduler.schedule("c1", "m1", 0);
	for (let attempt = 0; attempt < 3; attempt++) {
		const timer = timers.shift();
		assert.ok(timer, `attempt ${attempt + 1} must be scheduled`);
		timer.callback();
		await Promise.resolve();
	}

	assert.deepEqual(renders, [["m1"], ["m1"], ["m1"]]);
	assert.equal(timers.length, 0, "the targeted retry path must not loop forever");
});

test("an ordinary duplicate schedule cannot reset an in-flight retry budget", async () => {
	const timers = [];
	const renders = [];
	const outcomes = [];
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => {
			renders.push(messageIds);
			return Promise.resolve({missingIds: messageIds, retryIds: messageIds});
		},
		onRenderOutcome: report => outcomes.push(report),
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});

	scheduler.schedule("c1", "m1", 0, 1, "batch-1");
	for (let attempt = 0; attempt < 3; attempt++) {
		const timer = timers.shift();
		assert.ok(timer, `attempt ${attempt + 1} must be scheduled`);
		timer.callback();
		await Promise.resolve();
		// A normal display event for the same row may arrive between retries. It must
		// join the current request instead of resetting it to attempt one.
		if (attempt < 2) scheduler.schedule("c1", "m1", 0, 1, "batch-1");
	}

	assert.equal(renders.length, 3);
	assert.equal(timers.length, 0);
	assert.deepEqual(outcomes.at(-1).outcome.exhaustedIds, ["m1"]);
	assert.deepEqual(outcomes.at(-1).trackingKeysByMessageId, {m1: ["batch-1"]});
});

test("a duplicate scheduled before an in-flight paint settles cannot create an early or fourth repaint", async () => {
	const timers = [];
	const resolvers = [];
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: () => new Promise(resolve => resolvers.push(resolve)),
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});

	scheduler.schedule("c1", "m1", 0);
	for (let attempt = 1; attempt <= 3; attempt++) {
		const timer = timers.shift();
		assert.ok(timer, `attempt ${attempt} must be scheduled`);
		timer.callback();
		scheduler.schedule("c1", "m1", 0);
		assert.equal(timers.length, 0, "an in-flight duplicate waits for the current outcome");
		resolvers.shift()({missingIds: ["m1"], retryIds: ["m1"]});
		await Promise.resolve();
		if (attempt < 3) assert.equal(timers[0].delay, BUSY_RETRY_DELAY_MS);
	}

	assert.equal(timers.length, 0, "attempt three exhausts and removes its in-flight duplicate");
});

test("another message may paint while an active row remains single-flight", async () => {
	const timers = [];
	const renders = [];
	let resolveFirst;
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => {
			renders.push(messageIds);
			if (renders.length === 1) return new Promise(resolve => {resolveFirst = resolve;});
			return Promise.resolve({confirmedIds: messageIds});
		},
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});

	scheduler.schedule("c1", "m1", 0);
	timers.shift().callback();
	scheduler.schedule("c1", "m1", 0);
	scheduler.schedule("c1", "m2", 0);
	timers.shift().callback();
	await Promise.resolve();

	assert.deepEqual(renders, [["m1"], ["m2"]]);
	resolveFirst({confirmedIds: ["m1"]});
	await Promise.resolve();
});

test("each targeted repaint reports its channel and render outcome to status tracking", async () => {
	const timers = [];
	const reported = [];
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => Promise.resolve({confirmedIds: messageIds, missingIds: [], retryIds: []}),
		onRenderOutcome: report => reported.push(report),
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});

	scheduler.schedule("c1", "m1", 0);
	timers.shift().callback();
	await Promise.resolve();

	assert.deepEqual(reported, [{
		channelId: "c1",
		messageIds: ["m1"],
		outcome: {confirmedIds: ["m1"], missingIds: [], retryIds: []}
	}]);
});
