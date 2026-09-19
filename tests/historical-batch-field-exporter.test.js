const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HistoricalBatchFieldExporter,
	sanitizeRun,
	getInvalidReasons
} = require("../scripts/historical-batch-field-exporter.plugin");

function createCleanRun(index) {
	return {
		generation: 1,
		collectedMessageCount: 50,
		concurrency: 1,
		chunkSize: 10,
		requestedChunks: 5,
		settledChunks: 5,
		providerMessageCount: 50,
		providerInputChars: 5000 + index,
		settledMessageCount: 50,
		maxActiveChunks: 1,
		globalMaxActiveChunks: 1,
		activeChunksAtFinish: 0,
		liveOverlapDispatches: 0,
		liveTurnsDuringRun: 0,
		liveOverlapDuringChunks: 0,
		duplicateChunkEventCount: 0,
		orphanChunkSettleCount: 0,
		failureCount: 0,
		repairBatchRequests: 0,
		repairBatchMessages: 0,
		repairItemRequests: 0,
		atomicCommitCount: 1,
		commitResultCount: 50,
		confirmedCount: 50,
		deferredCount: 0,
		rejectedCount: 0,
		staleCount: 0,
		commitErrorCount: 0,
		translatedCount: 50,
		skippedCount: 0,
		failedCount: 0,
		status: "committed",
		totalMs: 5000 + index * 100,
		sealToFirstDispatchMs: 5,
		primarySpanMs: 4500,
		sealToAtomicCommitMs: 4950,
		sequentialChunkMs: 4500,
		projectedConcurrency2ChunkMs: 2700,
		projectedConcurrency2TotalMs: 3200,
		projectedConcurrency2ImprovementPercent: 36,
		chunkSamples: Array.from({length: 5}, (_, chunkIndex) => ({
			index: chunkIndex,
			messageCount: 10,
			inputChars: chunkIndex === 4 ? 1000 + index : 1000,
			dispatchOffsetMs: chunkIndex * 900,
			durationMs: 900,
			failureKind: null,
			statusCode: 200,
			liveActiveAtDispatch: 0,
			secretText: "must disappear"
		})),
		messageId: `secret-${index}`,
		endpoint: "https://secret.invalid"
	};
}

function createNonProviderMixedRun(index = 0) {
	const run = createCleanRun(index);
	run.providerMessageCount = 35;
	run.providerInputChars = 3500;
	run.settledMessageCount = 35;
	run.requestedChunks = 4;
	run.settledChunks = 4;
	run.sequentialChunkMs = 3600;
	run.projectedConcurrency2ChunkMs = 1800;
	run.projectedConcurrency2TotalMs = run.totalMs - 1800;
	run.projectedConcurrency2ImprovementPercent = 36;
	run.chunkSamples = [10, 10, 10, 5].map((messageCount, chunkIndex) => ({index: chunkIndex, messageCount, inputChars: messageCount * 100, dispatchOffsetMs: chunkIndex * 900, durationMs: 900, failureKind: null, statusCode: 200, liveActiveAtDispatch: 0}));
	return run;
}

function createNonProviderOnlyRun(index = 0) {
	const run = createCleanRun(index);
	run.providerMessageCount = 0;
	run.providerInputChars = 0;
	run.settledMessageCount = 0;
	run.requestedChunks = 0;
	run.settledChunks = 0;
	run.maxActiveChunks = 0;
	run.globalMaxActiveChunks = 0;
	run.sequentialChunkMs = 0;
	run.projectedConcurrency2ChunkMs = 0;
	run.projectedConcurrency2TotalMs = run.totalMs;
	run.projectedConcurrency2ImprovementPercent = 0;
	run.chunkSamples = [];
	return run;
}

function createFileSystem() {
	const files = new Map();
	return {
		files,
		mkdirSync: () => {},
		writeFileSync: (name, value) => files.set(name, String(value)),
		renameSync: (from, to) => {files.set(to, files.get(from)); files.delete(from);},
		unlinkSync: name => files.delete(name)
	};
}

function idleDisplayDiagnostics() {
	return {
		fullRepaints: 0,
		scheduled: 4,
		flushes: 4,
		renderBatches: 4,
		confirmed: 200,
		deferred: 0,
		retries: 0,
		exhausted: 0,
		resources: {
			queuedChannels: 0,
			queuedMessages: 0,
			activeChannels: 0,
			activeMessages: 0,
			coalesceTimerArmed: false,
			fullRepaintTimerArmed: false,
			settingsRetryTimerArmed: false,
			textAreaRetryTimerArmed: false,
			deferredFullRepaintPending: false
		}
	};
}

