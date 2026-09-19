const test = require("node:test");
const assert = require("node:assert/strict");
const {createHistoricalRequestKeyContract} = require("../../src/providers/provider-client");
const {createHistoricalBatchPerformanceTrace} = require("../../src/diagnostics/historical-batch-performance-trace");

function keyFixture(overrides = {}) {
	return Object.assign({
		engine: "engine-a",
		endpoint: "https://private.example/v1/chat/completions",
		credential: "secret-fixture-key",
		model: "private-model-name",
		protocol: "openai_chat",
		adapterVersion: 3,
		schemaVersion: 1,
		reasoningWire: {reasoning_effort: "high"},
		promptVersion: "history-batch-v1",
		languageRules: {input: "en", output: "zh-CN", rules: "private-rule-text"},
		itemCount: 10,
		inputChars: 2048,
		promptChars: 4096
	}, overrides);
}

test("H1 Transport and Workload keys change only across their frozen contract fields", () => {
	const baseline = createHistoricalRequestKeyContract(keyFixture());
	for (const [field, value] of [
		["engine", "engine-b"],
		["endpoint", "https://other.example/v1/chat/completions"],
		["credential", "replacement-secret"],
		["model", "other-model"],
		["protocol", "openai_responses"],
		["adapterVersion", 4],
		["schemaVersion", 2],
		["reasoningWire", {reasoning_effort: "low"}]
	]) {
		const changed = createHistoricalRequestKeyContract(keyFixture({[field]: value}));
		assert.notEqual(changed.transportKey, baseline.transportKey, `${field} changes Transport Key`);
		assert.notEqual(changed.workloadKey, baseline.workloadKey, `${field} also changes Workload Key`);
	}
	for (const [field, value] of [
		["promptVersion", "history-batch-v2"],
		["languageRules", {input: "ja", output: "zh-CN", rules: "other"}],
		["itemCount", 26],
		["inputChars", 13000],
		["promptChars", 20000]
	]) {
		const changed = createHistoricalRequestKeyContract(keyFixture({[field]: value}));
		assert.equal(changed.transportKey, baseline.transportKey, `${field} leaves Transport Key stable`);
		assert.notEqual(changed.workloadKey, baseline.workloadKey, `${field} changes Workload Key`);
	}
});

test("H1 key export contains digests and buckets but no endpoint, credential, model, prompt or rules", () => {
	const contract = createHistoricalRequestKeyContract(keyFixture());
	const serialized = JSON.stringify(contract);
	for (const secret of ["private.example", "secret-fixture-key", "private-model-name", "private-rule-text", "reasoning_effort"]) {
		assert.equal(serialized.includes(secret), false, `redacts ${secret}`);
	}
	assert.match(contract.transportKey, /^tk1:/);
	assert.match(contract.workloadKey, /^wk1:/);
	assert.equal(contract.transport.adapterVersion, 3);
	assert.equal(contract.workload.itemSizeBucket, "5-10");
});

