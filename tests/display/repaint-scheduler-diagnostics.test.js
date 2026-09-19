const test = require("node:test");
const assert = require("node:assert/strict");
const {createDisplayRepaintScheduler, MAX_TARGETED_REPAINT_ATTEMPTS} = require("../../src/display/repaint-scheduler");

function createHarness({renderOutcomes = []} = {}) {
	const timers = [];
	let renderCalls = 0;
	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => {
			const outcome = renderOutcomes.length ? renderOutcomes.shift() : {confirmedIds: messageIds};
			renderCalls++;
			return Promise.resolve(typeof outcome === "function" ? outcome(messageIds) : outcome);
		},
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {}
	});
	return {
		scheduler,
		timers,
		getRenderCalls: () => renderCalls,
		async runNextTimer() {
			const timer = timers.shift();
			timer.callback();
			await Promise.resolve();
			await Promise.resolve();
		}
	};
}

test("diagnostics count scheduled, flushed, confirmed and deferred repaints", async () => {
	const harness = createHarness({renderOutcomes: [{confirmedIds: ["m1"], deferredIds: ["m2"]}]});
	harness.scheduler.schedule("c1", "m1", 0);
	harness.scheduler.schedule("c1", "m2", 0);
	await harness.runNextTimer();

	const diagnostics = harness.scheduler.getDiagnostics();
	assert.equal(diagnostics.scheduled, 2);
	assert.equal(diagnostics.flushes, 1);
	assert.equal(diagnostics.renderBatches, 1);
	assert.equal(diagnostics.confirmed, 1);
	assert.equal(diagnostics.deferred, 1);
	assert.equal(diagnostics.retries, 0);
	assert.equal(diagnostics.exhausted, 0);
	assert.equal(diagnostics.fullRepaints, 0);
});

test("diagnostics count retry scheduling and exhaustion separately", async () => {
	const harness = createHarness({renderOutcomes: [
		messageIds => ({retryIds: messageIds}),
		messageIds => ({retryIds: messageIds}),
		messageIds => ({retryIds: messageIds})
	]});
	harness.scheduler.schedule("c1", "m1", 0);
	for (let attempt = 0; attempt < MAX_TARGETED_REPAINT_ATTEMPTS; attempt++) await harness.runNextTimer();

	const diagnostics = harness.scheduler.getDiagnostics();
	assert.equal(diagnostics.renderBatches, MAX_TARGETED_REPAINT_ATTEMPTS);
	assert.equal(diagnostics.retries, MAX_TARGETED_REPAINT_ATTEMPTS - 1);
	assert.equal(diagnostics.exhausted, 1);
});

test("diagnostics expose a live resource snapshot for leak audits", async () => {
	const harness = createHarness();
	harness.scheduler.schedule("c1", "m1", 0);

	let resources = harness.scheduler.getDiagnostics().resources;
	assert.equal(resources.coalesceTimerArmed, true);
	assert.equal(resources.queuedMessages, 1);
	assert.equal(resources.activeMessages, 0);

	await harness.runNextTimer();
	resources = harness.scheduler.getDiagnostics().resources;
	assert.equal(resources.coalesceTimerArmed, false);
	assert.equal(resources.queuedMessages, 0);
	assert.equal(resources.activeMessages, 0);
	assert.equal(resources.fullRepaintTimerArmed, false);
	assert.equal(resources.settingsRetryTimerArmed, false);
	assert.equal(resources.textAreaRetryTimerArmed, false);
	assert.equal(resources.deferredFullRepaintPending, false);
});

test("full repaints keep their existing counter alongside the new counters", () => {
	const harness = createHarness();
	harness.scheduler.scheduleFullRepaint();
	const diagnostics = harness.scheduler.getDiagnostics();
	assert.equal(diagnostics.fullRepaints, 1);
	assert.equal(diagnostics.scheduled, 0);
});
