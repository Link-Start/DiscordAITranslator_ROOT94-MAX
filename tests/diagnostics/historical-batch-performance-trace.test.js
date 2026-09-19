const test = require("node:test");
const assert = require("node:assert/strict");
const {createHistoricalBatchPerformanceTrace} = require("../../src/diagnostics/historical-batch-performance-trace");

test("commit preparation exposes only fixed counters and rejects completed or reset runs", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const token = trace.beginRun({collectedMessageCount: 3});
	assert.equal(trace.recordCommitPreparation(token, {attemptCount: 1, displayOwnedCount: 2, sourceChangedCount: 1, submittedCount: -1, source: "PRIVATE_TEXT", arbitrary: "PRIVATE_ID"}), true);
	const run = trace.finishRun(token, {status: "committed", translatedCount: 3});
	assert.equal(run.commitPreparation.attemptCount, 1);
	assert.equal(run.commitPreparation.displayOwnedCount, 2);
	assert.equal(run.commitPreparation.sourceChangedCount, 1);
	assert.equal(run.commitPreparation.submittedCount, 0);
	assert.equal(run.atomicCommitCount, 0);
	assert.equal(Object.isFrozen(run.commitPreparation), true);
	assert.doesNotMatch(JSON.stringify(run.commitPreparation), /PRIVATE|source"|arbitrary/);
	assert.equal(trace.recordCommitPreparation(token, {attemptCount: 1}), false);
	const stale = trace.beginRun({collectedMessageCount: 1});
	trace.reset();
	assert.equal(trace.recordCommitPreparation(stale, {attemptCount: 1}), false);
	assert.equal(trace.getSnapshot().latestRun, null);
});

test("historical trace records one anonymous cap-1 job and projects two-slot duration", () => {
	let clock = 1000;
	const trace = createHistoricalBatchPerformanceTrace({now: () => clock});
	const token = trace.beginRun({collectedMessageCount: 20, concurrency: 1, chunkSize: 10});
	clock += 5;
	trace.recordChunkStarted(token, {index: 0, messageCount: 10, inputChars: 600, liveActive: 0});
	assert.equal(trace.recordLiveTurnStarted(), 1);
	clock += 100;
	trace.recordChunkSettled(token, {index: 0, messageCount: 10});
	trace.recordChunkStarted(token, {index: 1, messageCount: 10, inputChars: 400, liveActive: 1});
	clock += 80;
	trace.recordChunkSettled(token, {index: 1, messageCount: 10});
	clock += 5;
	trace.recordAtomicCommit(token, {resultCount: 20, committedCount: 20, confirmedCount: 18, deferredCount: 2});
	clock += 10;
	trace.finishRun(token, {status: "committed", translatedCount: 20});

	const snapshot = trace.getSnapshot();
	assert.equal(snapshot.activeRunCount, 0);
	assert.equal(snapshot.activeChunkCount, 0);
	assert.equal(snapshot.primaryChunkRequestCount, 2);
	assert.equal(snapshot.primaryChunkMessageCount, 20);
	assert.equal(snapshot.primaryInputChars, 1000);
	assert.equal(snapshot.maxActiveChunkCount, 1);
	assert.equal(snapshot.atomicCommitCount, 1);
	assert.deepEqual(snapshot.latestRun.chunkSamples.map(sample => sample.durationMs), [100, 80]);
	assert.equal(snapshot.latestRun.totalMs, 200);
	assert.equal(snapshot.latestRun.sequentialChunkMs, 180);
	assert.equal(snapshot.latestRun.projectedConcurrency2ChunkMs, 180, "the first chunk stays a serial probe, leaving only one chunk to run afterwards");
	assert.equal(snapshot.latestRun.projectedConcurrency2TotalMs, 200);
	assert.equal(snapshot.latestRun.projectedConcurrency2ImprovementPercent, 0);
	assert.equal(snapshot.latestRun.actualPrimaryConcurrencyImprovementPercent, 0);
	assert.equal(snapshot.latestRun.actualPrimaryConcurrencySpeedup, 1);
	assert.equal(snapshot.latestRun.liveOverlapDispatches, 1);
	assert.equal(snapshot.latestRun.liveTurnsDuringRun, 1);
	assert.equal(snapshot.latestRun.liveOverlapDuringChunks, 1);
	assert.equal(snapshot.latestRun.providerInputChars, 1000);
	assert.equal(snapshot.latestRun.committedCount, 20);
	assert.equal(snapshot.latestRun.missingCount, 0);
	assert.equal(snapshot.latestRun.retryCount, 0);
	assert.deepEqual(snapshot.latestRun.chunkSamples.map(sample => sample.inputChars), [600, 400]);
	assert.equal(JSON.stringify(snapshot).includes("channel"), false);
	assert.equal(JSON.stringify(snapshot).includes("messageId"), false);
});