test("H1 trace closes logical-attempt lineage and reports exact conservation with nullable transport gaps", () => {
	let clock = 100;
	const trace = createHistoricalBatchPerformanceTrace({now: () => clock});
	const run = trace.beginRun({collectedMessageCount: 2, concurrency: 2, batchKey: "private-channel:job-1", sourceMetrics: {sourceLoadAt: 80, scanPrefetchAt: 90, prefetchedCount: 1}});
	trace.recordCache(run, {hit: 1, miss: 1, invalidated: 1, evicted: 0});
	const logical = trace.beginLogical(run, {role: "primary", itemCount: 1, probeBarrier: true, primaryWave: 0});
	clock = 110;
	trace.recordLease(logical, {backoffWaitMs: 2, leaseWaitMs: 3, slotActive: 1, slotCapacity: 2});
	const attempt = trace.beginAttempt(logical, {role: "primary"});
	clock = 111;
	trace.recordAttemptDispatched(attempt, {transportKey: "tk1:abc", workloadKey: "wk1:def", bodyBytes: 321, promptChars: 200, inputChars: 20, headers: null, ttftMs: null, physicalAbort: null});
	clock = 120;
	trace.recordAttemptSettled(attempt, {providerRequestId: 7, providerAttempt: 1, status: "ok", httpStatus: 200, outputChars: 12, usage: null, finishReason: null});
	trace.finishLogical(logical, {status: "settled"});
	trace.recordParseValidate(run, {parsed: 1, valid: 1, invalid: 0});
	trace.recordAtomicCommit(run, {resultCount: 2, committedCount: 2, confirmedCount: 2});
	trace.recordDomConfirm(run, {confirmedCount: 2});
	trace.finishRun(run, {status: "committed", translatedCount: 1, skippedCount: 1});

	const h1 = trace.getSnapshot().latestRun.h1;
	assert.deepEqual(h1.conservation, {
		logicalCount: 1,
		terminalLogicalCount: 1,
		attemptCount: 1,
		dispatchCount: 1,
		settleCount: 1,
		providerBoundIdCount: 1,
		uniqueProviderBoundIdCount: 1,
		atomicCommitCount: 1,
		passed: true
	});
	assert.equal(h1.cache.hit, 1);
	assert.equal(h1.cache.miss, 1);
	assert.equal(h1.cache.invalidated, 1);
	assert.equal(h1.attempts[0].headers, null);
	assert.equal(h1.attempts[0].ttftMs, null);
	assert.equal(h1.attempts[0].physicalAbort, null);
	assert.equal(h1.bodyBytes, 321);
	assert.equal(h1.usageSampleCount, 0, "missing usage stays null/not zero-backed");
	assert.equal(h1.domConfirmedCount, 2);
	assert.equal(JSON.stringify(h1).includes("private-channel"), false);
});

test("H1 trace controls duplicate/orphan/late events and stays bounded under restart and disorder", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 1, h1SampleLimit: 2});
	const run = trace.beginRun({collectedMessageCount: 4, batchKey: "raw-job"});
	const logical = trace.beginLogical(run, {role: "primary"});
	const first = trace.beginAttempt(logical, {role: "primary"});
	trace.recordAttemptDispatched(first, {});
	assert.equal(trace.recordAttemptDispatched(first, {}), false);
	assert.equal(trace.recordAttemptSettled(Object.assign({}, first, {attemptId: 999}), {}), false);
	trace.recordAttemptSettled(first, {providerRequestId: 1, providerAttempt: 1, status: "cancelled"});
	assert.equal(trace.recordAttemptSettled(first, {}), false);
	trace.finishLogical(logical, {status: "cancelled"});
	for (let index = 0; index < 4; index++) {
		const itemLogical = trace.beginLogical(run, {role: index % 2 ? "repair" : "backup"});
		const itemAttempt = trace.beginAttempt(itemLogical, {role: index % 2 ? "repair" : "backup"});
		trace.recordAttemptDispatched(itemAttempt, {});
		trace.recordAttemptSettled(itemAttempt, {providerRequestId: index + 2, providerAttempt: 1, status: "ok"});
		trace.finishLogical(itemLogical, {status: "settled"});
	}
	trace.finishRun(run, {status: "cancelled"});
	const h1 = trace.getSnapshot().latestRun.h1;
	assert.equal(h1.duplicateEventCount, 2);
	assert.equal(h1.orphanEventCount, 1);
	assert.equal(h1.attempts.length, 2);
	assert.ok(h1.evictedCount > 0);

	trace.reset();
	assert.equal(trace.recordAttemptSettled(first, {}), false);
	assert.equal(trace.getSnapshot().activeRunCount, 0);
});

test("H1 cache hits spend zero provider attempts and cancelled logicals still enter the denominator", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const run = trace.beginRun({collectedMessageCount: 2});
	trace.recordCache(run, {hit: 1, miss: 1});
	const cancelled = trace.beginLogical(run, {role: "repair", itemCount: 1});
	trace.finishLogical(cancelled, {status: "cancelled"});
	trace.recordAtomicCommit(run, {resultCount: 2, committedCount: 1, rejectedCount: 1});
	trace.finishRun(run, {status: "committed", translatedCount: 1, failedCount: 1});
	const h1 = trace.getSnapshot().latestRun.h1;
	assert.equal(h1.cache.hit, 1);
	assert.equal(h1.conservation.attemptCount, 0);
	assert.equal(h1.conservation.logicalCount, 1);
	assert.equal(h1.conservation.terminalLogicalCount, 1);
	assert.equal(h1.conservation.passed, true);
});

