const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// A saved baseline can replay all three owners together while keeping ordinary imports local.
function loadModule(relativePath, overridePath) {
	const filename = path.resolve(__dirname, relativePath);
	if (!overridePath) return require(filename);
	const loaded = new Module(filename, module);
	loaded.filename = filename;
	loaded.paths = Module._nodeModulePaths(path.dirname(filename));
	loaded._compile(fs.readFileSync(overridePath, "utf8"), filename);
	return loaded.exports;
}
const {createPluginHistoricalBatchPerformance} = loadModule("../../src/diagnostics/historical-batch-performance-wiring.js", process.env.DTA_WIRING_PATH);
const {createHistoricalProviderBudgetOwner} = loadModule("../../src/orchestrator/historical-provider-budget-owner.js", process.env.DTA_OWNER_PATH);
const {createHistoricalAdaptiveTierOwner} = loadModule("../../src/orchestrator/historical-adaptive-tier-owner.js", process.env.DTA_ADAPTIVE_PATH);

const key = name => "tk1:" + name;
const good = {statusCode: 200};
const auth = {statusCode: 401, errorClass: "auth"};

function prepared(id, retryKeys = []) {
	return {message: {id}, protectedText: "text-" + id, queueItem: {message: {id}, retryFailed: retryKeys.length > 0, historicalRetryTransportKeys: retryKeys.slice()}};
}

function createHarness(t, mode = "auto") {
	let clock = 1000;
	let budget, adaptive;
	const current = new Set();
	const outstanding = new Set();
	const controller = createPluginHistoricalBatchPerformance({
		now: () => clock,
		createAdaptiveTierOwner: options => (adaptive = createHistoricalAdaptiveTierOwner(options)),
		createProviderBudgetOwner: options => {
			budget = createHistoricalProviderBudgetOwner(options);
			return Object.freeze(Object.assign({}, budget, {
				acquireAttempt: (logical, meta) => budget.acquireAttempt(logical, meta).then(lease => {
					if (lease.granted) outstanding.add(lease);
					return lease;
				}),
				releaseAttempt: (lease, outcome) => {outstanding.delete(lease); return budget.releaseAttempt(lease, outcome);}
			}));
		}
	});
	controller.start();
	controller.setConcurrency(mode);
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		ensureProviderClient: () => ({isBackoffActive: () => false, beginLatencyRequest: () => null}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false})
	};
	t.after(async () => {
		current.clear();
		// A failed assertion must not strand the real owner's drain promise.
		for (const lease of outstanding) budget.releaseAttempt(lease, {physicalAbort: true});
		await controller.stop();
		assert.deepEqual(budget.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
		assert.deepEqual(adaptive.getSnapshot().resources, {keys: 0, observations: 0});
	});
	const makeJob = (id, items) => {
		const job = {id, items: new Map(items.map(item => [item.message.id, item.queueItem])), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
		current.add(job);
		job.historicalPerformanceToken = controller.begin(job);
		return job;
	};
	const seedBlocked = async transportKey => {
		const logical = budget.beginLogical();
		const lease = await budget.acquireAttempt(logical, {transportKey});
		assert.equal(lease.granted, true);
		budget.releaseAttempt(lease, auth);
		budget.finishLogical(logical);
		assert.equal(adaptive.recordPressure(adaptive.capture(transportKey), {reason: "auth", permanent: true}), true);
	};
	return {controller, owner, current, budget, adaptive, makeJob, seedBlocked, advance: ms => {clock += ms;}};
}

async function acquire(timing, transportKey, role = "primary") {
	if (role === "primary") timing.historicalContractObserver({transportKey});
	return timing.historicalAdmission.acquireAttempt({transportKey, role, itemCount: 1, protectedChars: 8, bodyBytes: 80, estimatedTokens: 20});
}

async function run(h, route, job, items, request) {
	if (route === "primary") {
		h.owner.requestAiBatchTranslationDetailed = async (_engine, chunk, timing) => {
			await request(timing);
			return {translations: Object.fromEntries(chunk.map(item => [item.message.id, "translated"])), failureKind: null, statusCode: 200};
		};
		return h.controller.runPrimaryBatch(h.owner, "fixture-engine", items, job, () => {});
	}
	if (route === "batch-repair") return h.controller.runRepairBatch(h.owner, job, items.length, request, "fixture-engine", items);
	return h.controller.runRepairItem(h.owner, job, context => request(context.createTimingContext({role: "retry"})), items[0]);
}

for (const route of ["primary", "batch-repair", "item-repair"]) test(route + " current 2xx recovers its blocked key without adding clean-run evidence", async t => {
	const h = createHarness(t);
	const transportKey = key(route);
	await h.seedBlocked(transportKey);
	const items = [prepared(route, [transportKey])];
	const job = h.makeJob(route, items);
	await run(h, route, job, items, async timing => {
		const lease = await acquire(timing, transportKey, route === "primary" ? "primary" : "repair");
		assert.equal(lease.granted, true);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1, "admission permission is not recovery evidence");
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, good), true);
		const snapshot = h.adaptive.getSnapshot(transportKey);
		assert.equal(snapshot.effectiveCap, 2, "the real successful probe releases permanent adaptive pressure");
		assert.equal(snapshot.learnedTier, 2);
		assert.equal(snapshot.promotionEvidence, 0, "transport health is not a clean whole-job sample");
		assert.equal(h.budget.getSnapshot().recoveryKeyCount, 0);
	});
});