test("historical trace classifies failures and repair traffic without accepting payload data", () => {
	let clock = 0;
	const trace = createHistoricalBatchPerformanceTrace({now: () => ++clock});
	const token = trace.beginRun({collectedMessageCount: 12});
	trace.recordChunkStarted(token, {index: 0, messageCount: 10});
	trace.recordChunkSettled(token, {index: 0, messageCount: 10, failureKind: "transient", statusCode: 429});
	trace.recordRepairRequest(token, {mode: "batch", messageCount: 2});
	trace.recordRepairRequest(token, {mode: "item", messageCount: 1});
	trace.recordAtomicCommit(token, {resultCount: 11, rejectedCount: 1, staleCount: 1, error: true});
	trace.finishRun(token, {status: "failed", translatedCount: 10, failedCount: 2});

	const snapshot = trace.getSnapshot();
	assert.equal(snapshot.failedRunCount, 1);
	assert.equal(snapshot.repairBatchRequestCount, 1);
	assert.equal(snapshot.repairBatchMessageCount, 2);
	assert.equal(snapshot.repairItemRequestCount, 1);
	assert.equal(snapshot.latestRun.failureCount, 1);
	assert.equal(snapshot.latestRun.chunkSamples[0].failureKind, "transient");
	assert.equal(snapshot.latestRun.chunkSamples[0].statusCode, 429);
	assert.equal(snapshot.latestRun.commitErrorCount, 1);
});

test("atomic display pending counters stay separate from store rejection", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const token = trace.beginRun({collectedMessageCount: 10});
	trace.recordAtomicCommit(token, {resultCount: 10, committedCount: 10, confirmedCount: 9, missingCount: 1, retryCount: 1});
	trace.finishRun(token, {status: "committed", translatedCount: 10});
	const run = trace.getSnapshot().latestRun;
	assert.equal(run.committedCount, 10);
	assert.equal(run.rejectedCount, 0);
	assert.equal(run.missingCount, 1);
	assert.equal(run.retryCount, 1);
});

test("reset clears resources and rejects late events from the old generation", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const staleToken = trace.beginRun({collectedMessageCount: 50});
	trace.recordChunkStarted(staleToken, {index: 0, messageCount: 10});
	assert.equal(trace.getSnapshot().activeChunkCount, 1);

	trace.reset();
	assert.equal(trace.getSnapshot().generation, 1);
	assert.equal(trace.getSnapshot().activeRunCount, 0);
	assert.equal(trace.getSnapshot().activeChunkCount, 0);
	assert.equal(trace.recordChunkSettled(staleToken, {index: 0, messageCount: 10}), false);
	assert.equal(trace.finishRun(staleToken, {status: "committed"}), false);
	assert.equal(trace.getSnapshot().completedRunCount, 0);
});

test("recent history is bounded and snapshots expose no mutable internal arrays", () => {
	let clock = 0;
	const trace = createHistoricalBatchPerformanceTrace({now: () => ++clock, runLimit: 2});
	for (let index = 0; index < 3; index++) {
		const token = trace.beginRun({collectedMessageCount: index + 1});
		trace.finishRun(token, {status: "committed"});
	}
	const snapshot = trace.getSnapshot();
	assert.equal(snapshot.completedRunCount, 3);
	assert.equal(snapshot.recentRunCount, 2);
	assert.ok(Object.isFrozen(snapshot.recentRuns));
	assert.ok(Object.isFrozen(snapshot.latestRun));
	assert.ok(Object.isFrozen(snapshot.latestRun.chunkSamples));
});

test("global activity and malformed chunk events are visible instead of passing a clean gate", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const first = trace.beginRun({collectedMessageCount: 50});
	const second = trace.beginRun({collectedMessageCount: 50});
	assert.equal(trace.recordChunkStarted(first, {index: 0, messageCount: 10}), true);
	assert.equal(trace.recordChunkStarted(first, {index: 0, messageCount: 10}), false);
	assert.equal(trace.recordChunkStarted(second, {index: 0, messageCount: 10}), true);
	assert.equal(trace.getSnapshot().maxActiveChunkCount, 2);
	assert.equal(trace.recordChunkSettled(first, {index: 99, messageCount: 10}), false);
	trace.recordChunkSettled(first, {index: 0, messageCount: 10});
	trace.recordChunkSettled(second, {index: 0, messageCount: 10});
	trace.finishRun(first, {status: "failed"});
	trace.finishRun(second, {status: "committed"});
	const [firstRun, secondRun] = trace.getSnapshot().recentRuns;
	assert.equal(firstRun.globalMaxActiveChunks, 2);
	assert.equal(secondRun.globalMaxActiveChunks, 2);
	assert.equal(firstRun.duplicateChunkEventCount, 1);
	assert.equal(firstRun.orphanChunkSettleCount, 1);
});

