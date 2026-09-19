const test = require("node:test");
const assert = require("node:assert/strict");
const {resumeHistoricalHandoff} = require("../src/orchestrator/historical-handoff-runtime");

test("a deferred retired-ticket callback cannot start a replacement historical queue", async () => {
	let entry = {
		channelId: "c1",
		jobs: [{state: "collecting", sealed: true}],
		runningPromise: null,
		pendingLiveHandoffTicket: "old-ticket"
	};
	const starts = [];
	const plugin = {
		getHistoricalTranslationJobQueue: () => entry,
		ensureHistoricalJobRegistry: () => ({listQueues: () => [entry]}),
		ensureLiveTranslationQueue: () => ({reserveQueuedLiveRequest: () => null, processQueue: () => {}}),
		startCollectedHistoricalTranslationJobs: channelId => starts.push(channelId)
	};

	resumeHistoricalHandoff(plugin, "c1", "old-ticket", {retired: true});
	entry = {
		channelId: "c1",
		jobs: [{state: "collecting", sealed: true}],
		runningPromise: null,
		pendingLiveHandoffTicket: null
	};
	await new Promise(resolve => setImmediate(resolve));

	assert.deepEqual(starts, [], "the old callback must not release a newly-created queue that never owned its ticket");
});