function idleControllerDiagnostics() {
	return {deferredFlushErrorCount: 0, resources: {pendingChannelCount: 0, pendingMessageCount: 0, pendingHostMessageCount: 0, pendingHostViewCount: 0, activeDeferredFlushCount: 0, activeDeferredMessageCount: 0, activeDeferredHostMessageCount: 0, activeDeferredHostViewCount: 0, deferredFlushTimerArmed: false}};
}

test("the exporter keeps only anonymous historical fields", () => {
	const raw = createCleanRun(1);
	raw.status = "secret status";
	raw.chunkSamples[0].failureKind = "secret failure";
	const sanitizedUnknown = sanitizeRun(raw);
	assert.equal(sanitizedUnknown.status, "unknown");
	assert.equal(sanitizedUnknown.chunkSamples[0].failureKind, "unknown");
	const sanitized = sanitizeRun(createCleanRun(1));
	const serialized = JSON.stringify(sanitized);
	assert.equal(getInvalidReasons(sanitized).length, 0);
	assert.doesNotMatch(serialized, /secret|endpoint|messageId|must disappear/);
	assert.equal(sanitized.chunkSamples.length, 5);
});

test("four new clean runs produce one complete field record", () => {
	let snapshot = {
		generation: 1,
		completedRunCount: 0,
		recentRuns: []
	};
	const plugin = {
		getHistoricalBatchPerformanceSnapshot: () => snapshot,
		ensureProviderClient: () => ({getLatencySnapshot: () => ({attemptTotalCount: snapshot.completedRunCount * 5, batchRequestCount: snapshot.completedRunCount * 5, batchMessageCount: snapshot.completedRunCount * 50, failoverCount: 0, timeoutCount: 0, rateLimitCount: 0, historicalAttemptCount: snapshot.completedRunCount * 5, historicalBatchRequestCount: snapshot.completedRunCount * 5, historicalBatchMessageCount: snapshot.completedRunCount * 50, historicalFailoverCount: 0, historicalTimeoutCount: 0, historicalRateLimitCount: 0})}),
		ensureReceivedDisplayRepaintScheduler: () => ({getDiagnostics: idleDisplayDiagnostics}),
		ensureReceivedDisplayRuntime: () => ({getControllerDiagnostics: idleControllerDiagnostics})
	};
	const globals = {BdApi: {Plugins: {get: () => plugin}, showToast: () => {}}};
	const timers = [];
	const fileSystem = createFileSystem();
	const exporter = new HistoricalBatchFieldExporter({
		globals,
		fileSystem,
		outputPath: "field.json",
		setTimeout: callback => {timers.push(callback); return timers.length;},
		clearTimeout: () => {},
		targetValidRuns: 4
	});

	exporter.start();
	for (let index = 0; index < 4; index++) {
		snapshot = {
			generation: 1,
			completedRunCount: index + 1,
			recentRuns: Array.from({length: index + 1}, (_, runIndex) => createCleanRun(runIndex))
		};
		const callback = timers.shift();
		callback();
	}
	timers.shift()();

	const record = JSON.parse(fileSystem.files.get("field.json"));
	assert.equal(record.ok, true);
	assert.equal(record.state, "complete");
	assert.equal(record.validRuns.length, 4);
	assert.equal(record.invalidRuns.length, 0);
	assert.equal(record.summary.projectedConcurrency2ImprovementP50Percent, 36);
	assert.equal(record.display.fullRepaints, 0);
	assert.equal(record.latencyDelta.batchRequestCount, 20);
	assert.equal(record.latencyDelta.batchMessageCount, 200);
	assert.equal(record.latencyDelta.historicalAttemptCount, 20);
	assert.doesNotMatch(JSON.stringify(record), /secret|endpoint|messageId|must disappear/);
});

test("a repaired or overlapping run is retained as invalid evidence", () => {
	const run = sanitizeRun(Object.assign(createCleanRun(0), {repairBatchRequests: 1, liveOverlapDispatches: 1}));
	assert.deepEqual(getInvalidReasons(run), ["failure_or_repair", "live_overlap"]);
});