test("a sealed job includes handoff waiting in its end-to-end and projected totals", () => {
	let clock = 1000;
	const trace = createHistoricalBatchPerformanceTrace({now: () => clock});
	const token = trace.beginRun({collectedMessageCount: 10, sealedAt: 800});
	clock = 1100;
	trace.recordChunkStarted(token, {index: 0, messageCount: 10});
	clock = 1200;
	trace.recordChunkSettled(token, {index: 0, messageCount: 10});
	trace.recordAtomicCommit(token, {resultCount: 10, confirmedCount: 10});
	clock = 1210;
	trace.finishRun(token, {status: "committed", translatedCount: 10});
	const run = trace.getSnapshot().latestRun;
	assert.equal(run.waitBeforeJobStartMs, 200);
	assert.equal(run.sealToFirstDispatchMs, 300);
	assert.equal(run.totalMs, 410);
	assert.equal(run.projectedConcurrency2TotalMs, 410, "one chunk has no projected concurrency benefit");
});

test("a concurrent run reports actual primary gain and suppresses the sequential-only cap2 projection", () => {
	let clock = 0;
	const trace = createHistoricalBatchPerformanceTrace({now: () => clock});
	const token = trace.beginRun({collectedMessageCount: 5, concurrency: 4, chunkSize: 10, chunkCharLimit: 12000});
	trace.recordChunkStarted(token, {index: 0, messageCount: 1, inputChars: 100});
	clock = 100;
	trace.recordChunkSettled(token, {index: 0, messageCount: 1});
	for (let index = 1; index < 5; index++) trace.recordChunkStarted(token, {index, messageCount: 1, inputChars: 100});
	clock = 120; trace.recordChunkSettled(token, {index: 4, messageCount: 1});
	clock = 140; trace.recordChunkSettled(token, {index: 3, messageCount: 1});
	clock = 160; trace.recordChunkSettled(token, {index: 2, messageCount: 1});
	clock = 180; trace.recordChunkSettled(token, {index: 1, messageCount: 1});
	clock = 185; trace.recordAtomicCommit(token, {resultCount: 5, committedCount: 5, confirmedCount: 5});
	clock = 190; trace.finishRun(token, {status: "committed", translatedCount: 5});
	const run = trace.getSnapshot().latestRun;
	assert.equal(run.sequentialChunkMs, 300);
	assert.equal(run.primarySpanMs, 180);
	assert.equal(run.actualPrimaryConcurrencyImprovementPercent, 40);
	assert.equal(run.actualPrimaryConcurrencySpeedup, 5 / 3);
	assert.equal(run.projectedConcurrency2ChunkMs, null);
	assert.equal(run.projectedConcurrency2TotalMs, null);
	assert.equal(run.projectedConcurrency2ImprovementPercent, null);
	assert.equal(run.chunkCharLimit, 12000);
	assert.equal(run.chunkConstraintViolationCount, 0);
});

test("trace records a multi-message character-limit violation without retaining text", () => {
	const trace = createHistoricalBatchPerformanceTrace({now: () => 10});
	const token = trace.beginRun({collectedMessageCount: 2, chunkSize: 10, chunkCharLimit: 12000});
	trace.recordChunkStarted(token, {index: 0, messageCount: 2, inputChars: 12001});
	trace.recordChunkSettled(token, {index: 0, messageCount: 2});
	trace.finishRun(token, {status: "committed", translatedCount: 2});
	assert.equal(trace.getSnapshot().latestRun.chunkConstraintViolationCount, 1);
});

test("bounded public chunk samples do not truncate exact sequential and projection metrics", () => {
	let clock = 0;
	const trace = createHistoricalBatchPerformanceTrace({now: () => clock, chunkSampleLimit: 2});
	const token = trace.beginRun({collectedMessageCount: 5, concurrency: 1});
	for (const [index, duration] of [100, 80, 60, 40, 20].entries()) {
		trace.recordChunkStarted(token, {index, messageCount: 1, inputChars: 10});
		clock += duration;
		trace.recordChunkSettled(token, {index, messageCount: 1});
	}
	trace.finishRun(token, {status: "committed", translatedCount: 5});
	const run = trace.getSnapshot().latestRun;
	assert.equal(run.chunkSamples.length, 2, "the copied diagnostics remain bounded");
	assert.equal(run.sequentialChunkMs, 300, "all five private numeric durations contribute");
	assert.equal(run.projectedConcurrency2ChunkMs, 200, "the serial probe plus two-slot remainder uses all five durations");
	assert.equal(run.projectedConcurrency2TotalMs, 200);
});
