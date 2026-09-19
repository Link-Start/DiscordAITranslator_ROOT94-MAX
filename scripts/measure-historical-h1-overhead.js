"use strict";

const {performance} = require("node:perf_hooks");
const {createHistoricalBatchPerformanceTrace} = require("../src/diagnostics/historical-batch-performance-trace");

function measure() {
	let clock = 0;
	const trace = createHistoricalBatchPerformanceTrace({now: () => ++clock, runLimit: 12, h1SampleLimit: 32});
	const probe = trace.beginRun({collectedMessageCount: 1});
	const durations = [];
	for (let index = 0; index < 10000; index++) {
		const started = performance.now();
		trace.recordCache(probe, {miss: 1});
		durations.push(performance.now() - started);
	}
	trace.recordAtomicCommit(probe, {resultCount: 1, committedCount: 1});
	trace.finishRun(probe, {status: "committed", translatedCount: 1});
	durations.sort((left, right) => left - right);
	for (let runIndex = 0; runIndex < 12; runIndex++) {
		const run = trace.beginRun({collectedMessageCount: 100, batchKey: `private-${runIndex}`});
		for (let index = 0; index < 100; index++) {
			const logical = trace.beginLogical(run, {role: index % 3 === 0 ? "backup" : index % 3 === 1 ? "repair" : "primary", itemCount: 1});
			const attempt = trace.beginAttempt(logical, {role: "primary", engineKey: "fixture"});
			trace.recordAttemptDispatched(attempt, {transportKey: "tk1:fixture", workloadKey: "wk1:fixture", bodyBytes: 100});
			trace.recordAttemptSettled(attempt, {providerRequestId: runIndex * 100 + index + 1, providerAttempt: 1, status: "ok"});
			trace.finishLogical(logical, {status: "settled"});
		}
		trace.recordAtomicCommit(run, {resultCount: 100, committedCount: 100});
		trace.finishRun(run, {status: "committed", translatedCount: 100});
	}
	const snapshot = JSON.stringify(trace.getSnapshot());
	return {
		samples: durations.length,
		recordP95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
		recordMaxMs: durations[durations.length - 1],
		snapshotBytes: Buffer.byteLength(snapshot, "utf8"),
		memoryLimitBytes: 1024 * 1024,
		recordGatePassed: durations[Math.ceil(durations.length * 0.95) - 1] < 0.5,
		memoryGatePassed: Buffer.byteLength(snapshot, "utf8") < 1024 * 1024,
		privateFixtureLeaked: snapshot.includes("private-")
	};
}

if (require.main === module) process.stdout.write(`${JSON.stringify(measure(), null, 2)}\n`);
module.exports = {measure};
