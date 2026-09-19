const test = require("node:test");
const assert = require("node:assert/strict");
const {createW2WireBenchmarkStore} = require("../../src/diagnostics/w2-wire-benchmark-store");
const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");

const ARMS = Object.freeze(["typed-json", "compact-order", "compact-marker"]);

function begin(store, overrides = {}) {
	return store.beginW2Session(Object.assign({
		fixtureSetVersion: "w2-fixed-1",
		fixtureCount: 9,
		plannedSamplesPerArm: 54,
		plannedWarmupCount: 3,
		plannedLogicalRequests: 165,
		plannedPhysicalRequests: 165,
		estimatedPromptTokenCap: 200000,
		completionTokenCap: 260000,
		estimatedCostMicrounits: null
	}, overrides));
}

function trial(store, token, trialId, arm, overrides = {}) {
	return store.recordW2Trial(token, Object.assign({
		trialId,
		arm,
		warmup: false,
		providerMs: 100,
		status: "ok",
		valid: true,
		protectedIntegrity: "pass",
		orderDetectable: arm !== "compact-order",
		requestCount: 1,
		wireBytes: 100,
		usage: {promptTokens: 100, completionTokens: 100, reasoningTokens: 0}
	}, overrides));
}

test("W2 store begins one isolated anonymous session and exposes only bounded plan numbers", () => {
	const store = createW2WireBenchmarkStore({now: () => 1000});
	const idle = store.getW2Snapshot();
	assert.equal(idle.schemaVersion, "w2-wire-benchmark-1");
	assert.equal(idle.status, "idle");
	assert.equal(idle.maxTrials, 180);
	assert.equal(idle.resources.activeSessionCount, 0);

	const token = begin(store, {
		endpoint: "https://W2-ENDPOINT-SENTINEL.invalid",
		model: "W2-MODEL-SENTINEL",
		prompt: "W2-PROMPT-SENTINEL",
		source: "W2-SOURCE-SENTINEL"
	});
	assert.ok(token);
	assert.equal(Object.isFrozen(token), true);
	assert.equal(store.beginW2Session({fixtureSetVersion: "second"}), null);
	const running = store.getW2Snapshot();
	assert.equal(running.status, "running");
	assert.equal(running.fixtureSetVersion, "w2-fixed-1");
	assert.equal(running.resources.activeSessionCount, 1);
	const serialized = JSON.stringify(running);
	for (const secret of ["W2-ENDPOINT", "W2-MODEL", "W2-PROMPT", "W2-SOURCE"])
		assert.doesNotMatch(serialized, new RegExp(secret));
});

test("W2 nearest-rank aggregates include failed timeout and cancelled trials in the denominator", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store, {plannedSamplesPerArm: 4, plannedWarmupCount: 0, plannedLogicalRequests: 12, plannedPhysicalRequests: 12});
	trial(store, token, 0, "typed-json", {providerMs: 10});
	trial(store, token, 1, "typed-json", {providerMs: 20, status: "failed", valid: false, reason: "malformed"});
	trial(store, token, 2, "typed-json", {providerMs: 30, status: "timeout", valid: false, reason: "timeout"});
	trial(store, token, 3, "typed-json", {providerMs: 40, status: "cancelled", valid: false, reason: "cancelled", usage: null});
	store.finishW2Session(token);
	const arm = store.getW2Snapshot().arms["typed-json"];
	assert.equal(arm.sampleCount, 4);
	assert.equal(arm.successCount, 1);
	assert.equal(arm.failureCount, 1);
	assert.equal(arm.timeoutCount, 1);
	assert.equal(arm.cancelledCount, 1);
	assert.equal(arm.providerSampleCount, 4);
	assert.equal(arm.providerP50Ms, 20);
	assert.equal(arm.providerP95Ms, 40);
	assert.equal(arm.promptTokenSampleCount, 3);
	assert.equal(arm.promptTokens, null, "a partial usage sum must not impersonate a complete authoritative total");
});

