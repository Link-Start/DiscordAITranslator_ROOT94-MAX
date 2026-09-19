const test = require("node:test");
const assert = require("node:assert/strict");
const {createRealtimePerformanceTrace, TTFT_DEFINITION} = require("../../src/diagnostics/realtime-performance-trace");

test("TTFT definition is a frozen contract that forbids total-time impersonation", () => {
	assert.ok(Object.isFrozen(TTFT_DEFINITION));
	assert.equal(TTFT_DEFINITION.measuredFrom, "physical-attempt-dispatch");
	assert.equal(TTFT_DEFINITION.firstCountedEvent, "first-non-empty-translation-body-delta");
	assert.equal(TTFT_DEFINITION.nonStreamingValue, null);
	for (const excluded of ["http-headers", "sse-comments", "role-events", "reasoning-deltas", "usage-blocks"]) {
		assert.ok(TTFT_DEFINITION.excludes.includes(excluded), `excludes must list ${excluded}`);
	}
});

test("queue notifications aggregate counters, lane high water and depth high water", () => {
	const trace = createRealtimePerformanceTrace({now: () => 1000});
	const observer = trace.queueObserver;

	observer.notify("enqueued", {channelId: "c1", messageId: "m1", queueDepth: 1});
	observer.notify("enqueued", {channelId: "c1", messageId: "m2", queueDepth: 2});
	observer.notify("blocked", {reason: "backoff"});
	observer.notify("blocked", {reason: "live-lock"});
	observer.notify("lane-active", {active: 1});
	observer.notify("dispatched", {mode: "single", channelId: "c1", messageId: "m2", queueWaitMs: 40});
	observer.notify("lane-active", {active: 0});
	observer.notify("burst-request", {channelId: "c1", messageCount: 3});
	observer.notify("dispatched", {mode: "burst", channelId: "c1", messageId: "m1", queueWaitMs: 90, batchSize: 3});
	observer.notify("stale-drop", {site: "queue-head", channelId: "c1", messageId: "m9"});
	observer.notify("stale-drop", {site: "burst-post", channelId: "c1", messageId: "m8"});
	observer.notify("cached-serve", {channelId: "c1", messageId: "m7"});
	observer.notify("guard-drop", {channelId: "c1", messageId: "m6"});
	observer.notify("requeued", {channelId: "c1", messageId: "m5"});

	const snapshot = trace.getSnapshot();
	assert.equal(snapshot.enqueuedCount, 2);
	assert.equal(snapshot.queueDepthHighWater, 2);
	assert.equal(snapshot.blocked.backoff, 1);
	assert.equal(snapshot.blocked.liveLock, 1);
	assert.equal(snapshot.blocked.manualLock, 0);
	assert.equal(snapshot.dispatchedSingleCount, 1);
	assert.equal(snapshot.dispatchedBurstMessageCount, 1);
	assert.equal(snapshot.burstRequestCount, 1);
	assert.equal(snapshot.staleDrops.queueHead, 1);
	assert.equal(snapshot.staleDrops.burstPost, 1);
	assert.equal(snapshot.staleDrops.burstPre, 0);
	assert.equal(snapshot.staleDrops.burstRequeue, 0);
	assert.equal(snapshot.cachedServeCount, 1);
	assert.equal(snapshot.guardDropCount, 1);
	assert.equal(snapshot.requeuedCount, 1);
	assert.equal(snapshot.laneActive.current, 0);
	assert.equal(snapshot.laneActive.highWater, 1);
	assert.ok(Object.isFrozen(snapshot));
});

test("per-message queue waits build nearest-rank quantiles once five samples exist", () => {
	const trace = createRealtimePerformanceTrace({now: () => 0});
	const waits = [100, 200, 300, 400];
	for (const wait of waits) trace.queueObserver.notify("dispatched", {mode: "single", channelId: "c1", messageId: `m${wait}`, queueWaitMs: wait});

	let snapshot = trace.getSnapshot();
	assert.equal(snapshot.queueWait.count, 4);
	assert.equal(snapshot.queueWait.sufficient, false);
	assert.equal(snapshot.queueWait.p50Ms, null);

	trace.queueObserver.notify("dispatched", {mode: "burst", channelId: "c1", messageId: "m500", queueWaitMs: 500, batchSize: 2});
	snapshot = trace.getSnapshot();
	assert.equal(snapshot.queueWait.count, 5);
	assert.equal(snapshot.queueWait.sufficient, true);
	assert.equal(snapshot.queueWait.p50Ms, 300);
	assert.equal(snapshot.queueWait.p95Ms, 500);
});

test("enqueue-to-DOM spans close on the first confirmed repaint only", () => {
	let currentTime = 1000;
	const trace = createRealtimePerformanceTrace({now: () => currentTime});

	trace.queueObserver.notify("enqueued", {channelId: "c1", messageId: "m1", queueDepth: 1});
	currentTime = 1300;
	trace.onRenderOutcome({channelId: "c1", messageIds: ["m1"], outcome: {confirmedIds: ["m1"]}});
	currentTime = 9000;
	trace.onRenderOutcome({channelId: "c1", messageIds: ["m1"], outcome: {confirmedIds: ["m1"]}});

	const snapshot = trace.getSnapshot();
	assert.equal(snapshot.enqueueToDom.count, 1);
	const milestones = trace.listTrace({channelId: "c1", messageId: "m1"}).map(entry => entry.type);
	assert.ok(milestones.includes("enqueued"));
	assert.ok(milestones.includes("dom-confirmed"));
	const confirmed = trace.listTrace({channelId: "c1", messageId: "m1"}).find(entry => entry.type === "dom-confirmed");
	assert.equal(confirmed.spanMs, 300);
});

