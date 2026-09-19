const test = require("node:test");
const assert = require("node:assert/strict");
const {createLoadedTranslationStatusStore} = require("../src/status/loaded-translation-status-store");
const {projectHistoricalStatus} = require("../src/status/historical-status-projection");

test("a retry starts its own duration, which survives idle time and channel reentry", () => {
	let now = 1000;
	const store = createLoadedTranslationStatusStore({now: () => now});
	store.update({channelId: "a", aggregate: true, active: true, phase: "requesting", pendingMessageIds: ["m1"]});
	now += 16000;
	store.recordSessionDisplayed("a", ["m1"]);
	store.update({active: false, phase: "failed", displayFailed: 1});
	assert.equal(store.getStatusText(), "0/1 16s");
	now += 60000;
	store.update({active: true, phase: "displaying", displayFailed: 0});
	assert.equal(store.getStatusText(), "0/1 0s", "a manual retry starts a new round");
	now += 2000;
	store.update({active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "1/1");
	assert.equal(store.getStatus().workElapsedMs, 2000);
	store.clear();
	now += 60000;
	store.update({channelId: "b", aggregate: true, active: true, phase: "collecting"});
	now += 3000;
	store.clear();
	store.update({channelId: "a", aggregate: true, active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "1/1");
	assert.equal(store.getStatus().workElapsedMs, 2000);
});

test("message counts accumulate, but consecutive translation rounds do not add their durations", () => {
	let now = 1000;
	const store = createLoadedTranslationStatusStore({now: () => now});
	const finish = id => {
		store.recordSessionDisplayed("a", [id]);
		store.update({active: false, done: true, phase: "done", pendingMessageIds: []});
	};
	store.update({channelId: "a", aggregate: true, active: true, phase: "requesting", pendingMessageIds: ["first"]});
	now += 210000;
	finish("first");
	assert.equal(store.getStatusText(), "1/1");
	assert.equal(store.getStatus().workElapsedMs, 210000);
	now += 60000;
	store.update({active: true, done: false, phase: "requesting", pendingMessageIds: ["second"]});
	assert.equal(store.getStatusText(), "1/2 0s");
	now += 3000;
	finish("second");
	assert.equal(store.getStatusText(), "2/2");
	assert.equal(store.getStatus().workElapsedMs, 3000, "the last round took 3 seconds, not 213");
	now += 60000;
	store.update({});
	assert.equal(store.getStatusText(), "2/2");
});

test("empty collection and completed refreshes retain the last duration until real work arrives", () => {
	let now = 1000;
	const store = createLoadedTranslationStatusStore({now: () => now});
	store.update({channelId: "a", aggregate: true, active: true, pendingMessageIds: ["first"]});
	now += 8000;
	store.recordSessionDisplayed("a", ["first"]);
	store.update({active: false, done: true, pendingMessageIds: []});
	store.clear();
	now += 60000;
	store.update({channelId: "a", aggregate: true, active: true, collecting: true, phase: "collecting", pendingMessageIds: []});
	now += 2000;
	assert.equal(store.getStatusText(), "1/1 8s");
	store.update({active: false, collecting: false, done: true, phase: "done"});
	assert.equal(store.getStatusText(), "1/1");
	assert.equal(store.getStatus().workElapsedMs, 8000);
	store.update({active: true, done: false, collecting: true, phase: "collecting"});
	now += 5000;
	store.update({pendingMessageIds: ["second"]});
	assert.equal(store.getStatusText(), "1/2 0s", "empty collection is not translation work");
	now += 1000;
	store.update({collecting: false, phase: "requesting"});
	now += 2000;
	store.recordSessionDisplayed("a", ["second"]);
	store.update({active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "2/2");
	assert.equal(store.getStatus().workElapsedMs, 3000);
});

test("overlapping jobs and phase changes share one round until all work has settled", () => {
	let now = 1000;
	const store = createLoadedTranslationStatusStore({now: () => now});
	store.update({channelId: "a", aggregate: true, active: true, jobId: "j1", phase: "requesting", pendingMessageIds: ["one"]});
	now += 2000;
	store.update({jobId: "j2", pendingMessageIds: ["one", "two"]});
	now += 1000;
	store.update({phase: "repairing"});
	now += 1000;
	store.update({phase: "displaying", displayPending: 2});
	now += 1000;
	store.recordSessionDisplayed("a", ["one", "two"]);
	store.update({active: false, done: true, phase: "done", pendingMessageIds: [], displayPending: 0});
	assert.equal(store.getStatusText(), "2/2");
	assert.equal(store.getStatus().workElapsedMs, 5000);
});

test("recollecting completed messages keeps cumulative progress while new work extends it", () => {
	const store = createLoadedTranslationStatusStore();
	store.recordSessionDisplayed("a", ["old1", "old2"]);
	store.update({channelId: "a", aggregate: true, active: false, done: true, phase: "done", pendingMessageIds: []});
	assert.equal(store.getStatusText(), "2/2");
	store.update({active: true, done: false, phase: "collecting", pendingMessageIds: ["old1", "old2", "new"]});
	assert.match(store.getStatusText(), /^2\/3 /);
	assert.equal(store.getStatus().active, true);
	store.recordSessionDisplayed("a", ["new"]);
	store.update({phase: "displaying", pendingMessageIds: ["new"], displayPending: 1});
	assert.match(store.getStatusText(), /^2\/3 /, "a newly committed but unpainted result is not counted as completed");
	store.update({active: false, done: true, phase: "done", pendingMessageIds: [], displayPending: 0});
	assert.equal(store.getStatusText(), "3/3");
});

test("loaded capsule includes automatic body work still running outside the historical queue", () => {
	const store = createLoadedTranslationStatusStore();
	store.recordSessionDisplayed("a", ["cached"]);
	const work = projectHistoricalStatus({channelId: "a", automaticPendingIds: ["waiting", "requesting"], retryableIds: []});
	assert.ok(work, "live body work must keep the projection alive even without a historical job");
	store.update(work);
	assert.equal(work.done, false);
	assert.equal(work.active, true);
	assert.equal(work.phase, "requesting");
	assert.match(store.getStatusText(), /^1\/3 /);
	store.recordSessionDisplayed("a", ["waiting", "requesting"]);
	store.update(projectHistoricalStatus({channelId: "a", automaticPendingIds: [], includeEmpty: true}));
	assert.equal(store.getStatusText(), "3/3");
});

test("automatic pending work overlaps historical ownership without double counting", () => {
	const job = {id: "j", state: "translating", sealed: true, items: new Map([["m", {status: "pending"}]])};
	const status = projectHistoricalStatus({channelId: "a", jobs: [job], automaticPendingIds: ["m"]});
	assert.deepEqual(status.pendingMessageIds, ["m"]);
});