test("wrong chunk shape and incomplete commit acknowledgement never count as clean", () => {
	const malformed = sanitizeRun(Object.assign(createCleanRun(0), {chunkSize: 99, commitResultCount: 49, confirmedCount: 0}));
	assert.deepEqual(getInvalidReasons(malformed), ["incomplete_resources", "commit_not_clean"]);
});

test("a complete atomic commit may include safely deferred rows", () => {
	const deferred = sanitizeRun(Object.assign(createCleanRun(0), {confirmedCount: 49, deferredCount: 1}));
	assert.deepEqual(getInvalidReasons(deferred), []);
});

test("mixed and non-provider-only logical jobs stay clean without attributing local outcomes to cache", () => {
	const mixed = sanitizeRun(createNonProviderMixedRun());
	assert.deepEqual(getInvalidReasons(mixed), []);
	assert.equal(mixed.nonProviderMessageCount, 15);
	const cached = sanitizeRun(createNonProviderOnlyRun());
	assert.deepEqual(getInvalidReasons(cached), []);
	assert.equal(cached.nonProviderMessageCount, 50);
	const exporter = new HistoricalBatchFieldExporter();
	exporter.validRuns = Array.from({length: 4}, (_, index) => sanitizeRun(createNonProviderMixedRun(index)));
	assert.equal(exporter.getEvidenceClass(), "provider_evidence_ready");
	exporter.validRuns = Array.from({length: 8}, (_, index) => sanitizeRun(createNonProviderOnlyRun(index)));
	assert.equal(exporter.getEvidenceClass(), "low_provider_demand");
});

test("hot reload resets collected runs and a busy fifth job delays final success", () => {
	let firstSnapshot = {generation: 1, completedRunCount: 0, activeRunCount: 0, activeChunkCount: 0, recentRuns: []};
	const first = {getHistoricalBatchPerformanceSnapshot: () => firstSnapshot};
	let secondSnapshot = {generation: 1, completedRunCount: 4, activeRunCount: 1, activeChunkCount: 1, recentRuns: Array.from({length: 4}, (_, index) => createCleanRun(index))};
	const second = {getHistoricalBatchPerformanceSnapshot: () => secondSnapshot};
	first.ensureProviderClient = () => ({getLatencySnapshot: () => ({attemptTotalCount: 0, batchRequestCount: 0, batchMessageCount: 0, failoverCount: 0, timeoutCount: 0, rateLimitCount: 0, historicalAttemptCount: 0, historicalBatchRequestCount: 0, historicalBatchMessageCount: 0, historicalFailoverCount: 0, historicalTimeoutCount: 0, historicalRateLimitCount: 0})});
	second.ensureProviderClient = () => ({getLatencySnapshot: () => ({attemptTotalCount: secondSnapshot.completedRunCount * 5, batchRequestCount: secondSnapshot.completedRunCount * 5, batchMessageCount: secondSnapshot.completedRunCount * 50, failoverCount: 0, timeoutCount: 0, rateLimitCount: 0, historicalAttemptCount: secondSnapshot.completedRunCount * 5, historicalBatchRequestCount: secondSnapshot.completedRunCount * 5, historicalBatchMessageCount: secondSnapshot.completedRunCount * 50, historicalFailoverCount: 0, historicalTimeoutCount: 0, historicalRateLimitCount: 0})});
	for (const plugin of [first, second]) {
		plugin.ensureReceivedDisplayRepaintScheduler = () => ({getDiagnostics: idleDisplayDiagnostics});
		plugin.ensureReceivedDisplayRuntime = () => ({getControllerDiagnostics: idleControllerDiagnostics});
	}
	let current = first;
	const timers = [];
	const fileSystem = createFileSystem();
	const exporter = new HistoricalBatchFieldExporter({
		globals: {BdApi: {Plugins: {get: () => current}, showToast: () => {}}},
		fileSystem,
		outputPath: "reload.json",
		setTimeout: callback => {timers.push(callback); return timers.length;},
		clearTimeout: () => {}
	});
	exporter.start();
	current = second;
	timers.shift()();
	assert.equal(exporter.validRuns.length, 0, "pre-reload and preexisting replacement runs are not mixed");
	secondSnapshot = {generation: 1, completedRunCount: 8, activeRunCount: 1, activeChunkCount: 1, recentRuns: Array.from({length: 8}, (_, index) => createCleanRun(index))};
	timers.shift()();
	assert.equal(exporter.validRuns.length, 4);
	assert.equal(exporter.finished, false, "an active fifth job keeps the output provisional");
	secondSnapshot = {generation: 1, completedRunCount: 9, activeRunCount: 0, activeChunkCount: 0, recentRuns: Array.from({length: 9}, (_, index) => createCleanRun(index))};
	timers.shift()();
	assert.equal(exporter.finished, false, "the first idle observation only arms the stability gate");
	timers.shift()();
	assert.equal(exporter.finished, true);
	assert.equal(JSON.parse(fileSystem.files.get("reload.json")).validRuns.length, 5);
});

