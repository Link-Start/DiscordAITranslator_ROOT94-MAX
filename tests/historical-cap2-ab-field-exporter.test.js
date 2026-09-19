const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HistoricalCap2AbFieldExporter,
	sanitizeRun,
	invalidReasons,
	isNeutralNonProviderRun
} = require("../scripts/historical-cap2-ab-field-exporter.plugin");

const ARM_PATTERN = [1, 2, 2, 1];

function run(arm, index, totalMs = arm === 1 ? 5000 : 3000, providerInputChars = 4000 + index, overrides = {}) {
	const providerMessageCount = overrides.providerMessageCount == null ? 40 : overrides.providerMessageCount;
	const requestedChunks = overrides.requestedChunks == null ? Math.ceil(providerMessageCount / 10) : overrides.requestedChunks;
	const chunkSamples = overrides.chunkSamples || Array.from({length: requestedChunks}, (_, chunkIndex) => ({
		index: chunkIndex,
		messageCount: chunkIndex === requestedChunks - 1 ? providerMessageCount - chunkIndex * 10 : 10,
		inputChars: Math.max(1, Math.floor(providerInputChars / requestedChunks)),
		statusCode: null,
		failureKind: null
	}));
	return Object.assign({
		concurrency: arm,
		chunkSize: 10,
		collectedMessageCount: providerMessageCount,
		providerMessageCount,
		providerInputChars,
		requestedChunks,
		settledChunks: requestedChunks,
		settledMessageCount: providerMessageCount,
		maxActiveChunks: arm === 2 && requestedChunks >= 3 ? 2 : 1,
		globalMaxActiveChunks: arm === 2 && requestedChunks >= 3 ? 2 : 1,
		activeChunksAtFinish: 0,
		duplicateChunkEventCount: 0,
		orphanChunkSettleCount: 0,
		failureCount: 0,
		repairBatchRequests: 0,
		repairBatchMessages: 0,
		repairItemRequests: 0,
		atomicCommitCount: 1,
		commitResultCount: providerMessageCount,
		committedCount: providerMessageCount,
		confirmedCount: providerMessageCount,
		deferredCount: 0,
		rejectedCount: 0,
		missingCount: 0,
		retryCount: 0,
		staleCount: 0,
		commitErrorCount: 0,
		translatedCount: providerMessageCount,
		skippedCount: 0,
		failedCount: 0,
		liveOverlapDispatches: 0,
		liveTurnsDuringRun: 0,
		liveOverlapDuringChunks: 0,
		totalMs,
		status: "committed",
		chunkSamples
	}, overrides);
}

function display(overrides = {}) {
	return Object.assign({
		fullRepaints: 0,
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
	}, overrides);
}

function controller(overrides = {}) {
	return Object.assign({
		deferredFlushErrorCount: 0,
		resources: {
			pendingChannelCount: 0,
			pendingMessageCount: 0,
			pendingHostMessageCount: 0,
			pendingHostViewCount: 0,
			activeDeferredFlushCount: 0,
			activeDeferredMessageCount: 0,
			activeDeferredHostMessageCount: 0,
			activeDeferredHostViewCount: 0,
			deferredFlushTimerArmed: false
		}
	}, overrides);
}

function memoryFs({failAtWrite = null} = {}) {
	const files = new Map();
	let writes = 0;
	return {
		files,
		mkdirSync() {},
		writeFileSync(name, value) {
			writes++;
			if (writes === failAtWrite) throw new Error("disk full");
			files.set(name, String(value));
		},
		renameSync(from, to) {files.set(to, files.get(from)); files.delete(from);},
		unlinkSync(name) {files.delete(name);}
	};
}

function snapshot(overrides = {}) {
	return Object.assign({
		generation: 1,
		completedRunCount: 0,
		activeRunCount: 0,
		activeChunkCount: 0,
		configuredConcurrency: 1,
		physical: {capacity: 1, active: 0, waiting: 0, highWater: 0, generation: 0},
		recentRuns: []
	}, overrides);
}

