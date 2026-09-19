const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// Replay a saved pre-fix module without copying unrelated dependencies into the artifact.
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

const key = name => `tk1:${name}`;
const good = {statusCode: 200};
const auth = {statusCode: 401, errorClass: "auth"};

function createHarness(t) {
	let clock = 1000;
	let budget;
	const probeRequests = [];
	const current = new Set();
	const controller = createPluginHistoricalBatchPerformance({
		now: () => clock,
		createProviderBudgetOwner: options => {
			budget = createHistoricalProviderBudgetOwner(options);
			return Object.freeze(Object.assign({}, budget, {acquireAttempt: (logical, request) => {
				if (request && request.probeHealth === true) probeRequests.push(request.transportKey);
				return budget.acquireAttempt(logical, request);
			}}));
		}
	});
	controller.start();
	controller.setConcurrency(1);
	const owner = {
		isHistoricalTranslationJobCurrent: job => current.has(job),
		ensureProviderClient: () => ({isBackoffActive: () => false, beginLatencyRequest: () => null}),
		ensureLiveTranslationQueue: () => ({getLiveSlotActiveCount: () => 0, getQueueLength: () => 0, isBusyTranslating: () => false})
	};
	t.after(async () => {
		current.clear();
		await controller.stop();
		assert.equal(budget.getSnapshot().activeAttemptCount, 0);
		assert.equal(budget.getSnapshot().waitingAttemptCount, 0);
	});
	const makeJob = (id, prepared) => {
		const job = {id, items: new Map(prepared.map(item => [item.message.id, item.queueItem])), state: "translating", createSummary: () => ({translated: [], skipped: [], failed: []})};
		current.add(job);
		job.historicalPerformanceToken = controller.begin(job);
		return job;
	};
	const seedHealth = async (transportKey, outcome) => {
		const logical = budget.beginLogical();
		const lease = await budget.acquireAttempt(logical, {transportKey, role: "primary", itemCount: 1});
		assert.equal(lease.granted, true);
		assert.equal(budget.releaseAttempt(lease, outcome), true);
		budget.finishLogical(logical);
	};
	return {controller, owner, current, makeJob, probeRequests, seedHealth, budget, advance: ms => {clock += ms;}};
}

function prepared(id, options = {}) {
	return {message: {id}, protectedText: `text-${id}`, queueItem: Object.assign({message: {id}}, options)};
}

async function attempt(timing, transportKey, outcome = good, role = "primary") {
	timing.historicalContractObserver({transportKey});
	const admission = await timing.historicalAdmission.acquireAttempt({transportKey, role, itemCount: 1, protectedChars: 8, bodyBytes: 80, estimatedTokens: 20});
	if (admission.granted) assert.equal(timing.historicalAdmission.releaseAttempt(admission, outcome), true);
	return admission;
}

async function primary(h, job, items, request) {
	h.owner.requestAiBatchTranslationDetailed = async (_engine, chunk, timing) => {
		await request(timing, chunk);
		return {translations: Object.fromEntries(chunk.map(item => [item.message.id, "translated"])), failureKind: null, statusCode: 200};
	};
	return h.controller.runPrimaryBatch(h.owner, "fixture-engine", items, job, () => {});
}

test("historical primary associates only actual health-failure Transport Keys with its source items", async t => {
	const h = createHarness(t);
	const items = [prepared("one"), prepared("two")];
	const job = h.makeJob("primary-failure", items);
	await primary(h, job, items, async timing => {
		assert.equal((await attempt(timing, key("success"))).granted, true);
		assert.equal((await attempt(timing, key("failed"), auth)).granted, true);
		assert.equal((await attempt(timing, key("timeout-only"), {errorClass: "timeout"})).granted, true);
	});
	for (const item of items) assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [key("failed")]);
	assert.deepEqual(h.probeRequests, []);
});

for (const [name, outcome, reason] of [
	["unhealthy", auth, "provider_unhealthy"],
	["limited", {statusCode: 429, retryAfterMs: 9000}, "rate_limit"],
	["server", {statusCode: 503}, "server_cooldown"]
]) test(`historical ${reason} admission denial retains its actual captured key for the source`, async t => {
	const h = createHarness(t);
	const transportKey = key(name);
	await h.seedHealth(transportKey, outcome);
	const items = [prepared(name)];
	const job = h.makeJob(`denied-${name}`, items);
	await primary(h, job, items, async timing => {
		const denied = await attempt(timing, transportKey);
		assert.equal(denied.granted, false);
		assert.equal(denied.reason, reason);
	});
	assert.deepEqual(items[0].queueItem.historicalRetryTransportKeys, [transportKey]);
	assert.deepEqual(h.probeRequests, []);
});

