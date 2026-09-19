const test = require("node:test");
const assert = require("node:assert/strict");
const {DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY, createPluginHistoricalBatchPerformance} = require("../../src/diagnostics/historical-batch-performance-wiring");

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {resolve = resolvePromise; reject = rejectPromise;});
	return {promise, resolve, reject};
}

function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

const transportKey = suffix => `tk1:${String(suffix).padStart(64, "a")}`;

function createPhysicalHarness() {
	const current = new Set();
	const requests = [];
	let active = 0;
	let highWater = 0;
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		awaitProviderBackoff: () => Promise.resolve(),
		ensureProviderClient: () => ({isBackoffActive: () => false}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		requestAiBatchTranslationDetailed: (_engineKey, items) => {
			const deferred = createDeferred();
			active++;
			highWater = Math.max(highWater, active);
			requests.push({items, deferred});
			return deferred.promise.finally(() => {active--;});
		}
	};
	const makeJob = id => {
		const job = {id, items: new Map([[id, {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
		current.add(job);
		return job;
	};
	return {owner, current, requests, makeJob, getActive: () => active, getHighWater: () => highWater};
}

async function completeCleanPromotionJob(controller, harness, {id, key = transportKey("1"), beforeFinish = null, commit = null} = {}) {
	const tier = controller.getSnapshot().configuredConcurrency;
	const count = (tier + 1) * 10;
	const job = {
		id,
		items: new Map(Array.from({length: count}, (_, index) => [`${id}-${index}`, {}])),
		state: "translating",
		createSummary: () => ({translated: Array.from({length: count}, () => ({})), skipped: [], failed: []})
	};
	harness.current.add(job);
	job.historicalPerformanceToken = controller.begin(job);
	controller.captureTransportKey(job, key);
	const requestStart = harness.requests.length;
	const prepared = Array.from({length: count}, (_, index) => ({message: {id: `${id}-${index}`}, protectedText: `text-${index}`}));
	let finished = false;
	const running = controller.runPrimaryBatch(harness.owner, "engine", prepared, job, () => {}).finally(() => {finished = true;});
	while (!finished) {
		await settle(); await settle();
		const pending = harness.requests.slice(requestStart).filter(request => !request.settled);
		if (!pending.length) {await settle(); continue;}
		for (const request of pending) {
			request.settled = true;
			request.deferred.resolve({translations: Object.fromEntries(request.items.map(item => [item.message.id, "ok"])), failureKind: null, statusCode: 200});
		}
	}
	await running;
	const ids = prepared.map(item => item.message.id);
	if (commit) await commit(job, ids);
	else controller.recordAtomicCommit(job, {committedIds: ids, confirmedIds: ids, deferredIds: [], rejectedIds: [], missingIds: [], retryIds: [], staleIds: []}, count, false);
	job.state = "committed";
	if (beforeFinish) await beforeFinish();
	const completed = controller.finish(harness.owner, job);
	harness.current.delete(job);
	return {job, completed};
}

function throwingTrace() {
	return {
		beginRun: () => {throw new Error("trace begin");},
		finishRun: () => {throw new Error("trace finish");},
		recordChunkStarted: () => {throw new Error("trace start");},
		recordChunkSettled: () => {throw new Error("trace settle");},
		recordRepairRequest: () => {throw new Error("trace repair");},
		recordAtomicCommit: () => {throw new Error("trace commit");},
		recordLiveTurnStarted: () => {throw new Error("trace live");},
		getSnapshot: () => ({}),
		reset: () => {throw new Error("trace reset");}
	};
}

test("historical primary concurrency defaults to two and restart restores that default", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	assert.equal(DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY, 2);
	assert.equal(controller.getSnapshot().configuredConcurrency, 2);
	assert.equal(controller.getSnapshot().physical.capacity, 2);
	controller.setConcurrency(1);
	assert.equal(controller.getSnapshot().configuredConcurrency, 1);
	await controller.stop();
	controller.start();
	assert.equal(controller.getSnapshot().configuredConcurrency, 2);
	assert.equal(controller.getSnapshot().physical.capacity, 2);
	await controller.stop();
});

test("auto mode promotes two clean saturated jobs per tier from two to three to four", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	assert.equal(controller.getSnapshot().adaptiveMode, true);
	await completeCleanPromotionJob(controller, harness, {id: "cap2-a"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 2);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	await completeCleanPromotionJob(controller, harness, {id: "cap2-b"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 3);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 0);
	await completeCleanPromotionJob(controller, harness, {id: "cap3-a"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 3);
	await completeCleanPromotionJob(controller, harness, {id: "cap3-b"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 4);
	assert.equal(controller.getSnapshot().maxConfiguredConcurrency, 4);
	assert.equal(harness.getHighWater(), 3, "the promotion applies only to the next job");
	const cap4 = await completeCleanPromotionJob(controller, harness, {id: "cap4-smoke"});
	assert.equal(cap4.completed.concurrency, 4);
	assert.equal(cap4.completed.maxActiveChunks, 4);
	assert.equal(harness.getHighWater(), 4);
	await controller.stop();
});

test("character-created chunks count as clean saturation for adaptive promotion", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance({chunkCharLimit: 12});
	controller.start();
	await completeCleanPromotionJob(controller, harness, {id: "char-cap-a"});
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	assert.equal(controller.getSnapshot().latestRun.chunkCharLimit, 12);
	assert.ok(controller.getSnapshot().latestRun.requestedChunks > Math.ceil(controller.getSnapshot().latestRun.providerMessageCount / 10));
	await completeCleanPromotionJob(controller, harness, {id: "char-cap-b"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 3);
	await controller.stop();
});

test("S6 live demand temporarily caps one and preserves the learned tier", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	await completeCleanPromotionJob(controller, harness, {id: "live-reset-a"});
	await completeCleanPromotionJob(controller, harness, {id: "live-reset-b"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 3);
	await completeCleanPromotionJob(controller, harness, {id: "live-reset-c"});
	await completeCleanPromotionJob(controller, harness, {id: "live-reset-d"});
	assert.equal(controller.getSnapshot().configuredConcurrency, 4);
	controller.recordLiveDemand();
	assert.equal(controller.getSnapshot().configuredConcurrency, 4);
	assert.equal(controller.getSnapshot().learnedTier, 4);
	assert.equal(controller.getSnapshot().physical.capacity, 1);
	assert.equal(controller.getSnapshot().pressureLocked, false);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 0);
	await controller.stop();
});

test("S6 live overlap is neutral and keeps existing promotion evidence", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	await completeCleanPromotionJob(controller, harness, {id: "finish-race-a"});
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	await completeCleanPromotionJob(controller, harness, {id: "finish-race-b", beforeFinish: () => controller.recordLiveTurnStarted()});
	assert.equal(controller.getSnapshot().configuredConcurrency, 2);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	assert.equal(controller.getSnapshot().physical.capacity, 1);
	assert.equal(controller.getSnapshot().pressureLocked, false);
	await controller.stop();
});

test("the explicit setter supports fixed one through four and disables auto promotion", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	for (const tier of [1, 2, 3, 4]) {
		assert.equal(controller.setConcurrency(tier), tier);
		assert.equal(controller.getSnapshot().configuredConcurrency, tier);
		assert.equal(controller.getSnapshot().physical.capacity, tier);
		assert.equal(controller.getSnapshot().adaptiveMode, false);
	}
	await controller.stop();
});

test("the same setter restores adaptive mode when the UI selects auto", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(4);
	assert.equal(controller.setConcurrency("auto"), 2);
	assert.equal(controller.getSnapshot().adaptiveMode, true);
	assert.equal(controller.getSnapshot().configuredConcurrency, 2);
	assert.equal(controller.getSnapshot().physical.capacity, 2);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 0);
	await controller.stop();
});

test("a UI arm change can reset historical measurements without restarting leases", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.begin({items: new Map([["m1", {}]]), sealedAt: 1, configurationSignature: "fixture"});
	assert.equal(controller.getSnapshot().startedRunCount, 1);
	controller.setConcurrency(3, {resetTrace: true});
	assert.equal(controller.getSnapshot().startedRunCount, 0);
	assert.equal(controller.getSnapshot().recentRunCount, 0);
	assert.equal(controller.getSnapshot().configuredConcurrency, 3);
	assert.equal(controller.getSnapshot().physical.capacity, 3);
	await controller.stop();
});