test("a write failure stops cleanly instead of throwing from plugin start", () => {
	const plugin = {
		getHistoricalBatchPerformanceSnapshot: () => ({generation: 1, completedRunCount: 0, recentRuns: []}),
		ensureProviderClient: () => ({getLatencySnapshot: () => ({})}),
		ensureReceivedDisplayRepaintScheduler: () => ({getDiagnostics: idleDisplayDiagnostics}),
		ensureReceivedDisplayRuntime: () => ({getControllerDiagnostics: idleControllerDiagnostics})
	};
	const exporter = new HistoricalBatchFieldExporter({
		globals: {BdApi: {Plugins: {get: () => plugin}, showToast: () => {}}},
		fileSystem: {mkdirSync: () => {}, writeFileSync: () => {throw new Error("disk full");}, renameSync: () => {}, unlinkSync: () => {}},
		outputPath: "failure.json",
		setTimeout: () => {throw new Error("timer must not arm");},
		clearTimeout: () => {}
	});
	assert.doesNotThrow(() => exporter.start());
	assert.equal(exporter.finished, true);
	assert.equal(exporter.timer, null);
});

test("contaminated runs are skipped while a ring gap still terminates explicitly", () => {
	for (const scenario of ["invalid", "missed"]) {
		let snapshot = {generation: 1, completedRunCount: 0, activeRunCount: 0, activeChunkCount: 0, recentRuns: []};
		const plugin = {
			getHistoricalBatchPerformanceSnapshot: () => snapshot,
			ensureProviderClient: () => ({getLatencySnapshot: () => ({})}),
			ensureReceivedDisplayRepaintScheduler: () => ({getDiagnostics: idleDisplayDiagnostics}),
			ensureReceivedDisplayRuntime: () => ({getControllerDiagnostics: idleControllerDiagnostics})
		};
		const timers = [];
		const fileSystem = createFileSystem();
		const exporter = new HistoricalBatchFieldExporter({
			globals: {BdApi: {Plugins: {get: () => plugin}, showToast: () => {}}},
			fileSystem,
			outputPath: `${scenario}.json`,
			setTimeout: callback => {timers.push(callback); return timers.length;},
			clearTimeout: () => {}
		});
		exporter.start();
		if (scenario === "invalid") snapshot = {generation: 1, completedRunCount: 1, activeRunCount: 0, activeChunkCount: 0, recentRuns: [Object.assign(createCleanRun(0), {repairBatchRequests: 1})]};
		else snapshot = {generation: 1, completedRunCount: 20, activeRunCount: 0, activeChunkCount: 0, recentRuns: [createCleanRun(19)]};
		timers.shift()();
		let record = JSON.parse(fileSystem.files.get(`${scenario}.json`));
		if (scenario === "invalid") {
			assert.equal(exporter.finished, false);
			assert.equal(record.invalidRuns.length, 1);
			assert.equal(record.state, "collecting");
			snapshot = {generation: 1, completedRunCount: 5, activeRunCount: 0, activeChunkCount: 0, recentRuns: [Object.assign(createCleanRun(0), {repairBatchRequests: 1}), ...Array.from({length: 4}, (_, index) => createCleanRun(index + 1))]};
			timers.shift()();
			timers.shift()();
			record = JSON.parse(fileSystem.files.get(`${scenario}.json`));
			assert.equal(record.ok, true);
			assert.equal(record.evidenceClass, "provider_evidence_ready");
			assert.equal(record.invalidRuns.length, 1);
		}
		else {
			assert.equal(exporter.finished, true);
			assert.equal(record.ok, false);
			assert.equal(record.reason, "missed_history_runs");
			assert.ok(record.missedRunCount > 0);
		}
	}
});