test("H1 accepts a deferred DOM confirmation after the job has already finished", () => {
	let clock = 10;
	const trace = createHistoricalBatchPerformanceTrace({now: () => clock});
	const run = trace.beginRun({collectedMessageCount: 1, batchKey: "private-job-key"});
	trace.recordAtomicCommit(run, {resultCount: 1, committedCount: 1, deferredCount: 1});
	trace.recordDomConfirm(run, {deferredCount: 1});
	trace.finishRun(run, {status: "committed", translatedCount: 1});
	clock = 20;
	assert.equal(trace.recordDomConfirmByBatchKey("private-job-key", {confirmedCount: 1}), true);
	const h1 = trace.getSnapshot().latestRun.h1;
	assert.equal(h1.domDeferredCount, 1);
	assert.equal(h1.domConfirmedCount, 1);
	assert.equal(h1.timelineMs.domConfirm, 10);
	assert.equal(JSON.stringify(trace.getSnapshot()).includes("private-job-key"), false);
});

test("S4 migrated attempts report physical abort while callback-era attempts remain null", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const run = trace.beginRun({collectedMessageCount: 2});
	for (const [index, physicalAbort] of [true, null].entries()) {
		const logical = trace.beginLogical(run, {role: "primary", itemCount: 1});
		const attempt = trace.beginAttempt(logical, {role: "primary", engineKey: "oaicompat"});
		trace.recordAttemptDispatched(attempt, {transportKey: "tk1:fixture", workloadKey: "wk1:fixture"});
		trace.recordAttemptSettled(attempt, {providerRequestId: index + 1, providerAttempt: 1, status: physicalAbort ? "cancelled" : "ok", physicalAbort});
		trace.finishLogical(logical, {status: "settled"});
	}
	trace.recordAtomicCommit(run, {resultCount: 2, committedCount: 2});
	trace.finishRun(run, {status: "committed", translatedCount: 2});
	assert.deepEqual(trace.getSnapshot().latestRun.h1.attempts.map(attempt => attempt.physicalAbort), [true, null]);
});

test("H1 event P95 stays below 0.5ms and twelve worst-case public snapshots stay below 1MB", () => {
	let clock = 0;
	const trace = createHistoricalBatchPerformanceTrace({now: () => ++clock, runLimit: 12, h1SampleLimit: 32});
	const durations = [];
	const probe = trace.beginRun({collectedMessageCount: 1});
	for (let index = 0; index < 2500; index++) {
		const started = performance.now();
		trace.recordCache(probe, {miss: 1});
		durations.push(performance.now() - started);
	}
	trace.recordAtomicCommit(probe, {resultCount: 1, committedCount: 1});
	trace.finishRun(probe, {status: "committed", translatedCount: 1});
	durations.sort((left, right) => left - right);
	assert.ok(durations[Math.ceil(durations.length * 0.95) - 1] < 0.5);

	for (let runIndex = 0; runIndex < 12; runIndex++) {
		const run = trace.beginRun({collectedMessageCount: 100, batchKey: `private-${runIndex}`});
		for (let index = 0; index < 100; index++) {
			const logical = trace.beginLogical(run, {role: index % 3 === 0 ? "backup" : index % 3 === 1 ? "repair" : "primary", itemCount: 1});
			const attempt = trace.beginAttempt(logical, {role: "primary"});
			trace.recordAttemptDispatched(attempt, {transportKey: "tk1:fixture", workloadKey: "wk1:fixture", bodyBytes: 100});
			trace.recordAttemptSettled(attempt, {providerRequestId: runIndex * 100 + index + 1, providerAttempt: 1, status: "ok"});
			trace.finishLogical(logical, {status: "settled"});
		}
		trace.recordAtomicCommit(run, {resultCount: 100, committedCount: 100});
		trace.finishRun(run, {status: "committed", translatedCount: 100});
	}
	const serialized = JSON.stringify(trace.getSnapshot());
	assert.ok(Buffer.byteLength(serialized, "utf8") < 1024 * 1024);
	assert.doesNotMatch(serialized, /private-/);
});
