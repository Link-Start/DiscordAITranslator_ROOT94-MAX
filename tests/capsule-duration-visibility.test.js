const test = require("node:test");
const assert = require("node:assert/strict");
const {createLoadedTranslationStatusStore} = require("../src/status/loaded-translation-status-store");
const {projectHistoricalStatus} = require("../src/status/historical-status-projection");
const {HistoricalTranslationJob} = require("../src/orchestrator/historical-translation-job");

test("successful completion hides seconds, including later cached historical jobs", async () => {
	let now = 1000;
	const store = createLoadedTranslationStatusStore({now: () => now});
	store.update({channelId: "a", aggregate: true, active: true, pendingMessageIds: ["original"]});
	now += 8000;
	assert.equal(store.getStatusText(), "0/1 8s");
	store.recordSessionDisplayed("a", ["original"]);
	store.update({active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "1/1");
	now += 60000;
	store.update({});
	assert.equal(store.getStatusText(), "1/1");
	const job = new HistoricalTranslationJob({id: "cached", channelId: "a", now: () => now, dependencies: {
		prepare: () => ({status: "translated", translation: "cached translation"}),
		translateBatch: () => assert.fail("a cache hit must not dispatch a request"),
		commit: () => {now += 30; store.recordSessionDisplayed("a", ["cached"]);},
		onStateChange: job => store.update(projectHistoricalStatus({channelId: "a", jobs: [job], includeEmpty: true}))
	}});
	job.add({message: {id: "cached"}});
	await job.start();
	assert.equal(store.getStatusText(), "2/2", "cache completion must not leave 0s on the capsule");
	store.clear();
	store.update(projectHistoricalStatus({channelId: "a", includeEmpty: true}));
	assert.equal(store.getStatusText(), "2/2", "a completed channel reentry is also ratio only");
});

test("the next actual round shows its own elapsed seconds and hides them when finished", () => {
	let now = 1000;
	const store = createLoadedTranslationStatusStore({now: () => now});
	store.recordSessionDisplayed("a", ["old"]);
	store.update({channelId: "a", aggregate: true, active: true, pendingMessageIds: ["first"]});
	now += 12000;
	store.recordSessionDisplayed("a", ["first"]);
	store.update({active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "2/2");
	now += 60000;
	store.update({active: true, done: false, phase: "requesting", pendingMessageIds: ["next"]});
	assert.equal(store.getStatusText(), "2/3 0s");
	now += 3000;
	assert.equal(store.getStatusText(), "2/3 3s");
	store.recordSessionDisplayed("a", ["next"]);
	store.update({active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "3/3");
});

test("pending display and failures remain timed until they are actually resolved", () => {
	const store = createLoadedTranslationStatusStore({now: () => 9000});
	const base = {active: false, done: true, total: 2, displayed: 1, workElapsedMs: 8000};
	assert.equal(store.getStatusText({...base, displayPending: 1}), "1/2 8s");
	assert.equal(store.getStatusText({...base, phase: "failed", failed: 1, retryable: 1}), "1/2 8s");
	assert.equal(store.getStatusText({...base, displayed: 2}), "2/2");
});