test("backup recovery is applied to lease key B, not the job's blocked primary key A", async t => {
	const h = createHarness(t, 4);
	const a = key("primary-a"), b = key("backup-b");
	await h.seedBlocked(a);
	await h.seedBlocked(b);
	const items = [prepared("backup", [b])];
	const job = h.makeJob("backup", items);
	h.controller.captureTransportKey(job, a);
	await run(h, "batch-repair", job, items, async timing => {
		const lease = await acquire(timing, b, "backup");
		assert.equal(lease.granted, true);
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, good), true);
		assert.equal(job.historicalTransportKey, a);
		assert.equal(h.adaptive.getSnapshot(a).effectiveCap, 1);
		assert.equal(h.adaptive.getSnapshot(a).effectiveReason, "auth");
		assert.equal(h.adaptive.getSnapshot(b).effectiveCap, 2);
		assert.equal(h.adaptive.getSnapshot(b).selectedCap, 4);
		assert.equal(h.adaptive.getSnapshot(b).promotionEvidence, 0);
	});
});

for (const [name, outcome] of [
	["failureKind", {statusCode: 200, failureKind: "malformed"}],
	["errorClass", {statusCode: 200, errorClass: "parse"}],
	["error", {statusCode: 200, error: new Error("fixture transport error")}],
	["timeout", {statusCode: 200, timedOut: true}],
	["physical abort", {statusCode: 200, physicalAbort: true}],
	["cancelled before dispatch", {statusCode: 200, cancelledBeforeDispatch: true}],
	["non-success status", {statusCode: 302}]
]) test(name + " outcome does not turn a granted retry into adaptive recovery", async t => {
	const h = createHarness(t);
	const transportKey = key("failed-proof");
	await h.seedBlocked(transportKey);
	const items = [prepared(name, [transportKey])];
	const job = h.makeJob(name, items);
	await run(h, "item-repair", job, items, async timing => {
		const lease = await acquire(timing, transportKey, "repair");
		assert.equal(lease.granted, true);
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, outcome), true);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
		assert.equal(h.adaptive.getSnapshot(transportKey).promotionEvidence, 0);
	});
});

for (const invalidation of ["job stale", "aborted", "mode changed", "new pressure epoch"]) test(invalidation + " invalidates an in-flight recovery proof before 2xx release", async t => {
	const h = createHarness(t);
	const transportKey = key("invalidated-proof");
	await h.seedBlocked(transportKey);
	const items = [prepared(invalidation, [transportKey])];
	const job = h.makeJob(invalidation, items);
	await run(h, "item-repair", job, items, async timing => {
		const lease = await acquire(timing, transportKey, "repair");
		assert.equal(lease.granted, true);
		if (invalidation === "job stale") h.current.delete(job);
		if (invalidation === "aborted") assert.equal(h.controller.abortJobAttempts(job), 1);
		if (invalidation === "mode changed") h.controller.setConcurrency(4);
		if (invalidation === "new pressure epoch") h.adaptive.recordPressure(h.adaptive.capture(transportKey), {reason: "schema", permanent: true});
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, good), true, "a stale proof still drains its actual lease");
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
		assert.equal(h.adaptive.getSnapshot(transportKey).promotionEvidence, 0);
	});
});