test("S6 a new captured Transport Key starts at two without borrowing the prior key evidence", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	const keyA = transportKey("2"), keyB = transportKey("3");
	await completeCleanPromotionJob(controller, harness, {id: "fingerprint-a", key: keyA});
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	const epoch = controller.getSnapshot().tierEpoch;
	const job = {items: new Map([["fp-b", {}]]), state: "cancelled", createSummary: () => ({translated: [], skipped: [], failed: []})};
	job.historicalPerformanceToken = controller.begin(job);
	controller.captureTransportKey(job, keyB);
	assert.equal(job.historicalPrimaryConcurrency, 2);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 0);
	assert.ok(controller.getSnapshot().tierEpoch > epoch);
	controller.finish(harness.owner, job);
	await controller.stop();
});

test("S6 cache-only and local cancellation are neutral to provider promotion evidence", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	await completeCleanPromotionJob(controller, harness, {id: "neutral-seed"});
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	const cacheOnly = {configurationSignature: "fp-a", items: new Map(), state: "committed", createSummary: () => ({translated: [], skipped: [], failed: []})};
	cacheOnly.historicalPerformanceToken = controller.begin(cacheOnly);
	controller.recordAtomicCommit(cacheOnly, {committedIds: [], confirmedIds: []}, 0, false);
	controller.finish(harness.owner, cacheOnly);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	const cancelled = {configurationSignature: "fp-a", items: new Map([["cancelled", {}]]), state: "cancelled", createSummary: () => ({translated: [], skipped: [], failed: []})};
	cancelled.historicalPerformanceToken = controller.begin(cancelled);
	controller.finish(harness.owner, cancelled);
	assert.equal(controller.getSnapshot().cleanPromotionStreak, 1);
	await controller.stop();
});

test("fixed cap4 is shared globally across jobs and queues the fifth", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(4);
	const jobs = Array.from({length: 5}, (_, index) => harness.makeJob(`g${index}`));
	for (const job of jobs) job.historicalPerformanceToken = controller.begin(job);
	const runs = jobs.map(job => controller.runPrimaryBatch(harness.owner, "engine", [{message: {id: job.id}, protectedText: "x"}], job, () => {}));
	await settle(); await settle();
	assert.equal(harness.requests.length, 4);
	assert.equal(harness.getHighWater(), 4);
	harness.requests[0].deferred.resolve({translations: {g0: "ok"}, failureKind: null, statusCode: 200});
	await settle(); await settle();
	assert.equal(harness.requests.length, 5);
	for (const request of harness.requests.slice(1)) request.deferred.resolve({translations: {[request.items[0].message.id]: "ok"}, failureKind: null, statusCode: 200});
	await Promise.all(runs);
	assert.equal(harness.getActive(), 0);
	await controller.stop();
});