test("batch repair records repair and backup failures only on that batch's source items", async t => {
	const h = createHarness(t);
	const items = [prepared("batch-one"), prepared("batch-two")];
	const outside = prepared("outside");
	const job = h.makeJob("repair-batch", [...items, outside]);
	await h.controller.runRepairBatch(h.owner, job, items.length, async timing => {
		assert.equal((await attempt(timing, key("repair-batch"), {statusCode: 503}, "repair")).role, "repair");
		assert.equal((await attempt(timing, key("batch-backup"), auth, "backup")).role, "backup");
		assert.equal((await attempt(timing, key("batch-success"), good, "backup")).role, "backup");
	}, "fixture-engine", items);
	for (const item of items) assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [key("repair-batch"), key("batch-backup")]);
	assert.equal(outside.queueItem.historicalRetryTransportKeys, undefined);
	assert.deepEqual(h.probeRequests, []);
});

test("item repair records repair and backup failures only on its source item", async t => {
	const h = createHarness(t);
	const item = prepared("item");
	const outside = prepared("outside-item");
	const job = h.makeJob("repair-item", [item, outside]);
	await h.controller.runRepairItem(h.owner, job, async context => {
		const timing = context.createTimingContext({role: "retry", engineKey: "fixture-engine", historicalBatch: false});
		assert.equal((await attempt(timing, key("repair-item"), {statusCode: 429, retryAfterMs: 9000}, "repair")).role, "repair");
		assert.equal((await attempt(timing, key("item-backup"), auth, "backup")).role, "backup");
	}, item);
	assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [key("repair-item"), key("item-backup")]);
	assert.equal(outside.queueItem.historicalRetryTransportKeys, undefined);
});

test("retry snapshots prior source authority, probes matching key once per job and carries only new failures", async t => {
	const h = createHarness(t);
	const matched = key("prior-failure"), other = key("new-provider"), unused = key("unused-prior");
	await h.seedHealth(matched, auth);
	await h.seedHealth(other, auth);
	const item = prepared("retry", {retryFailed: true, historicalRetryTransportKeys: [matched, unused]});
	const job = h.makeJob("retry-scope", [item]);
	await primary(h, job, [item], async timing => {
		assert.equal(item.queueItem.historicalRetryTransportKeys, undefined, "old keys leave the source at first context");
		assert.deepEqual(h.probeRequests, [], "building a context does not probe any provider");
		timing.historicalContractObserver({transportKey: matched});
		assert.deepEqual(h.probeRequests, [], "contract observation alone is not dispatch admission");
		assert.equal((await attempt(timing, other)).reason, "provider_unhealthy");
		assert.deepEqual(h.probeRequests, [], "new unmatched provider retains its cooldown");
		assert.equal((await attempt(timing, matched, auth)).granted, true, "matching prior failure gets one immediate probe");
		assert.equal((await attempt(timing, matched)).reason, "provider_unhealthy", "failed probe re-cools instead of resetting again");
	});
	assert.deepEqual(h.probeRequests, [matched]);
	assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [other, matched], "unused old authority is absent from the next snapshot");
	await h.controller.runRepairItem(h.owner, job, async context => {
		const timing = context.createTimingContext({role: "retry"});
		assert.equal((await attempt(timing, matched, good, "repair")).reason, "provider_unhealthy");
		assert.equal((await attempt(timing, other, good, "backup")).reason, "provider_unhealthy", "current-run failures cannot grant new authority in the same job");
	}, item);
	assert.deepEqual(h.probeRequests, [matched], "one probe per captured key spans primary and repair contexts");
	assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [other, matched]);

	h.current.delete(job);
	const nextJob = h.makeJob("next-user-retry", [item]);
	await primary(h, nextJob, [item], async timing => {
		assert.equal(item.queueItem.historicalRetryTransportKeys, undefined);
		assert.equal((await attempt(timing, other)).granted, true, "new user retry can use the previous run's newly captured failure");
	});
	assert.deepEqual(h.probeRequests, [matched, other]);
	assert.equal(item.queueItem.historicalRetryTransportKeys, undefined, "successful rerun carries no stale association forward");
});

for (const [name, options] of [
	["unknown association", {retryFailed: true}],
	["non-retry source", {historicalRetryTransportKeys: [key("unowned")]}]
]) test(`${name} does not reset captured provider health`, async t => {
	const h = createHarness(t);
	await h.seedHealth(key("unowned"), auth);
	const item = prepared(name, options);
	const job = h.makeJob(name, [item]);
	await primary(h, job, [item], async timing => {
		assert.equal((await attempt(timing, key("unowned"))).reason, "provider_unhealthy");
	});
	assert.deepEqual(h.probeRequests, []);
	assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [key("unowned")]);
});