test("finished logical context drains a late 2xx without clearing adaptive pressure", async t => {
	const h = createHarness(t);
	const transportKey = key("finished-proof");
	await h.seedBlocked(transportKey);
	const items = [prepared("finished", [transportKey])];
	const job = h.makeJob("finished", items);
	let savedTiming, lease;
	await run(h, "item-repair", job, items, async timing => {
		savedTiming = timing;
		lease = await acquire(timing, transportKey, "repair");
		assert.equal(lease.granted, true);
	});
	assert.equal(savedTiming.historicalAdmission.isCurrent(), false);
	assert.equal(h.adaptive.getSnapshot(transportKey).resources.observations, 0, "logical finish retires its pending recovery observation");
	assert.equal(savedTiming.historicalAdmission.releaseAttempt(lease, good), true);
	assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
	assert.equal(h.adaptive.getSnapshot(transportKey).promotionEvidence, 0);
});

test("duplicate release cannot reuse a successful proof to clear a later failure", async t => {
	const h = createHarness(t);
	const transportKey = key("duplicate-proof");
	await h.seedBlocked(transportKey);
	const items = [prepared("duplicate", [transportKey])];
	const job = h.makeJob("duplicate", items);
	await run(h, "item-repair", job, items, async timing => {
		const lease = await acquire(timing, transportKey, "repair");
		assert.equal(lease.granted, true);
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, good), true);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 2);
		h.adaptive.recordPressure(h.adaptive.capture(transportKey), {reason: "auth", permanent: true});
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, good), false);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
		assert.equal(h.budget.getSnapshot().settledAttemptCount, 2, "seed failure plus one real release only");
	});
});

test("429 then auth then older concurrent 2xx preserves the rate window and blocked adaptive state", async t => {
	const h = createHarness(t, 4);
	const transportKey = key("concurrent-rate-window");
	const items = [prepared("rate-window")];
	const job = h.makeJob("rate-window", items);
	await run(h, "item-repair", job, items, async timing => {
		const limited = await acquire(timing, transportKey, "repair");
		const unauthorized = await acquire(timing, transportKey, "repair");
		const oldSuccess = await acquire(timing, transportKey, "repair");
		assert.equal(limited.granted && unauthorized.granted && oldSuccess.granted, true);
		assert.equal(timing.historicalAdmission.releaseAttempt(limited, {statusCode: 429, retryAfterMs: 9000}), true);
		assert.equal(timing.historicalAdmission.releaseAttempt(unauthorized, auth), true);
		assert.equal(timing.historicalAdmission.releaseAttempt(oldSuccess, good), true);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveReason, "auth");
	});
	const untouchedLogical = h.budget.beginLogical();
	const untouched = await h.budget.acquireAttempt(untouchedLogical, {transportKey});
	assert.equal(untouched.granted, false);
	assert.equal(untouched.reason, "provider_unhealthy");
	assert.equal(untouched.retryAfterMs, 15000, "the older success does not shorten the newer auth cooldown");
	h.budget.finishLogical(untouchedLogical);
	const logical = h.budget.beginLogical();
	const denied = await h.budget.acquireAttempt(logical, {transportKey, probeHealth: true});
	assert.equal(denied.granted, false);
	assert.equal(denied.reason, "provider_unhealthy");
	assert.equal(denied.retryAfterMs, 9000, "an explicit probe keeps the independent Retry-After deadline");
	h.budget.finishLogical(logical);
	h.advance(1000);
	const laterLogical = h.budget.beginLogical();
	const later = await h.budget.acquireAttempt(laterLogical, {transportKey});
	assert.equal(later.granted, false);
	assert.equal(later.retryAfterMs, 8000);
	h.budget.finishLogical(laterLogical);
	assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1, "elapsed time is not proof of configuration recovery");
});