test("throwing observation hooks preserve provider success rejection and synchronous throw", async () => {
	let provider = () => Promise.resolve("ok");
	const plugin = {
		isHistoricalTranslationJobCurrent: () => true,
		awaitProviderBackoff: () => Promise.resolve(),
		ensureProviderClient: () => ({isBackoffActive: () => false}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		requestAiBatchTranslationDetailed: (...args) => provider(...args)
	};
	const controller = createPluginHistoricalBatchPerformance({createTrace: throwingTrace});
	const job = {items: new Map(), createSummary: () => ({translated: [], skipped: [], failed: []}), state: "committed", historicalPerformanceToken: null};
	assert.equal(controller.begin(job), null);
	assert.equal((await controller.runPrimaryBatch(plugin, "engine", [{protectedText: "text"}], job, () => {})).translations, "ok");

	const rejection = new Error("provider rejected");
	provider = () => Promise.reject(rejection);
	await assert.rejects(controller.runPrimaryBatch(plugin, "engine", [{protectedText: "text"}], job, () => {}), error => error === rejection);
	const synchronous = new Error("provider threw");
	provider = () => {throw synchronous;};
	await assert.rejects(controller.runPrimaryBatch(plugin, "engine", [{protectedText: "text"}], job, () => {}), error => error === synchronous);
	assert.equal(controller.recordAtomicCommit(job, {}, 0, false), false);
	assert.equal(controller.recordLiveTurnStarted(), 0);
	await controller.stop();
});

test("plugin-wide physical leases keep overlapping jobs and channel replacement at global two", async () => {
	const h = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	const jobs = [h.makeJob("a"), h.makeJob("b"), h.makeJob("c")];
	for (const job of jobs) job.historicalPerformanceToken = controller.begin(job);
	const runs = jobs.map(job => controller.runPrimaryBatch(h.owner, "engine", [{message: {id: job.id}, protectedText: job.id}], job, () => {}));
	await settle(); await settle();
	assert.equal(h.requests.length, 2);
	assert.equal(h.getActive(), 2);
	h.current.delete(jobs[0]);
	h.requests[0].deferred.resolve({[jobs[0].id]: "late"});
	await settle(); await settle();
	assert.equal(h.requests.length, 3, "replacement work starts only after the cancelled physical request settles");
	assert.equal(h.getHighWater(), 2);
	for (const request of h.requests.slice(1)) request.deferred.resolve(Object.fromEntries(request.items.map(item => [item.message.id, "ok"])));
	await Promise.all(runs);
	assert.equal(h.getActive(), 0);
	assert.equal(controller.getSnapshot().physical.highWater, 2);
	assert.equal(controller.getSnapshot().physical.active, 0);
	await controller.stop();
});

test("S6 repair without a provider pressure signal does not globally downshift healthy work", async () => {
	const h = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	const first = h.makeJob("p1");
	const second = h.makeJob("p2");
	const repair = h.makeJob("repair");
	for (const job of [first, second, repair]) job.historicalPerformanceToken = controller.begin(job);
	const firstRun = controller.runPrimaryBatch(h.owner, "engine", [{message: {id: "p1"}, protectedText: "p1"}], first, () => {});
	const secondRun = controller.runPrimaryBatch(h.owner, "engine", [{message: {id: "p2"}, protectedText: "p2"}], second, () => {});
	await settle(); await settle();
	assert.equal(h.requests.length, 2);
	const repairRun = controller.runRepairBatch(h.owner, repair, 2, () => h.owner.requestAiBatchTranslationDetailed("engine", [{message: {id: "repair"}, protectedText: "repair"}]));
	h.requests[0].deferred.resolve({p1: "ok"});
	await settle(); await settle();
	assert.equal(h.requests.length, 3, "repair uses the newly free slot without inventing global pressure");
	h.requests[1].deferred.resolve({p2: "ok"});
	await settle(); await settle();
	h.requests[2].deferred.resolve({repair: "ok"});
	await Promise.all([firstRun, secondRun, repairRun]);
	const snapshot = controller.getSnapshot();
	assert.equal(h.getHighWater(), 2);
	assert.equal(snapshot.physical.active, 0);
	assert.equal(snapshot.physical.capacity, 2);
	assert.equal(snapshot.pressureLocked, false);
	await controller.stop();
});

test("disabling historical safety downshift keeps the selected capacity after repair pressure", async () => {
	let safetyEnabled = false;
	const h = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance({isSafetyLimiterEnabled: () => safetyEnabled});
	controller.start();
	controller.setConcurrency(3);
	const repair = h.makeJob("repair-no-downshift");
	repair.historicalPerformanceToken = controller.begin(repair);
	const running = controller.runRepairItem(h.owner, repair, () => h.owner.requestAiBatchTranslationDetailed("engine", [{message: {id: "repair-no-downshift"}, protectedText: "repair"}]));
	await settle(); await settle();
	assert.equal(h.requests.length, 1);
	assert.equal(controller.getSnapshot().safetyLimiterEnabled, false);
	assert.equal(controller.getSnapshot().pressureLocked, false);
	assert.equal(controller.getSnapshot().physical.capacity, 3);
	h.requests[0].deferred.resolve({"repair-no-downshift": "ok"});
	await running;
	safetyEnabled = true;
	assert.equal(controller.getSnapshot().safetyLimiterEnabled, true, "the UI-backed callback is read dynamically");
	await controller.stop();
});

test("S5 historical dispatch bypasses the legacy global backoff and defers health gating to captured keys", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	let waits = 0;
	let requests = 0;
	const job = {id: "backoff", items: new Map([["m", {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
	const owner = {
		isHistoricalTranslationJobCurrent: () => true,
		awaitProviderBackoff: () => {waits++; return new Promise(() => {});},
		ensureProviderClient: () => ({isBackoffActive: () => true}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		requestAiBatchTranslationDetailed: () => {requests++; return {m: "ok"};}
	};
	job.historicalPerformanceToken = controller.begin(job);
	const running = controller.runPrimaryBatch(owner, "engine", [{message: {id: "m"}, protectedText: "m"}], job, () => {});
	await settle(); await settle();
	assert.deepEqual((await running).translations, {m: "ok"});
	assert.equal(requests, 1);
	assert.equal(waits, 0);
	assert.equal(controller.getSnapshot().physical.active, 0);
	await controller.stop();
});

test("live demand lowers refill to one and stop drains rather than forgetting two physical requests", async () => {
	const h = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	const jobs = [h.makeJob("l1"), h.makeJob("l2"), h.makeJob("l3")];
	for (const job of jobs) job.historicalPerformanceToken = controller.begin(job);
	const runs = jobs.map(job => controller.runPrimaryBatch(h.owner, "engine", [{message: {id: job.id}, protectedText: job.id}], job, () => {}));
	await settle(); await settle();
	assert.equal(h.requests.length, 2);
	controller.recordLiveDemand();
	assert.equal(controller.getSnapshot().physical.capacity, 1);
	h.requests[0].deferred.resolve({l1: "ok"});
	await settle(); await settle();
	assert.equal(h.requests.length, 2, "one sibling fills the live-pressure history cap");
	const draining = controller.stop();
	assert.equal(controller.getSnapshot().physical.stopped, true);
	assert.equal(controller.getSnapshot().physical.active, 1);
	h.requests[1].deferred.resolve({l2: "ok"});
	await draining;
	assert.equal(controller.getSnapshot().physical.active, 0);
	assert.equal(await runs[2], null, "queued replacement never reaches the provider after stop");
	await Promise.all(runs.slice(0, 2));
	assert.equal(h.requests.length, 2);
});

test("a history batch returns to configured concurrency at refill after live demand ends", async () => {
	const h = createPhysicalHarness(), controller = createPluginHistoricalBatchPerformance();
	let liveBusy = true;
	h.owner.ensureLiveTranslationQueue = () => ({getLiveSlotActiveCount: () => liveBusy ? 1 : 0, getQueueLength: () => 0, isBusyTranslating: () => false});
	controller.start();
	controller.setConcurrency(4);
	controller.recordLiveDemand();
	const job = h.makeJob("live-refill"), prepared = Array.from({length: 50}, (_, index) => ({message: {id: `refill-${index}`}, protectedText: "hello"}));
	job.historicalPerformanceToken = controller.begin(job);
	const running = controller.runPrimaryBatch(h.owner, "engine", prepared, job, () => {});
	const complete = request => request.deferred.resolve({translations: Object.fromEntries(request.items.map(item => [item.message.id, "ok"])), failureKind: null, statusCode: 200});
	await settle(); await settle();
	assert.equal(h.requests.length, 1);
	assert.equal(controller.getSnapshot().physical.capacity, 1);
	liveBusy = false;
	complete(h.requests[0]);
	await settle(); await settle();
	assert.equal(h.requests.length, 5);
	assert.equal(h.getActive(), 4, "remaining chunks refill all configured slots without restarting the job");
	assert.equal(controller.getSnapshot().physical.capacity, 4);
	for (const request of h.requests.slice(1)) complete(request);
	const result = await running;
	assert.equal(Object.keys(result.translations).length, 50);
	await controller.stop();
});

test("a one-chunk transient or malformed response locks the session back to cap one", async () => {
	for (const failureKind of ["transient", "malformed"]) {
		const controller = createPluginHistoricalBatchPerformance();
		controller.start();
		controller.setConcurrency(2);
		const job = {id: failureKind, items: new Map([[failureKind, {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
		job.historicalPerformanceToken = controller.begin(job);
		controller.captureTransportKey(job, transportKey(failureKind === "transient" ? "4" : "5"));
		const owner = {
			isHistoricalTranslationJobCurrent: candidate => candidate === job,
			awaitProviderBackoff: () => Promise.resolve(),
			ensureProviderClient: () => ({isBackoffActive: () => false}),
			ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
			requestAiBatchTranslationDetailed: () => Promise.resolve({translations: null, failureKind, statusCode: failureKind === "transient" ? 429 : 200})
		};

		const outcome = await controller.runPrimaryBatch(owner, "engine", [{message: {id: failureKind}, protectedText: "x"}], job, () => {});
		assert.equal(outcome.failureKind, failureKind);
		assert.equal(controller.getSnapshot().pressureLocked, true, `${failureKind} must lock even when provider-bound count is <= 10`);
		assert.equal(controller.getSnapshot().physical.capacity, 1);
		const future = {items: new Map([["future", {}]])};
		controller.begin(future);
		assert.equal(future.historicalPrimaryConcurrency, 1, "provider pressure locks future jobs to one for the session");
		await controller.stop();
	}
});

test("a terminal chunk cancels a sibling still waiting for a physical lease", async () => {
	const h = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	const blocker = h.makeJob("blocker");
	const main = h.makeJob("main");
	for (const job of [blocker, main]) job.historicalPerformanceToken = controller.begin(job);
	const items = (prefix, count) => Array.from({length: count}, (_, index) => ({message: {id: `${prefix}-${index}`}, protectedText: "x"}));
	const translationMap = request => Object.fromEntries(request.items.map(item => [item.message.id, "ok"]));

	const blockerRun = controller.runPrimaryBatch(h.owner, "engine", items("blocker", 1), blocker, () => {});
	await settle();
	const mainRun = controller.runPrimaryBatch(h.owner, "engine", items("main", 30), main, () => {});
	await settle(); await settle();
	assert.deepEqual(h.requests.map(request => request.items[0].message.id), ["blocker-0", "main-0"]);

	h.requests[1].deferred.resolve(translationMap(h.requests[1]));
	await settle(); await settle();
	assert.deepEqual(h.requests.map(request => request.items[0].message.id), ["blocker-0", "main-0", "main-10"], "only one post-probe sibling owns the free physical slot");

	h.requests[2].deferred.resolve({translations: null, failureKind: "auth", statusCode: 401});
	const mainOutcome = await mainRun;
	await settle(); await settle();
	assert.deepEqual(mainOutcome, {translations: null, failureKind: "auth", statusCode: 401});
	assert.deepEqual(h.requests.map(request => request.items[0].message.id), ["blocker-0", "main-0", "main-10"], "main-20 was only logically queued and must never reach the provider after terminal failure");

	h.requests[0].deferred.resolve(translationMap(h.requests[0]));
	await blockerRun;
	await controller.stop();
});

test("the final dispatch fence yields an already-granted second lease to live demand", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	const firstGate = createDeferred();
	const jobs = new Set();
	const calls = [];
	let liveBusy = false;
	let injectLiveDemand = false;
	const liveQueue = {getLiveSlotActiveCount: () => 0, getQueueLength: () => liveBusy ? 1 : 0, isBusyTranslating: () => false};
	const owner = {
		isHistoricalTranslationJobCurrent: job => jobs.has(job),
		awaitProviderBackoff: () => Promise.resolve(),
		ensureLiveTranslationQueue: () => liveQueue,
		ensureProviderClient: () => ({isBackoffActive: () => {
			if (injectLiveDemand) {
				injectLiveDemand = false;
				queueMicrotask(() => {liveBusy = true; controller.recordLiveDemand();});
			}
			return false;
		}}),
		requestAiBatchTranslationDetailed: (_engineKey, items) => {
			calls.push({id: items[0].message.id, liveBusyAtDispatch: liveBusy});
			if (calls.length === 1) return firstGate.promise;
			return Promise.resolve({translations: {[items[0].message.id]: "ok"}, failureKind: null, statusCode: 200});
		}
	};
	const makeJob = id => {
		const job = {id, items: new Map([[id, {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
		jobs.add(job);
		job.historicalPerformanceToken = controller.begin(job);
		return job;
	};
	const first = makeJob("first");
	const second = makeJob("second");
	const firstRun = controller.runPrimaryBatch(owner, "engine", [{message: {id: "first"}, protectedText: "x"}], first, () => {});
	await settle();
	injectLiveDemand = true;
	const secondRun = controller.runPrimaryBatch(owner, "engine", [{message: {id: "second"}, protectedText: "x"}], second, () => {});
	await settle(); await settle();
	assert.deepEqual(calls, [{id: "first", liveBusyAtDispatch: false}], "the granted speculative lease yields before a physical dispatch under live demand");

	liveBusy = false;
	firstGate.resolve({translations: {first: "ok"}, failureKind: null, statusCode: 200});
	await Promise.all([firstRun, secondRun]);
	assert.deepEqual(calls, [{id: "first", liveBusyAtDispatch: false}, {id: "second", liveBusyAtDispatch: false}]);
	await controller.stop();
});

test("S5 final dispatch fence does not re-enter the legacy global backoff bucket", async () => {
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	let waits = 0;
	let backoffActive = false;
	let injectBackoff = true;
	let requests = 0;
	const job = {id: "late-backoff", items: new Map([["late-backoff", {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
	job.historicalPerformanceToken = controller.begin(job);
	const owner = {
		isHistoricalTranslationJobCurrent: candidate => candidate === job,
		awaitProviderBackoff: () => {waits++; return new Promise(() => {});},
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		ensureProviderClient: () => ({isBackoffActive: () => {
			if (injectBackoff) {
				injectBackoff = false;
				queueMicrotask(() => {backoffActive = true;});
			}
			return backoffActive;
		}}),
		requestAiBatchTranslationDetailed: () => {
			requests++;
			return Promise.resolve({translations: {"late-backoff": "ok"}, failureKind: null, statusCode: 200});
		}
	};

	const running = controller.runPrimaryBatch(owner, "engine", [{message: {id: "late-backoff"}, protectedText: "x"}], job, () => {});
	await settle(); await settle();
	assert.equal((await running).translations["late-backoff"], "ok");
	assert.equal(requests, 1);
	assert.equal(waits, 0);
	assert.equal(controller.getSnapshot().pressureLocked, false);
	await controller.stop();
});

test("H1 production wiring closes one primary lineage without changing request items or order", async () => {
	let requestId = 0;
	const calls = [];
	const current = new Set();
	const client = {
		isBackoffActive: () => false,
		beginLatencyRequest: options => Object.freeze({requestId: ++requestId, generation: 0, kind: options.kind, messageCount: options.messageCount, inputChars: options.inputChars, queueWaitMs: null})
	};
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		awaitProviderBackoff: () => Promise.resolve(),
		ensureProviderClient: () => client,
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		requestAiBatchTranslationDetailed: (_engineKey, items, timingContext) => {
			calls.push(items.map(item => item.message.id));
			assert.ok(timingContext && timingContext.historicalAttemptFactory, "the real provider seam receives H1 observation");
			assert.equal(typeof timingContext.leaseWaitMs, "number");
			assert.equal(timingContext.leaseWaitMs >= 0, true);
			const observer = timingContext.historicalAttemptFactory(timingContext.role);
			observer.onRequest({transportKey: "tk1:fixture", workloadKey: "wk1:fixture", bodyBytes: 50, promptChars: 30, inputChars: 20, headers: null, ttftMs: null, physicalAbort: null});
			observer.onSettle({providerRequestId: timingContext.token.requestId, providerAttempt: 1, status: "ok", httpStatus: 200, outputChars: 4, usage: null, finishReason: null});
			return Promise.resolve({translations: Object.fromEntries(items.map(item => [item.message.id, "ok"])), failureKind: null, statusCode: 200});
		}
	};
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	const job = {id: "raw-private-job", sealedAt: 10, items: new Map([["a", {}], ["b", {}]]), state: "translating", createSummary: () => ({translated: [{}, {}], skipped: [], failed: []})};
	current.add(job);
	job.historicalPerformanceToken = controller.begin(job);
	const prepared = [{message: {id: "a"}, protectedText: "one"}, {message: {id: "b"}, protectedText: "two"}];
	const outcome = await controller.runPrimaryBatch(owner, "engine-a", prepared, job, () => {});
	assert.deepEqual(outcome.translations, {a: "ok", b: "ok"});
	assert.deepEqual(calls, [["a", "b"]]);
	controller.recordCache(job, {miss: 2});
	controller.recordParseValidate(job, {parsed: 2, valid: 2});
	controller.recordAtomicCommit(job, {committedIds: ["a", "b"], confirmedIds: ["a", "b"]}, 2, false);
	controller.recordDomConfirm(job, {confirmedCount: 2});
	job.state = "committed";
	controller.finish(owner, job);
	const h1 = controller.getSnapshot().latestRun.h1;
	assert.equal(h1.conservation.passed, true);
	assert.equal(h1.conservation.logicalCount, 1);
	assert.equal(h1.conservation.attemptCount, 1);
	assert.equal(h1.cache.miss, 2);
	assert.equal(h1.parseCount, 2);
	assert.equal(h1.domConfirmedCount, 2);
	assert.equal(h1.probeBarrierCount, 0);
	assert.equal(h1.probeBarrierSettledCount, 0);
	assert.equal(h1.primaryWaveCount, 1);
	assert.equal(JSON.stringify(h1).includes("raw-private-job"), false);
	current.delete(job);
	await controller.stop();
});

test("W0 historical item repair receives one latency token, repair role and lease wait", async () => {
	let requestId = 0;
	const current = new Set();
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		ensureProviderClient: () => ({isBackoffActive: () => false, beginLatencyRequest: options => Object.freeze({requestId: ++requestId, generation: 0, kind: options.kind, lane: options.lane, messageCount: options.messageCount, inputChars: options.inputChars, queueWaitMs: null})}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false})
	};
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	const job = {id: "w0-item-repair", state: "translating", items: new Map(), createSummary: () => ({translated: [], skipped: [], failed: []})};
	current.add(job);
	job.historicalPerformanceToken = controller.begin(job);
	await controller.runRepairItem(owner, job, traceContext => {
		const timing = traceContext.createTimingContext({role: "retry", engineKey: "oaicompat", messageCount: 1, historicalBatch: false});
		assert.ok(timing.token);
		assert.equal(timing.token.lane, "item-repair");
		assert.equal(timing.observationRole, "repair");
		assert.equal(typeof timing.leaseWaitMs, "number");
		return Promise.resolve({status: "translated"});
	});
	current.delete(job);
	await controller.stop();
});

test("S7 early captured Transport Key launches Auto new-key cap2 and restores learned cap4 without a settle barrier", async () => {
	const harness = createPhysicalHarness();
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	const learnedKey = transportKey("s7-learned"), freshKey = transportKey("s7-fresh");
	for (const id of ["learn-2a", "learn-2b", "learn-3a", "learn-3b"]) await completeCleanPromotionJob(controller, harness, {id, key: learnedKey});
	assert.equal(controller.getSnapshot().learnedTier, 4);

	const runWave = async (id, key, expectedFirstWave) => {
		const current = new Set();
		const requests = [];
		const job = {id, items: new Map(Array.from({length: 50}, (_, index) => [`${id}-${index}`, {}])), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
		current.add(job);
		const owner = {
			isHistoricalTranslationJobCurrent: candidate => current.has(candidate),
			ensureProviderClient: () => ({isBackoffActive: () => false, beginLatencyRequest: () => null}),
			ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
			requestAiBatchTranslationDetailed(_engine, items, timingContext) {
				timingContext.historicalContractObserver({transportKey: key});
				const deferred = createDeferred();
				requests.push({items, deferred, settled: false});
				return deferred.promise;
			}
		};
		job.historicalPerformanceToken = controller.begin(job);
		const prepared = Array.from({length: 50}, (_, index) => ({message: {id: `${id}-${index}`}, protectedText: "x"}));
		let finished = false;
		const running = controller.runPrimaryBatch(owner, "engine", prepared, job, () => {}).finally(() => {finished = true;});
		await settle(); await settle();
		assert.equal(requests.length, expectedFirstWave);
		while (!finished) {
			for (const request of requests.filter(request => !request.settled)) {request.settled = true; request.deferred.resolve({translations: Object.fromEntries(request.items.map(item => [item.message.id, "ok"])), failureKind: null, statusCode: 200});}
			await settle(); await settle();
		}
		await running;
		assert.equal(requests.length, 5);
		current.delete(job);
	};

	await runWave("fresh", freshKey, 2);
	await runWave("learned", learnedKey, 4);
	await controller.stop();
});

test("S3H production timing context acquires and releases the captured-key logical budget", async () => {
	let requestId = 0;
	const current = new Set();
	const client = {isBackoffActive: () => false, beginLatencyRequest: options => Object.freeze({requestId: ++requestId, generation: 0, kind: options.kind, messageCount: options.messageCount, inputChars: options.inputChars, queueWaitMs: null})};
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		awaitProviderBackoff: () => Promise.resolve(),
		ensureProviderClient: () => client,
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		async requestAiBatchTranslationDetailed(_engineKey, items, timingContext) {
			assert.ok(timingContext.historicalAdmission);
			const lease = await timingContext.historicalAdmission.acquireAttempt({transportKey: "tk1:captured", workloadKey: "wk1:captured", role: "primary", itemCount: items.length, protectedChars: 10, bodyBytes: 100, estimatedTokens: 25});
			assert.equal(lease.granted, true);
			const observer = timingContext.historicalAttemptFactory("primary");
			observer.onRequest({transportKey: "tk1:captured", workloadKey: "wk1:captured", bodyBytes: 100, promptChars: 50, inputChars: 10});
			observer.onSettle({providerRequestId: timingContext.token.requestId, providerAttempt: 1, status: "ok", httpStatus: 200});
			assert.equal(timingContext.historicalAdmission.releaseAttempt(lease), true);
			return {translations: Object.fromEntries(items.map(item => [item.message.id, "ok"])), failureKind: null, statusCode: 200};
		}
	};
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	controller.setConcurrency(2);
	const job = {id: "s3h-job", sealedAt: 1, items: new Map([["m1", {}]]), state: "translating", createSummary: () => ({translated: [{}], skipped: [], failed: []})};
	current.add(job);
	job.historicalPerformanceToken = controller.begin(job);
	await controller.runPrimaryBatch(owner, "engine", [{message: {id: "m1"}, protectedText: "fixture"}], job, () => {});
	controller.recordAtomicCommit(job, {committedIds: ["m1"], confirmedIds: ["m1"]}, 1, false);
	job.state = "committed";
	controller.finish(owner, job);
	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.providerBudget.grantedAttemptCount, 1);
	assert.equal(snapshot.providerBudget.settledAttemptCount, 1);
	assert.equal(snapshot.providerBudget.roleGrants.primary, 1);
	assert.equal(snapshot.providerBudget.logicalOnlyBeforeS4, true);
	assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	current.delete(job);
	await controller.stop();
});

test("S4 job invalidation synchronously aborts its historical requestContext signal", async () => {
	const current = new Set();
	let capturedContext = null;
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		awaitProviderBackoff: () => Promise.resolve(),
		ensureProviderClient: () => ({isBackoffActive: () => false, beginLatencyRequest: () => Object.freeze({requestId: 1, generation: 0, kind: "historical", messageCount: 1, inputChars: 7, queueWaitMs: null})}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		requestAiBatchTranslationDetailed(_engineKey, _items, timingContext) {
			capturedContext = timingContext.requestContext;
			return new Promise(resolve => capturedContext.signal.addEventListener("abort", () => resolve({translations: null, failureKind: "transient", statusCode: null}), {once: true}));
		}
	};
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	const job = {id: "s4-abort", items: new Map([["m1", {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: [{}]})};
	current.add(job);
	job.historicalPerformanceToken = controller.begin(job);
	const running = controller.runPrimaryBatch(owner, "oaicompat", [{message: {id: "m1"}, protectedText: "fixture"}], job, () => {});
	await settle(); await settle();
	assert.ok(capturedContext && capturedContext.signal);
	assert.equal(capturedContext.signal.aborted, false);
	assert.equal(controller.getSnapshot().historicalAbortControllerCount, 1);
	assert.equal(controller.abortJobAttempts(job, "source-edited"), 1);
	assert.equal(capturedContext.signal.aborted, true);
	await running;
	assert.equal(controller.getSnapshot().historicalAbortControllerCount, 0);
	current.delete(job);
	await controller.stop();
});

test("S4 controller stop synchronously aborts every historical signal and drains all leases", async () => {
	const current = new Set();
	let capturedContext = null;
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		awaitProviderBackoff: () => Promise.resolve(),
		ensureProviderClient: () => ({isBackoffActive: () => false, beginLatencyRequest: () => Object.freeze({requestId: 1, generation: 0, kind: "historical", messageCount: 1, inputChars: 7, queueWaitMs: null})}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false}),
		requestAiBatchTranslationDetailed(_engineKey, _items, timingContext) {
			capturedContext = timingContext.requestContext;
			return new Promise(resolve => capturedContext.signal.addEventListener("abort", () => resolve({translations: null, failureKind: "transient", statusCode: null}), {once: true}));
		}
	};
	const controller = createPluginHistoricalBatchPerformance();
	controller.start();
	const job = {id: "s4-stop", items: new Map([["m1", {}]]), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: [{}]})};
	current.add(job);
	job.historicalPerformanceToken = controller.begin(job);
	const running = controller.runPrimaryBatch(owner, "oaicompat", [{message: {id: "m1"}, protectedText: "fixture"}], job, () => {});
	await settle(); await settle();
	const draining = controller.stop();
	assert.equal(capturedContext.signal.aborted, true);
	await running;
	await draining;
	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.historicalAbortControllerCount, 0);
	assert.equal(snapshot.physical.active, 0);
	assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	current.delete(job);
});

test("historical sample observer retains primary fields across real wiring fallback context copies", async () => {
 let saved;const controller=createPluginHistoricalBatchPerformance({savePrimarySamples:value=>{saved=structuredClone(value);}}),h=createPhysicalHarness();controller.start();const job=h.makeJob("sample-fallback");job.historicalPerformanceToken=controller.begin(job);
 h.owner.requestAiBatchTranslationDetailed=async (_engine,items,timingContext)=>{
  const observer=timingContext.historicalSampleObserver;
  // Production onContract has no attempt ID; onSettle carries both IDs, or null.
  observer.onContract({transportKey:"tk1:primary",workloadKey:"wk1:primary"},{bodyBytes:900,promptChars:700,inputChars:100});
  observer.onSettle(Object.freeze({providerRequestId:29,providerAttempt:1,status:"ok",httpStatus:200,errorClass:null,outputChars:15,usage:{promptTokens:100,completionTokens:8,reasoningTokens:null},finishReason:"stop",durationMs:1200,headers:null,ttftMs:null,physicalAbort:false}));
  const fallbackTiming=Object.assign({},timingContext,{role:"fallback",observationRole:"fallback"});assert.equal(fallbackTiming.historicalSampleObserver,observer);
  fallbackTiming.historicalSampleObserver.onContract({transportKey:"tk1:fallback",workloadKey:"wk1:fallback"},{bodyBytes:450,promptChars:300,inputChars:90});
  fallbackTiming.historicalSampleObserver.onSettle(Object.freeze({providerRequestId:29,providerAttempt:2,status:"ok",httpStatus:200,errorClass:null,outputChars:42,usage:{promptTokens:50,completionTokens:12,reasoningTokens:null},finishReason:"stop",durationMs:4980,headers:null,ttftMs:null,physicalAbort:false}));
  return {translations:Object.fromEntries(items.map(item=>[item.message.id,"ok"])),failureKind:null,statusCode:200};
 };
 try {await controller.runPrimaryBatch(h.owner,"engine",[{message:{id:"m"},protectedText:"source text"}],job,()=>{});controller.flushPrimarySamples();const sample=saved.samples[0];assert.equal(sample.transportKey,"tk1:primary");assert.equal(sample.workloadKey,"wk1:primary");assert.equal(sample.bodyBytes,900);assert.equal(sample.durationMs,1200);assert.equal(sample.usage.promptTokens,100);assert.deepEqual(sample.transportAttempts,{requestCount:2,measuredDurationCount:2,unknownDurationCount:0,durationMs:6180});assert.equal(sample.trainingEligible,false,"logical success after fallback is not a clean primary training sample");}finally {await controller.stop();}
});
test("historical performance wiring forwards optional primary outcomes for AI and classic lanes", async () => {
	for (const lane of ["ai", "classic"]) {
		const h = createPhysicalHarness(), controller = createPluginHistoricalBatchPerformance();
		controller.start(); controller.setConcurrency(4);
		const job = h.makeJob(`outcome-${lane}`);
		job.historicalPerformanceToken = controller.begin(job);
		const prepared = Array.from({length: lane === "ai" ? 12 : 2}, (_, index) => ({message: {id: `m${index}`}, protectedText: `text-${index}`}));
		const events = [], progress = [];
		const running = lane === "ai"
			? controller.runPrimaryBatch(h.owner, "engine", prepared, job, event => progress.push(event), event => events.push(event))
			: controller.runClassicPrimaryItems(h.owner, "engine", prepared, job, item => h.owner.requestAiBatchTranslationDetailed("engine", [item]), event => progress.push(event), event => events.push(event));
		await settle(); await settle();
		assert.equal(h.requests.length, 2);
		h.requests[0].deferred.resolve(Object.fromEntries(h.requests[0].items.map(item => [item.message.id, "fast"])));
		await settle(); await settle();
		assert.equal(events.length, 1, `${lane} exposes its fast physical chunk before its sibling`);
		assert.equal(events[0].isCurrent(), true);
		h.requests[1].deferred.resolve(Object.fromEntries(h.requests[1].items.map(item => [item.message.id, "slow"])));
		await running;
		assert.equal(events.length, 2);
		assert.deepEqual(events.flatMap(event => event.preparedItems.map(item => item.message.id)), prepared.map(item => item.message.id));
		assert.equal(progress.length, 2);
		h.current.delete(job);
		assert.equal(events[0].isCurrent(), false);
		await controller.stop();
	}
});
test("clean incremental commits promote but duplicate result counts do not", async () => {
	for (const duplicate of [false, true]) {
		const h = createPhysicalHarness(), controller = createPluginHistoricalBatchPerformance();
		controller.start();
		for (let round = 0; round < 2; round++) {
			const result = await completeCleanPromotionJob(controller, h, {id: `incremental-${duplicate}-${round}`, commit: (job, ids) => {
				for (let index = 0; index < ids.length; index += 10) {
					const chunk = ids.slice(index, index + 10);
					controller.recordAtomicCommit(job, {committedIds: chunk, confirmedIds: chunk}, chunk.length, false);
				}
				if (duplicate) controller.recordAtomicCommit(job, {committedIds: ids.slice(0, 10), confirmedIds: ids.slice(0, 10)}, 10, false);
			}});
			assert.equal(result.completed.atomicCommitCount, duplicate ? 4 : 3);
			assert.equal(result.completed.commitResultCount, duplicate ? 40 : 30);
			if (round === 0) assert.equal(controller.getSnapshot().cleanPromotionStreak, duplicate ? 0 : 1);
		}
		assert.equal(controller.getSnapshot().configuredConcurrency, duplicate ? 2 : 3);
		await controller.stop();
	}
});