test("W2 authoritative token zero survives while any missing usage keeps the aggregate null", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store, {plannedSamplesPerArm: 2, plannedWarmupCount: 0, plannedLogicalRequests: 6, plannedPhysicalRequests: 6});
	trial(store, token, 0, "typed-json", {usage: {promptTokens: 0, completionTokens: 0, reasoningTokens: 0}});
	trial(store, token, 1, "typed-json", {usage: {promptTokens: 0, completionTokens: 0, reasoningTokens: 0}});
	trial(store, token, 2, "compact-order", {usage: {promptTokens: 0, completionTokens: 0, reasoningTokens: 0}});
	trial(store, token, 3, "compact-order", {usage: null});
	store.finishW2Session(token);
	const snapshot = store.getW2Snapshot();
	assert.equal(snapshot.arms["typed-json"].promptTokens, 0);
	assert.equal(snapshot.arms["typed-json"].completionTokens, 0);
	assert.equal(snapshot.arms["typed-json"].reasoningTokens, 0);
	assert.equal(snapshot.arms["compact-order"].promptTokens, null);
	assert.equal(snapshot.arms["compact-order"].completionTokens, null);
	assert.equal(snapshot.arms["compact-order"].reasoningTokens, null);
	assert.equal(snapshot.comparisons["compact-order"].usageReady, false);
});

test("W2 three-arm gate uses 50-sample nearest-rank and keeps array order risk explicit", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store, {plannedSamplesPerArm: 50, plannedWarmupCount: 0, plannedLogicalRequests: 150, plannedPhysicalRequests: 150});
	let id = 0;
	for (let index = 0; index < 50; index++) {
		trial(store, token, id++, "typed-json", {providerMs: 100, usage: {promptTokens: 100, completionTokens: 100, reasoningTokens: 0}});
		trial(store, token, id++, "compact-order", {providerMs: 50, usage: {promptTokens: 20, completionTokens: 40, reasoningTokens: 0}, orderDetectable: false});
		trial(store, token, id++, "compact-marker", {providerMs: 50, usage: {promptTokens: 20, completionTokens: 40, reasoningTokens: 0}, orderDetectable: true});
	}
	const finished = store.finishW2Session(token);
	assert.equal(finished.status, "complete");
	assert.equal(finished.gate.ready, true);
	assert.equal(finished.arms["typed-json"].p50Ready, true);
	assert.equal(finished.arms["typed-json"].p95Ready, true);
	for (const arm of ["compact-order", "compact-marker"]) {
		const comparison = finished.comparisons[arm];
		assert.equal(comparison.sampleReady, true);
		assert.equal(comparison.usageReady, true);
		assert.equal(comparison.promptReductionPercent, 80);
		assert.equal(comparison.completionReductionPercent, 60);
		assert.equal(comparison.providerP50ImprovementPercent, 50);
		assert.equal(comparison.providerP95ChangePercent, -50);
		assert.equal(comparison.performancePassed, true);
	}
	assert.equal(finished.comparisons["compact-order"].orderDetectable, false);
	assert.equal(finished.comparisons["compact-order"].productionPassed, false);
	assert.equal(finished.comparisons["compact-marker"].orderDetectable, true);
	assert.equal(finished.comparisons["compact-marker"].productionPassed, true);
	assert.equal(finished.gate.passed, true, "one production-eligible compact arm passes every frozen gate");
});

test("W2 warmups are separately counted and never enter samples, tokens, or gates", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store, {plannedSamplesPerArm: 1, plannedWarmupCount: 3, plannedLogicalRequests: 6, plannedPhysicalRequests: 6});
	let id = 0;
	for (const arm of ARMS) trial(store, token, id++, arm, {warmup: true, providerMs: 9999, status: "failed", valid: false, usage: null});
	for (const arm of ARMS) trial(store, token, id++, arm, {providerMs: 10, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0}});
	store.finishW2Session(token);
	const snapshot = store.getW2Snapshot();
	assert.equal(snapshot.trialCount, 6);
	assert.equal(snapshot.warmupTrialCount, 3);
	assert.equal(snapshot.measuredTrialCount, 3);
	for (const arm of ARMS) {
		assert.equal(snapshot.arms[arm].warmupCount, 1);
		assert.equal(snapshot.arms[arm].sampleCount, 1);
		assert.equal(snapshot.arms[arm].providerP50Ms, 10);
		assert.equal(snapshot.arms[arm].promptTokens, 1);
	}
});