function createHarness({initialSnapshot = snapshot(), initialLive = {queueLength: 0, active: 0, busy: false}, fileSystem = memoryFs(), setBehavior = null} = {}) {
	let current = initialSnapshot;
	let displaySnapshot = display();
	let controllerSnapshot = controller();
	let liveSnapshot = initialLive;
	const arms = [];
	const timers = [];
	const plugin = {
		setHistoricalBatchExperimentConcurrency(value) {
			arms.push(value);
			if (setBehavior) return setBehavior(value, {
				getSnapshot: () => current,
				setSnapshot: value => {current = value;}
			});
			current = Object.assign({}, current, {
				configuredConcurrency: value,
				physical: Object.assign({}, current.physical, {capacity: value})
			});
			return value;
		},
		getHistoricalBatchPerformanceSnapshot: () => current,
		ensureReceivedDisplayRepaintScheduler: () => ({getDiagnostics: () => displaySnapshot}),
		ensureReceivedDisplayRuntime: () => ({getControllerDiagnostics: () => controllerSnapshot}),
		ensureLiveTranslationQueue: () => ({getQueueLength: () => liveSnapshot.queueLength, getLiveSlotActiveCount: () => liveSnapshot.active, isBusyTranslating: () => liveSnapshot.busy})
	};
	const exporter = new HistoricalCap2AbFieldExporter({
		globals: {BdApi: {Plugins: {get: () => plugin}, showToast() {}}},
		fileSystem,
		outputPath: "ab.json",
		setTimeout(callback) {timers.push(callback); return timers.length;},
		clearTimeout() {}
	});
	return {
		exporter,
		plugin,
		arms,
		timers,
		fileSystem,
		getSnapshot: () => current,
		setSnapshot: value => {current = value;},
		setDisplay: value => {displaySnapshot = value;},
		setController: value => {controllerSnapshot = value;},
		setLive: value => {liveSnapshot = value;},
		poll() {
			const callback = timers.shift();
			assert.equal(typeof callback, "function", "a poll callback must be armed");
			callback();
		}
	};
}

test("sanitizer is payload-free and rejects 429, repair, stale, live overlap and arm mismatch", () => {
	const clean = run(2, 0);
	assert.deepEqual(invalidReasons(sanitizeRun(clean), 2), []);

	const privateSentinels = {
		messageId: "PRIVATE_MESSAGE_ID",
		channelId: "PRIVATE_CHANNEL_ID",
		endpoint: "https://private.invalid/v1",
		model: "PRIVATE_MODEL",
		apiKey: "PRIVATE_API_KEY",
		text: "PRIVATE_MESSAGE_TEXT",
		prompt: "PRIVATE_PROMPT",
		rawResponse: "PRIVATE_RESPONSE"
	};
	const serialized = JSON.stringify(sanitizeRun(Object.assign({}, clean, privateSentinels)));
	for (const sentinel of Object.values(privateSentinels)) assert.equal(serialized.includes(sentinel), false);

	const rateLimited = sanitizeRun(run(2, 0, 3000, 4000, {
		failureCount: 1,
		chunkSamples: [{index: 0, messageCount: 10, inputChars: 1000, statusCode: 429, failureKind: "transient"}]
	}));
	assert.equal(rateLimited.rateLimitCount, 1);
	assert.ok(invalidReasons(rateLimited, 2).includes("failure_or_repair"));
	assert.ok(invalidReasons(sanitizeRun(run(2, 0, 3000, 4000, {repairItemRequests: 1})), 2).includes("failure_or_repair"));
	assert.ok(invalidReasons(sanitizeRun(run(2, 0, 3000, 4000, {staleCount: 1})), 2).includes("commit_not_clean"));
	assert.ok(invalidReasons(sanitizeRun(run(2, 0, 3000, 4000, {commitErrorCount: 1})), 2).includes("commit_not_clean"));
	assert.ok(invalidReasons(sanitizeRun(run(2, 0, 3000, 4000, {liveOverlapDispatches: 1})), 2).includes("live_overlap"));
	assert.ok(invalidReasons(sanitizeRun(run(1, 0)), 2).includes("arm_mismatch"));
});

test("verified ABBA rounds reach both sample gates, use normalized comparable work, and record restored cap1", () => {
	const h = createHarness();
	h.exporter.start();
	for (let index = 0; index < 8; index++) {
		const arm = ARM_PATTERN[index % ARM_PATTERN.length];
		h.setSnapshot(Object.assign({}, h.getSnapshot(), {
			completedRunCount: index + 1,
			activeRunCount: 0,
			activeChunkCount: 0,
			recentRuns: Array.from({length: index + 1}, (_, runIndex) => run(ARM_PATTERN[runIndex % ARM_PATTERN.length], runIndex))
		}));
		h.poll();
	}
	h.poll();

	const record = JSON.parse(h.fileSystem.files.get("ab.json"));
	assert.equal(record.ok, true);
	assert.equal(record.summary.cap1.runs, 4);
	assert.equal(record.summary.cap2.runs, 4);
	assert.equal(record.summary.cap1.chunks, 16);
	assert.equal(record.summary.cap2.chunks, 16);
	assert.equal(record.summary.workloadComparable, true);
	assert.equal(record.summary.improvementPercent, 40);
	assert.equal(record.summary.historyGatePassed, true);
	assert.equal(record.summary.decision, "history_pass_live_check_pending");
	assert.equal(record.restoredCap1, true);
	assert.equal(record.history.configuredConcurrency, 1);
	assert.equal(record.physical.capacity, 1);
	assert.equal(h.arms.at(-1), 1);
});