test("a stale drop abandons the span so it never produces a bogus DOM sample", () => {
	let currentTime = 1000;
	const trace = createRealtimePerformanceTrace({now: () => currentTime});

	trace.queueObserver.notify("enqueued", {channelId: "c1", messageId: "m1", queueDepth: 1});
	trace.queueObserver.notify("stale-drop", {site: "queue-head", channelId: "c1", messageId: "m1"});
	currentTime = 5000;
	trace.onRenderOutcome({channelId: "c1", messageIds: ["m1"], outcome: {confirmedIds: ["m1"]}});

	assert.equal(trace.getSnapshot().enqueueToDom.count, 0);
});

test("the lifecycle trace ring stays bounded and keeps the newest entries", () => {
	const trace = createRealtimePerformanceTrace({now: () => 0, traceLimit: 3});
	for (let index = 1; index <= 5; index++) {
		trace.queueObserver.notify("enqueued", {channelId: "c1", messageId: `m${index}`, queueDepth: index});
	}
	const entries = trace.listTrace();
	assert.equal(entries.length, 3);
	assert.deepEqual(entries.map(entry => entry.messageId), ["m3", "m4", "m5"]);
});

test("trace entries carry only ids, enums and numbers - never content fields", () => {
	const trace = createRealtimePerformanceTrace({now: () => 0});
	trace.queueObserver.notify("enqueued", {channelId: "c1", messageId: "m1", queueDepth: 1, content: "SECRET", text: "SECRET", prompt: "SECRET"});
	const [entry] = trace.listTrace();
	const allowedKeys = new Set(["type", "at", "channelId", "messageId", "queueDepth", "queueWaitMs", "mode", "batchSize", "site", "reason", "messageCount", "spanMs", "active"]);
	for (const key of Object.keys(entry)) assert.ok(allowedKeys.has(key), `unexpected trace key ${key}`);
});

test("unknown notification types are ignored without throwing", () => {
	const trace = createRealtimePerformanceTrace({now: () => 0});
	assert.doesNotThrow(() => trace.queueObserver.notify("no-such-event", {anything: 1}));
	assert.doesNotThrow(() => trace.queueObserver.notify(null, null));
	assert.equal(trace.getSnapshot().enqueuedCount, 0);
});

test("reset clears counters, spans and trace while bumping the generation", () => {
	let currentTime = 1000;
	const trace = createRealtimePerformanceTrace({now: () => currentTime});
	trace.queueObserver.notify("enqueued", {channelId: "c1", messageId: "m1", queueDepth: 1});
	trace.queueObserver.notify("dispatched", {mode: "single", channelId: "c1", messageId: "m1", queueWaitMs: 10});
	assert.equal(trace.getSnapshot().generation, 0);

	trace.reset();
	const snapshot = trace.getSnapshot();
	assert.equal(snapshot.generation, 1);
	assert.equal(snapshot.enqueuedCount, 0);
	assert.equal(snapshot.queueWait.count, 0);
	assert.equal(trace.listTrace().length, 0);

	// A span opened before the reset must not close after it.
	currentTime = 2000;
	trace.onRenderOutcome({channelId: "c1", messageIds: ["m1"], outcome: {confirmedIds: ["m1"]}});
	assert.equal(trace.getSnapshot().enqueueToDom.count, 0);
});

test("W0 DOM sink records one first confirmation and bounded deferred stale failure outcomes without ids", () => {
	let currentTime = 100;
	const events = [];
	const trace = createRealtimePerformanceTrace({now: () => currentTime, onDomObservation: event => events.push(event), getObservationGeneration: () => 7});
	trace.queueObserver.notify("enqueued", {channelId: "secret-channel", messageId: "id-confirm", queueDepth: 1});
	trace.queueObserver.notify("enqueued", {channelId: "secret-channel", messageId: "id-defer", queueDepth: 2});
	trace.queueObserver.notify("enqueued", {channelId: "secret-channel", messageId: "id-stale", queueDepth: 3});
	trace.queueObserver.notify("enqueued", {channelId: "secret-channel", messageId: "id-fail", queueDepth: 4});
	trace.linkAttempt({channelId: "secret-channel", messageId: "id-confirm", requestId: 11, generation: 7});
	trace.linkAttempt({channelId: "secret-channel", messageId: "id-defer", requestId: 12, generation: 7});
	trace.linkAttempt({channelId: "secret-channel", messageId: "id-stale", requestId: 13, generation: 7});
	trace.linkAttempt({channelId: "secret-channel", messageId: "id-fail", requestId: 14, generation: 7});
	currentTime = 150;
	trace.onRenderOutcome({channelId: "secret-channel", outcome: {confirmedIds: ["id-confirm"], deferredIds: ["id-defer"]}});
	trace.onRenderOutcome({channelId: "secret-channel", outcome: {confirmedIds: ["id-confirm"], deferredIds: ["id-defer"]}});
	trace.queueObserver.notify("stale-drop", {channelId: "secret-channel", messageId: "id-stale", site: "queue-head"});
	trace.queueObserver.notify("guard-drop", {channelId: "secret-channel", messageId: "id-fail"});
	assert.deepEqual(events, [
		{generation: 7, requestId: 11, outcome: "confirmed", enqueueToDomMs: 50},
		{generation: 7, requestId: 12, outcome: "deferred", enqueueToDomMs: null},
		{generation: 7, requestId: 13, outcome: "stale", enqueueToDomMs: null},
		{generation: 7, requestId: 14, outcome: "failed", enqueueToDomMs: null}
	]);
	assert.doesNotMatch(JSON.stringify(events), /secret-channel|id-confirm|id-defer|id-stale|id-fail/gi, "the sink receives no channel/message ids");
});