test("denied recovery admission leaves no per-attempt adaptive observations", async t => {
	const h = createHarness(t);
	const transportKey = key("denied-proof");
	await h.seedBlocked(transportKey);
	const items = [prepared("denied")];
	const job = h.makeJob("denied", items);
	await run(h, "item-repair", job, items, async timing => {
		const before = h.adaptive.getSnapshot(transportKey).resources.observations;
		const lease = await acquire(timing, transportKey, "repair");
		assert.equal(lease.granted, false);
		assert.equal(lease.reason, "provider_unhealthy");
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
		assert.equal(h.adaptive.getSnapshot(transportKey).resources.observations, before);
	});
});

test("the next primary dispatch uses recovered key capacity two without raising a fixed selection of four", async t => {
	const h = createHarness(t, 4);
	const transportKey = key("recovered-dispatch-cap");
	await h.seedBlocked(transportKey);
	const retryItems = [prepared("capacity-retry", [transportKey])];
	const retryJob = h.makeJob("capacity-retry", retryItems);
	await run(h, "item-repair", retryJob, retryItems, async timing => {
		const lease = await acquire(timing, transportKey, "repair");
		assert.equal(lease.granted, true);
		assert.equal(timing.historicalAdmission.releaseAttempt(lease, good), true);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 2);
		assert.equal(h.adaptive.getSnapshot(transportKey).selectedCap, 4);
	});
	const nextItems = [prepared("capacity-next")];
	const nextJob = h.makeJob("capacity-next", nextItems);
	await run(h, "primary", nextJob, nextItems, async timing => {
		const first = await acquire(timing, transportKey);
		const secondPromise = acquire(timing, transportKey);
		try {
			assert.equal(first.granted, true);
			assert.equal(h.budget.getSnapshot().activeAttemptCount, 2, "the provider budget actually grants two independent attempts");
			assert.equal(h.budget.getSnapshot().waitingAttemptCount, 0);
			assert.equal(h.controller.getSnapshot().physical.capacity, 2);
		}
		finally {
			timing.historicalAdmission.releaseAttempt(first, good);
			const second = await secondPromise;
			if (second.granted) timing.historicalAdmission.releaseAttempt(second, good);
		}
	});
	assert.equal(h.adaptive.getSnapshot(transportKey).selectedCap, 4);
	assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 2);
	assert.equal(h.adaptive.getSnapshot(transportKey).promotionEvidence, 0);
});
for (const [name, outcome, denialReason, remaining] of [
	["auth", auth, "provider_unhealthy", 15000],
	["server", {statusCode: 503}, "server_cooldown", 1000]
]) test("an older concurrent 2xx preserves a newer " + name + " budget cooldown", async t => {
	const h = createHarness(t, 4);
	const transportKey = key("late-success-" + name);
	const items = [prepared("late-success-" + name)];
	const job = h.makeJob("late-success-" + name, items);
	await run(h, "item-repair", job, items, async timing => {
		const oldSuccess = await acquire(timing, transportKey, "repair");
		const newFailure = await acquire(timing, transportKey, "repair");
		assert.equal(oldSuccess.granted && newFailure.granted, true);
		assert.equal(timing.historicalAdmission.releaseAttempt(newFailure, outcome), true);
		assert.equal(timing.historicalAdmission.releaseAttempt(oldSuccess, good), true);
		assert.equal(h.adaptive.getSnapshot(transportKey).effectiveCap, 1);
		assert.equal(h.budget.getSnapshot().cooldownKeyCount, 1, "the newer failure keeps its budget cooldown");
		assert.equal(h.budget.isKeyHealthy(transportKey), false, "the adaptive health proof must not treat an older request as recovery from a newer failure");
	});
	const logical = h.budget.beginLogical();
	const denied = await h.budget.acquireAttempt(logical, {transportKey});
	assert.equal(denied.granted, false);
	assert.equal(denied.reason, denialReason);
	assert.equal(denied.retryAfterMs, remaining);
	h.budget.finishLogical(logical);
});