test("one polluted session round is a terminal safety veto rather than survivorship-filtered evidence", () => {
	const h = createHarness();
	h.exporter.start();
	const polluted = run(1, 0, 5000, 4000, {repairBatchRequests: 1, repairBatchMessages: 10});
	h.setSnapshot(Object.assign({}, h.getSnapshot(), {completedRunCount: 1, recentRuns: [polluted]}));
	h.poll();

	const record = JSON.parse(h.fileSystem.files.get("ab.json"));
	assert.equal(record.ok, false);
	assert.equal(record.state, "failed");
	assert.equal(record.summary.historyGatePassed, false);
	assert.equal(record.summary.decision, "keep_cap1_session_unsafe");
	assert.ok(record.sessionUnsafeReasons.includes("run_failure_or_repair"));
	assert.equal(record.invalidRuns.length, 1);
	assert.equal(record.restoredCap1, true);
	assert.equal(record.history.configuredConcurrency, 1);
});

test("a cache-only committed run is neutral and keeps the same A/B arm", () => {
	const h = createHarness();
	h.exporter.start();
	const cached = run(1, 0, 159, 0, {
		providerMessageCount: 0,
		requestedChunks: 0,
		settledChunks: 0,
		settledMessageCount: 0,
		maxActiveChunks: 0,
		globalMaxActiveChunks: 0,
		chunkSamples: [],
		collectedMessageCount: 37,
		commitResultCount: 37,
		confirmedCount: 11,
		rejectedCount: 52,
		translatedCount: 37
	});
	assert.equal(isNeutralNonProviderRun(sanitizeRun(cached), 1), true);
	h.setSnapshot(Object.assign({}, h.getSnapshot(), {completedRunCount: 1, recentRuns: [cached]}));
	h.poll();
	const record = JSON.parse(h.fileSystem.files.get("ab.json"));
	assert.equal(record.state, "collecting");
	assert.equal(record.neutralRuns.length, 1);
	assert.equal(record.validRuns.length, 0);
	assert.equal(record.invalidRuns.length, 0);
	assert.equal(record.expectedArm, 1);
	assert.deepEqual(record.sessionUnsafeReasons, []);
	h.exporter.stop();
});

test("a store-committed row awaiting one targeted repaint stays clean", () => {
	const pending = sanitizeRun(run(2, 0, 3000, 4000, {confirmedCount: 39, missingCount: 1, retryCount: 1}));
	assert.deepEqual(invalidReasons(pending, 2), []);
	assert.ok(invalidReasons(sanitizeRun(run(2, 0, 3000, 4000, {committedCount: 39, confirmedCount: 39, rejectedCount: 1, missingCount: 0, retryCount: 0})), 2).includes("commit_not_clean"));
});

test("a shorter cap2 workload cannot manufacture a passing latency improvement", () => {
	const exporter = new HistoricalCap2AbFieldExporter();
	exporter.validRuns = [
		...Array.from({length: 4}, (_, index) => Object.freeze(Object.assign(sanitizeRun(run(1, index, 5000, 50000 + index)), {arm: 1}))),
		...Array.from({length: 4}, (_, index) => Object.freeze(Object.assign(sanitizeRun(run(2, index, 3000, 100 + index)), {arm: 2})))
	];
	const summary = exporter.summary();
	assert.equal(summary.improvementPercent, 40, "the normalized timing delta remains visible");
	assert.equal(summary.workloadComparable, false);
	assert.equal(summary.historyGatePassed, false);
	assert.equal(summary.decision, "keep_cap1_workload_not_comparable");
});

