const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {runIsolatedCleanupSteps} = require("../src/lifecycle/stop-cleanup");
const {createLiveTranslationQueue} = require("../src/orchestrator/live-translation-queue");

test("stop cleanup continues after failures and still performs the final rerender", () => {
	const calls = [];
	const failures = runIsolatedCleanupSteps([
		() => {calls.push("invalidate-requests"); throw new Error("request cleanup failed");},
		() => calls.push("restore-display"),
		() => {calls.push("clear-preview"); throw new Error("preview cleanup failed");},
		() => calls.push("rerender")
	]);

	assert.deepEqual(calls, ["invalidate-requests", "restore-display", "clear-preview", "rerender"]);
	assert.deepEqual(failures.map(failure => failure.index), [0, 2]);
	assert.deepEqual(failures.map(failure => failure.error.message), ["request cleanup failed", "preview cleanup failed"]);
});

test("stop cleanup absorbs an asynchronous cleanup rejection without delaying later steps", async () => {
	const calls = [];
	const failures = runIsolatedCleanupSteps([
		() => Promise.reject(new Error("async restore failed")),
		() => calls.push("rerender")
	]);
	assert.deepEqual(calls, ["rerender"]);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(failures.length, 1);
	assert.equal(failures[0].error.message, "async restore failed");
});

test("a stop/start cycle cannot replay a queued live message from the prior runtime", () => {
	const state = {runtimeActive: true};
	const translated = [];
	const queue = createLiveTranslationQueue({
		isRuntimeActive: () => state.runtimeActive,
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}:${message.content}`,
		shouldAutoTranslateMessage: () => true,
		translateSingleItem: item => {translated.push(item.message.id); return Promise.resolve();}
	});
	queue.setBusyTranslating(true);
	assert.equal(queue.queueMessage({id: "stale", content: "old"}, {id: "channel-a"}), true);
	assert.equal(queue.getQueueLength(), 1);

	state.runtimeActive = false;
	runIsolatedCleanupSteps([
		() => queue.clearQueue(),
		() => queue.setBusyTranslating(false),
		() => queue.setLiveAutoTranslating(false)
	]);
	state.runtimeActive = true;
	queue.restartRequestGeneration();
	queue.processQueue();

	assert.equal(queue.getQueueLength(), 0);
	assert.deepEqual(translated, []);
});

test("global queue cleanup drains owned state before a display-release hook can fail", () => {
	const queue = createLiveTranslationQueue({
		isRuntimeActive: () => true,
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}:${message.content}`,
		shouldAutoTranslateMessage: () => true,
		releaseDisplayPending: () => {throw new Error("display release failed");}
	});
	queue.setBusyTranslating(true);
	queue.queueMessage({id: "stale", content: "old"}, {id: "channel-a"});

	assert.throws(() => queue.clearQueue(), /display release failed/);
	assert.equal(queue.getQueueLength(), 0);
	assert.equal(queue.isMessageQueued("stale"), false);
});

test("runtime stop invalidates activity first and clears queue contents before its final rerender", () => {
	const runtime = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");
	const match = runtime.match(/\n\t\t\tonStop \(\) \{([\s\S]*?)\n\t\t\t\}/);
	assert.ok(match, "onStop remains inspectable");
	const body = match[1];
	const firstStatement = body.split("\n").map(line => line.trim()).find(Boolean);
	assert.equal(firstStatement, "pluginRuntimeActive = false;", "runtime activity is invalidated before any fallible cleanup");
	assert.match(body, /runIsolatedCleanupSteps\s*\(/);
	assert.match(body, /cancelW2SettingsBenchmark\(this, "plugin-stopped"\)/, "stop cancels the UI-owned W2 controller and physical session");
	assert.match(body, /ensureLiveTranslationQueue\(\)\.clearQueue\(\)/, "stop empties the actual live queue");
	assert.match(body, /historicalBatchPerformance\.stop\(\)/, "stop rejects new history dispatch while physical leases drain");
	assert.ok(body.indexOf("historicalBatchPerformance.stop()") < body.indexOf("cancelHistoricalTranslationJobs"), "physical dispatch stops before a fallible cancellation hook");
	assert.ok(body.indexOf("invalidateLiveTranslationRequests()") < body.indexOf("abortProviderAttempts"), "logical live cancellation precedes physical provider abort");
	assert.ok(body.indexOf("cancelW2SettingsBenchmark") < body.indexOf("abortProviderAttempts"), "the W2 session is synchronously cancelled before global provider cleanup");
	assert.ok(body.indexOf("cancelHistoricalTranslationJobs") < body.indexOf("abortProviderAttempts"), "historical logical cancellation precedes physical provider abort");
	assert.ok(body.indexOf("abortProviderAttempts") < body.indexOf(".clearQueue()"), "physical abort is synchronous before queue and slot cleanup");
	assert.ok(body.indexOf(".clearQueue()") < body.indexOf("MessageUtils.rerenderAll(true)"), "queue cleanup precedes the final rerender");
});

test("closing settings cancels W2 before flushing deferred settings and invalidates late modal work", () => {
	const runtime = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");
	const match = runtime.match(/\n\t\t\tonSettingsClosed \(\) \{([\s\S]*?)\n\t\t\t\}/);
	assert.ok(match, "onSettingsClosed remains inspectable");
	const body = match[1];
	assert.match(body, /cancelW2SettingsBenchmark\(this, "settings-closed"\)/);
	assert.ok(body.indexOf("cancelW2SettingsBenchmark") < body.indexOf("flushDeferredSettingsWrites"), "physical W2 cancellation wins the settings-close race");
});

test("runtime start reapplies persisted performance experiment controls", () => {
	const runtime = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");
	const match = runtime.match(/\n\t\t\tonStart \(\) \{([\s\S]*?)\n\t\t\t\}/);
	assert.ok(match);
	assert.match(match[1], /historicalBatchPerformance\.setConcurrency\(this\.settings\.performance/);
	assert.match(match[1], /setLiveSlotCapacity\(this\.settings\.performance/);
	assert.ok(match[1].indexOf("historicalBatchPerformance.start()") < match[1].indexOf("historicalBatchPerformance.setConcurrency"));
});

test("runtime preserves the preview queue owner across stop/start and stops it before display cleanup", () => {
 const runtime = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");
 const stop = runtime.match(/\n\t\t\tonStop \(\) \{([\s\S]*?)\n\t\t\t\}/)[1];
 const start = runtime.match(/\n\t\t\tonStart \(\) \{([\s\S]*?)\n\t\t\t\}/)[1];
 assert.match(stop, /replyPreviewQueueInstance\.stop\(\)/);
 assert.match(start, /replyPreviewQueueInstance\.start\(\)/);
 assert.ok(stop.indexOf("replyPreviewQueueInstance.stop()") < stop.indexOf("clearPreviews(null)"));
 assert.doesNotMatch(stop, /replyPreviewQueueInstance\s*=\s*null/);
});
