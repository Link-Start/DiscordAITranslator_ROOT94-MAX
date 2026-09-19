const test = require("node:test");
const assert = require("node:assert/strict");
const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");

function recordOk(store, kind, engineKey, transportMs, messageCount = 1) {
	const token = store.beginLatencyRequest({kind, messageCount});
	store.recordLatencyEvent({token, role: "primary", engineKey, transportMs, status: "ok", messageCount});
}

test("live-lane quantiles exclude manual and historical attempts", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	// Five live samples 100..500 plus manual/historical noise that would skew P95.
	for (let index = 1; index <= 5; index++) recordOk(store, "live", "deepseek", index * 100);
	recordOk(store, "manual", "deepseek", 9000);
	recordOk(store, "historical", "deepseek", 9000);

	const snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.liveSampleCount, 5);
	assert.equal(snapshot.liveSufficient, true);
	assert.equal(snapshot.liveP50Ms, 300);
	assert.equal(snapshot.liveP95Ms, 500);
	// The mixed-kind aggregate keeps its existing meaning alongside the new fields.
	assert.equal(snapshot.sampleCount, 7);
});

test("live-lane quantiles follow the same engine filter and sufficiency floor", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	for (let index = 1; index <= 4; index++) recordOk(store, "live", "deepseek", index * 100);
	recordOk(store, "live", "other-engine", 5000);

	const snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.liveSampleCount, 4);
	assert.equal(snapshot.liveSufficient, false);
	assert.equal(snapshot.liveP50Ms, null);
	assert.equal(snapshot.liveP95Ms, null);
});

test("session counters track physical attempts and batch hits", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	recordOk(store, "live", "deepseek", 100);
	recordOk(store, "live", "deepseek", 200, 4);
	recordOk(store, "historical", "deepseek", 300, 10);
	const detectToken = store.beginLatencyRequest({kind: "detect", messageCount: 1});
	store.recordLatencyEvent({token: detectToken, role: "primary", engineKey: "deepseek", transportMs: 50, status: "ok"});

	const snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.attemptTotalCount, 4);
	assert.equal(snapshot.batchRequestCount, 2);
	assert.equal(snapshot.batchMessageCount, 14);
});

test("failed attempts count as physical dispatches but never enter live quantiles", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	for (let index = 1; index <= 5; index++) recordOk(store, "live", "deepseek", index * 100);
	const token = store.beginLatencyRequest({kind: "live", messageCount: 1});
	store.recordLatencyEvent({token, role: "primary", engineKey: "deepseek", transportMs: 9000, status: "http_500", errorClass: "server"});

	const snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.attemptTotalCount, 6);
	assert.equal(snapshot.liveSampleCount, 5);
	assert.equal(snapshot.liveP95Ms, 500);
});

test("resetLatency clears the new session counters and live quantiles", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	for (let index = 1; index <= 5; index++) recordOk(store, "live", "deepseek", index * 100, 2);
	store.resetLatency();

	const snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.attemptTotalCount, 0);
	assert.equal(snapshot.batchRequestCount, 0);
	assert.equal(snapshot.batchMessageCount, 0);
	assert.equal(snapshot.liveSampleCount, 0);
	assert.equal(snapshot.liveP50Ms, null);
});