test("a stale retry context does not reset its associated key before rejected admission", async t => {
	const h = createHarness(t);
	const transportKey = key("stale");
	await h.seedHealth(transportKey, auth);
	const item = prepared("stale", {retryFailed: true, historicalRetryTransportKeys: [transportKey]});
	const job = h.makeJob("stale", [item]);
	await h.controller.runRepairItem(h.owner, job, async context => {
		const timing = context.createTimingContext({role: "retry"});
		h.current.delete(job);
		assert.equal((await attempt(timing, transportKey)).reason, "cancelled");
	}, item);
	assert.deepEqual(h.probeRequests, []);
	const token = h.budget.beginLogical();
	assert.equal((await h.budget.acquireAttempt(token, {transportKey})).reason, "provider_unhealthy");
	h.budget.finishLogical(token);
});

test("an expired logical timing context cannot consume a source's retry probe", async t => {
	const h = createHarness(t);
	const transportKey = key("expired-context");
	await h.seedHealth(transportKey, auth);
	const item = prepared("expired-context", {retryFailed: true, historicalRetryTransportKeys: [transportKey]});
	const job = h.makeJob("expired-context", [item]);
	let expiredTiming;
	await h.controller.runRepairItem(h.owner, job, async context => {
		expiredTiming = context.createTimingContext({role: "retry"});
	}, item);
	assert.equal((await attempt(expiredTiming, transportKey)).reason, "cancelled");
	assert.deepEqual(h.probeRequests, [], "finished logical requests never reset provider health");
	const token = h.budget.beginLogical();
	assert.equal((await h.budget.acquireAttempt(token, {transportKey})).reason, "provider_unhealthy");
	h.budget.finishLogical(token);
});

test("even a matched retry keeps its provider's valid Retry-After deadline", async t => {
	const h = createHarness(t);
	const transportKey = key("matched-rate-limit");
	await h.seedHealth(transportKey, {statusCode: 429, retryAfterMs: 9000});
	const item = prepared("matched-rate-limit", {retryFailed: true, historicalRetryTransportKeys: [transportKey]});
	const job = h.makeJob("matched-rate-limit", [item]);
	await primary(h, job, [item], async timing => {
		const denied = await attempt(timing, transportKey);
		assert.equal(denied.reason, "rate_limit");
		assert.equal(denied.retryAfterMs, 9000);
	});
	assert.deepEqual(h.probeRequests, [transportKey], "wiring only conveys the single matched probe request; the real owner retains rate-limit policy");
	assert.deepEqual(item.queueItem.historicalRetryTransportKeys, [transportKey]);
	h.advance(1000);
	const logical = h.budget.beginLogical();
	const denied = await h.budget.acquireAttempt(logical, {transportKey});
	assert.equal(denied.reason, "rate_limit");
	assert.equal(denied.retryAfterMs, 8000, "retry neither removes nor extends the provider's deadline");
	h.budget.finishLogical(logical);
});

test("an unmatched caller-provided probe flag grants no retry authority", async t => {
	const h = createHarness(t);
	const transportKey = key("unmatched-flag");
	await h.seedHealth(transportKey, auth);
	const item = prepared("unmatched-flag", {retryFailed: true});
	const job = h.makeJob("unmatched-flag", [item]);
	await primary(h, job, [item], async timing => {
		const denied = await timing.historicalAdmission.acquireAttempt({transportKey, probeHealth: true});
		assert.equal(denied.reason, "provider_unhealthy");
	});
	assert.deepEqual(h.probeRequests, []);
});

test("an aborted logical request cannot probe health while its job is still current", async t => {
	const h = createHarness(t);
	const transportKey = key("aborted-context");
	await h.seedHealth(transportKey, auth);
	const item = prepared("aborted-context", {retryFailed: true, historicalRetryTransportKeys: [transportKey]});
	const job = h.makeJob("aborted-context", [item]);
	await h.controller.runRepairItem(h.owner, job, async context => {
		const timing = context.createTimingContext({role: "retry"});
		assert.equal(h.controller.abortJobAttempts(job), 1);
		assert.equal(h.current.has(job), true);
		assert.equal(timing.requestContext.signal.aborted, true);
		assert.equal((await attempt(timing, transportKey)).reason, "cancelled");
		assert.equal(timing.requestContext.isCurrent(), false);
		assert.equal(timing.historicalAdmission.isCurrent(), false);
	}, item);
	assert.deepEqual(h.probeRequests, []);
	const logical = h.budget.beginLogical();
	assert.equal((await h.budget.acquireAttempt(logical, {transportKey})).reason, "provider_unhealthy");
	h.budget.finishLogical(logical);
});