test("generation reset deduplicates snapshots and valid-run storage is bounded", () => {
	const exporter = new HistoricalBatchFieldExporter({targetValidRuns: 100});
	exporter.generation = 1;
	exporter.lastCompletedRunCount = 0;
	let history = {generation: 1, completedRunCount: 1, recentRuns: [createCleanRun(0)]};
	assert.equal(exporter.consumeCompletedRuns({history}), 1);
	assert.equal(exporter.consumeCompletedRuns({history}), 0);
	assert.equal(exporter.validRuns.length, 1, "polling the same snapshot never duplicates a run");
	assert.equal(exporter.consumeCompletedRuns({history: {generation: 2, completedRunCount: 0, recentRuns: []}}), -1);
	assert.equal(exporter.validRuns.length, 0);
	assert.equal(exporter.lastCompletedRunCount, 0);

	exporter.generation = 2;
	for (let completed = 1; completed <= 21; completed++) {
		const available = Math.min(completed, 12);
		history = {generation: 2, completedRunCount: completed, recentRuns: Array.from({length: available}, (_, offset) => createCleanRun(completed - available + offset))};
		exporter.consumeCompletedRuns({history});
	}
	assert.equal(exporter.validRuns.length, 20);
	assert.equal(exporter.excessHistoryRuns, true);
});

test("eight clean non-provider-only jobs complete with a neutral low-demand conclusion", () => {
	let snapshot = {generation: 1, completedRunCount: 0, activeRunCount: 0, activeChunkCount: 0, recentRuns: []};
	const plugin = {
		getHistoricalBatchPerformanceSnapshot: () => snapshot,
		ensureProviderClient: () => ({getLatencySnapshot: () => ({attemptTotalCount: 0, batchRequestCount: 0, batchMessageCount: 0, historicalAttemptCount: 0, historicalBatchRequestCount: 0, historicalBatchMessageCount: 0})}),
		ensureReceivedDisplayRepaintScheduler: () => ({getDiagnostics: idleDisplayDiagnostics}),
		ensureReceivedDisplayRuntime: () => ({getControllerDiagnostics: idleControllerDiagnostics})
	};
	const timers = [];
	const fileSystem = createFileSystem();
	const exporter = new HistoricalBatchFieldExporter({
		globals: {BdApi: {Plugins: {get: () => plugin}, showToast: () => {}}},
		fileSystem,
		outputPath: "warm.json",
		setTimeout: callback => {timers.push(callback); return timers.length;},
		clearTimeout: () => {}
	});
	exporter.start();
	for (let completed = 1; completed <= 8; completed++) {
		snapshot = {generation: 1, completedRunCount: completed, activeRunCount: 0, activeChunkCount: 0, recentRuns: Array.from({length: completed}, (_, index) => createNonProviderOnlyRun(index))};
		timers.shift()();
	}
	timers.shift()();
	const record = JSON.parse(fileSystem.files.get("warm.json"));
	assert.equal(record.ok, true);
	assert.equal(record.evidenceClass, "low_provider_demand");
	assert.equal(record.cap2GatePassed, false);
	assert.equal(record.decision, "keep_cap1_low_provider_demand");
	assert.equal(record.validRuns.length, 8);
	assert.equal(record.summary.totalPrimaryChunks, 0);
	assert.equal(record.summary.totalNonProviderMessages, 400);
});

test("enough provider evidence reports the 60/20 cap2 gate separately", () => {
	const exporter = new HistoricalBatchFieldExporter();
	exporter.validRuns = Array.from({length: 4}, (_, index) => sanitizeRun(createCleanRun(index)));
	exporter.latest = exporter.baseline = {history: {}, latency: {}, display: {}, controller: {}};
	let record = exporter.createRecord(false, "collecting");
	assert.equal(record.evidenceClass, "provider_evidence_ready");
	assert.equal(record.cap2GatePassed, true);
	assert.equal(record.decision, "eligible_for_f1h1_review");
	exporter.validRuns = exporter.validRuns.map(run => Object.assign({}, run, {sequentialChunkMs: 500, projectedConcurrency2ImprovementPercent: 0}));
	record = exporter.createRecord(false, "collecting");
	assert.equal(record.evidenceClass, "provider_evidence_ready");
	assert.equal(record.cap2GatePassed, false);
	assert.equal(record.decision, "keep_cap1_insufficient_projected_benefit");
});
