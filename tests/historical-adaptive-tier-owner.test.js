const test = require("node:test");
const assert = require("node:assert/strict");
const {createHistoricalAdaptiveTierOwner} = require("../src/orchestrator/historical-adaptive-tier-owner");

const key = suffix => `tk1:${String(suffix).padStart(64, "a")}`;
const partial = (actual, expected) => {for (const [field, value] of Object.entries(expected)) assert.deepEqual(actual[field], value, field);};

function promote(owner, transportKey, target) {
	while (owner.getSnapshot(transportKey).learnedTier < target) {
		const first = owner.capture(transportKey);
		assert.equal(owner.recordClean(first, {saturated: true}), true);
		const second = owner.capture(transportKey);
		assert.equal(owner.recordClean(second, {saturated: true}), true);
	}
}

test("S6 learned tiers and promotion evidence are isolated by the captured H1 Transport Key", () => {
	const owner = createHistoricalAdaptiveTierOwner();
	const a = key("1"), b = key("2");
	promote(owner, a, 4);
	partial(owner.getSnapshot(a), {learnedTier: 4, promotionEvidence: 0, effectiveCap: 4});
	partial(owner.getSnapshot(b), {learnedTier: 2, promotionEvidence: 0, effectiveCap: 2});
	assert.equal(owner.getSnapshot(a).keyStateCount, 2);
	assert.equal(Object.values(owner.getSnapshot(a)).includes(a), false, "diagnostics never export the key");
});

test("S6 live pressure is temporary and a neutral overlap preserves learned tier and evidence", () => {
	const owner = createHistoricalAdaptiveTierOwner();
	const transportKey = key("3");
	promote(owner, transportKey, 3);
	const evidence = owner.capture(transportKey);
	owner.recordClean(evidence, {saturated: true});
	assert.equal(owner.getSnapshot(transportKey).promotionEvidence, 1);
	assert.equal(owner.getSnapshot(transportKey, {liveBusy: true}).effectiveCap, 1);
	assert.equal(owner.getSnapshot(transportKey, {liveBusy: true}).effectiveReason, "live_busy");
	assert.equal(owner.recordClean(owner.capture(transportKey), {neutral: true}), true);
	assert.equal(owner.getSnapshot(transportKey).learnedTier, 3);
	assert.equal(owner.getSnapshot(transportKey).promotionEvidence, 1);
	assert.equal(owner.getSnapshot(transportKey, {liveBusy: false}).effectiveCap, 3);
});

test("S6 per-key cooldown recovers at two then restores the learned tier through clean evidence", () => {
	let now = 1000;
	const owner = createHistoricalAdaptiveTierOwner({now: () => now});
	const a = key("4"), b = key("5");
	promote(owner, a, 4);
	const pressured = owner.capture(a);
	assert.equal(owner.recordPressure(pressured, {reason: "rate_limit", cooldownMs: 2000}), true);
	assert.equal(owner.getSnapshot(a).effectiveCap, 1);
	assert.equal(owner.getSnapshot(a).cooldownRemainingMs, 2000);
	assert.equal(owner.getSnapshot(b).effectiveCap, 2, "healthy key bypasses the limited key");
	now = 3000;
	assert.equal(owner.getSnapshot(a).effectiveCap, 2);
	assert.equal(owner.getSnapshot(a).effectiveReason, "recovery");
	owner.recordClean(owner.capture(a), {saturated: true});
	owner.recordClean(owner.capture(a), {saturated: true});
	assert.equal(owner.getSnapshot(a).effectiveCap, 3);
	owner.recordClean(owner.capture(a), {saturated: true});
	owner.recordClean(owner.capture(a), {saturated: true});
	partial(owner.getSnapshot(a), {learnedTier: 4, effectiveCap: 4, effectiveReason: null, promotionEvidence: 0});
});

test("S6 timeout and malformed health obey the safety switch while 429 and 5xx remain hard provider limits", () => {
	let now = 0;
	const owner = createHistoricalAdaptiveTierOwner({now: () => now, defaultCooldownMs: 500});
	const cases = [
		["timeout", false], ["malformed", false], ["rate_limit", true], ["server", true]
	];
	for (let index = 0; index < cases.length; index++) {
		const [reason, hard] = cases[index], transportKey = key(String(6 + index));
		owner.recordPressure(owner.capture(transportKey), {reason, cooldownMs: 500});
		assert.equal(owner.getSnapshot(transportKey, {safetyEnabled: false}).effectiveCap, hard ? 1 : 2, reason);
		assert.equal(owner.getSnapshot(transportKey, {safetyEnabled: true}).effectiveCap, 1, reason);
	}
});

test("S6 fixed modes retain their selected target and configuration changes reject late evidence", () => {
	const owner = createHistoricalAdaptiveTierOwner();
	const transportKey = key("a");
	for (const value of [1, 2, 3, 4]) {
		owner.setMode(String(value));
		partial(owner.getSnapshot(transportKey), {adaptiveMode: false, selectedCap: value, effectiveCap: value});
		assert.equal(owner.getSnapshot(transportKey, {liveBusy: true}).effectiveCap, 1);
	}
	owner.setMode("auto");
	const stale = owner.capture(transportKey);
	owner.setMode("4");
	assert.equal(owner.recordClean(stale, {saturated: true}), false);
	assert.equal(owner.getSnapshot(transportKey).lateObservationCount, 1);
});

test("S6 one hundred stop restart cycles leave no owned adaptive state", () => {
	const owner = createHistoricalAdaptiveTierOwner();
	for (let index = 0; index < 100; index++) {
		owner.capture(key(String(index)));
		owner.stop();
		partial(owner.getSnapshot(), {stopped: true, keyStateCount: 0, resources: {keys: 0, observations: 0}});
		owner.start("auto");
		partial(owner.getSnapshot(), {stopped: false, learnedTier: 2, effectiveCap: 2, resources: {keys: 0, observations: 0}});
	}
});