test("W2 caps anonymous trials at 180, rejects duplicates, and never exports trial payloads", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store, {plannedSamplesPerArm: 60, plannedWarmupCount: 0, plannedLogicalRequests: 180, plannedPhysicalRequests: 180});
	for (let index = 0; index < 180; index++) assert.ok(trial(store, token, index, ARMS[index % 3], {
		source: `W2-SOURCE-${index}`,
		prompt: `W2-PROMPT-${index}`,
		rawResponse: `W2-RESPONSE-${index}`,
		endpoint: `https://W2-ENDPOINT-${index}.invalid`,
		model: `W2-MODEL-${index}`,
		key: `W2-KEY-${index}`,
		header: `W2-HEADER-${index}`
	}));
	assert.equal(trial(store, token, 0, "typed-json"), false, "duplicate trial id is not counted twice");
	assert.equal(trial(store, token, 180, "typed-json"), false, "the bounded owner rejects the 181st trial");
	const snapshot = store.getW2Snapshot();
	assert.equal(snapshot.trialCount, 180);
	assert.equal(snapshot.rejectedTrialCount, 2);
	assert.equal(snapshot.resources.trialCount, 180);
	const serialized = JSON.stringify(snapshot);
	for (const secret of ["W2-SOURCE", "W2-PROMPT", "W2-RESPONSE", "W2-ENDPOINT", "W2-MODEL", "W2-KEY", "W2-HEADER"])
		assert.doesNotMatch(serialized, new RegExp(secret));
	assert.ok(Buffer.byteLength(serialized, "utf8") < 1024 * 1024);
});

test("W2 cancel and reset fence late trials by generation and release all owned resources", () => {
	let time = 10;
	const store = createW2WireBenchmarkStore({now: () => time});
	const first = begin(store);
	trial(store, first, 0, "typed-json");
	time = 20;
	const cancelled = store.cancel(first);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.resources.activeSessionCount, 0);
	assert.equal(store.recordW2Trial(first, {trialId: 1, arm: "typed-json"}), null);
	const second = begin(store);
	assert.ok(second.generation > first.generation);
	assert.equal(store.recordW2Trial(first, {trialId: 2, arm: "typed-json"}), null);
	store.reset();
	const idle = store.getW2Snapshot();
	assert.equal(idle.status, "idle");
	assert.equal(idle.trialCount, 0);
	assert.equal(idle.resources.activeSessionCount, 0);
	assert.equal(idle.resources.trialCount, 0);
	assert.equal(store.recordW2Trial(second, {trialId: 3, arm: "typed-json"}), null);
});

test("W2 failed session releases the active owner and keeps a finite terminal reason", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store);
	trial(store, token, 0, "typed-json", {status: "failed", valid: false, reason: "network"});
	const failed = store.fail(token, "consecutive-failures");
	assert.equal(failed.status, "failed");
	assert.equal(failed.reason, "consecutive-failures");
	assert.equal(failed.gate.ready, false);
	assert.equal(failed.gate.reason, "consecutive-failures");
	assert.equal(failed.resources.activeSessionCount, 0);
	assert.equal(store.recordW2Trial(token, {trialId: 1, arm: "typed-json"}), null);
});

test("W2 keeps compact marker validator reasons finite instead of collapsing them to unknown", () => {
	const store = createW2WireBenchmarkStore();
	const token = begin(store, {plannedSamplesPerArm: 1, plannedWarmupCount: 0, plannedLogicalRequests: 3, plannedPhysicalRequests: 3});
	trial(store, token, 0, "typed-json");
	trial(store, token, 1, "compact-order");
	trial(store, token, 2, "compact-marker", {status: "failed", valid: false, reason: "missing-terminal-marker"});
	const snapshot = store.finishW2Session(token);
	assert.equal(snapshot.trials[2].reason, "missing-terminal-marker");
	assert.equal(snapshot.arms["compact-marker"].reasonCounts["missing-terminal-marker"], 1);
});

test("provider latency store delegates W2 ownership without enlarging its 20-attempt ring", () => {
	const store = createProviderLatencyStore();
	const session = store.beginW2Session({fixtureSetVersion: "w2-fixed-1", fixtureCount: 9, plannedSamplesPerArm: 1, plannedLogicalRequests: 3});
	assert.ok(session);
	store.recordW2Trial(session, {trialId: 0, arm: "typed-json", providerMs: 10, status: "ok", valid: true, orderDetectable: true, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0}});
	assert.equal(store.getW2Snapshot().trialCount, 1);
	for (let index = 0; index < 21; index++) {
		const token = store.beginLatencyRequest({kind: "manual"});
		store.recordLatencyEvent({token, status: "ok"});
	}
	assert.equal(store.getAttemptsCount(), 20);
	store.resetLatency();
	assert.equal(store.getAttemptsCount(), 0);
	assert.equal(store.getW2Snapshot().status, "idle");
	assert.equal(store.recordW2Trial(session, {trialId: 1, arm: "typed-json"}), null);
});