test("final cap1 is verified and a restore failure changes a requested success into failure", () => {
	const h = createHarness({
		initialSnapshot: snapshot({configuredConcurrency: 2, physical: {capacity: 2, active: 0, waiting: 0, highWater: 2, generation: 1}}),
		setBehavior(value) {
			if (value === 1) throw new Error("restore rejected");
			return value;
		}
	});
	h.exporter.instance = h.plugin;
	h.exporter.latest = {history: h.getSnapshot(), display: display(), controller: controller()};
	h.exporter.baseline = h.exporter.latest;
	h.exporter.finish(true, null);
	const record = JSON.parse(h.fileSystem.files.get("ab.json"));
	assert.equal(record.ok, false);
	assert.equal(record.restoredCap1, false);
	assert.match(record.reason, /restore_cap1_failed/);
	assert.equal(record.history.configuredConcurrency, 2);
	assert.equal(record.physical.capacity, 2);
});

test("a write failure immediately restores and verifies cap1 after the helper selected cap2", () => {
	const h = createHarness({fileSystem: memoryFs({failAtWrite: 2})});
	h.exporter.start();
	h.setSnapshot(Object.assign({}, h.getSnapshot(), {completedRunCount: 1, recentRuns: [run(1, 0)]}));
	h.poll();
	assert.equal(h.exporter.finished, true);
	assert.equal(h.exporter.restoreVerified, true);
	assert.equal(h.getSnapshot().configuredConcurrency, 1);
	assert.equal(h.getSnapshot().physical.capacity, 1);
	assert.equal(h.arms.includes(2), true, "the failed collecting write happened after selecting B");
	assert.equal(h.arms.at(-1), 1);
});

test("a requested B arm is rejected when the fresh runtime snapshot still reports cap1", () => {
	const h = createHarness({
		setBehavior(value, state) {
			if (value === 2) return 2;
			const current = state.getSnapshot();
			state.setSnapshot(Object.assign({}, current, {
				configuredConcurrency: 1,
				physical: Object.assign({}, current.physical, {capacity: 1})
			}));
			return 1;
		}
	});
	h.exporter.start();
	h.setSnapshot(Object.assign({}, h.getSnapshot(), {completedRunCount: 1, recentRuns: [run(1, 0)]}));
	h.poll();
	const record = JSON.parse(h.fileSystem.files.get("ab.json"));
	assert.equal(record.ok, false);
	assert.ok(record.sessionUnsafeReasons.includes("arm_apply_or_verify_failed"));
	assert.equal(record.restoredCap1, true);
	assert.equal(record.history.configuredConcurrency, 1);
	assert.equal(record.physical.capacity, 1);
});

test("an active run at helper start is drained and excluded across the baseline boundary", () => {
	const preexisting = run(1, 0);
	const h = createHarness({initialSnapshot: snapshot({activeRunCount: 1, activeChunkCount: 1, physical: {capacity: 1, active: 1, waiting: 0, highWater: 1, generation: 0}})});
	h.exporter.start();
	assert.equal(h.exporter.discardingPreexisting, true);
	h.setSnapshot(Object.assign({}, h.getSnapshot(), {
		completedRunCount: 1,
		activeRunCount: 0,
		activeChunkCount: 0,
		physical: Object.assign({}, h.getSnapshot().physical, {active: 0}),
		recentRuns: [preexisting]
	}));
	h.poll();
	h.poll();
	assert.equal(h.exporter.discardingPreexisting, false);
	assert.equal(h.exporter.discardedPreexistingRuns, 1);
	assert.equal(h.exporter.validRuns.length, 0);
	assert.equal(h.exporter.lastCompleted, 1);
	h.exporter.stop();
});

test("pre-existing live work is drained before the A/B baseline opens", () => {
	const h = createHarness({initialLive: {queueLength: 1, active: 1, busy: true}});
	h.exporter.start();
	assert.equal(h.exporter.discardingPreexisting, true);
	h.setLive({queueLength: 0, active: 0, busy: false});
	h.poll();
	h.poll();
	assert.equal(h.exporter.discardingPreexisting, false);
	assert.equal(h.exporter.validRuns.length, 0);
	assert.equal(h.exporter.lastCompleted, 0);
	h.exporter.stop();
});

test("display exhaustion is a session safety veto and restores cap1", () => {
	const h = createHarness();
	h.exporter.start();
	h.setDisplay(display({exhausted: 1}));
	h.poll();
	const record = JSON.parse(h.fileSystem.files.get("ab.json"));
	assert.equal(record.ok, false);
	assert.ok(record.sessionUnsafeReasons.includes("display_exhausted"));
	assert.equal(record.restoredCap1, true);
	assert.equal(record.history.configuredConcurrency, 1);
});
