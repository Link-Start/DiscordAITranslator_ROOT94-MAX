const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createHistoricalAdaptiveTierOwner} = require(process.env.DTA_ADAPTIVE_PATH ? path.resolve(process.env.DTA_ADAPTIVE_PATH) : "../src/orchestrator/historical-adaptive-tier-owner");
const {createHistoricalProviderBudgetOwner} = require(process.env.DTA_BUDGET_PATH ? path.resolve(process.env.DTA_BUDGET_PATH) : "../src/orchestrator/historical-provider-budget-owner");
const key = "tk1:recovery-a";
const clean = (owner, count = 1) => {for (let index = 0; index < count; index++) owner.recordClean(owner.capture(key), {saturated: true});};

test("2c fixed four recovers past two after cooldown using clean evidence without changing its selected target", () => {
	let now = 0;
	const owner = createHistoricalAdaptiveTierOwner({now: () => now});
	owner.setMode("4");
	owner.recordPressure(owner.capture(key), {reason: "server", cooldownMs: 1000});
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	now = 1000;
	assert.equal(owner.getSnapshot(key).effectiveCap, 2);
	clean(owner, 2);
	assert.equal(owner.getSnapshot(key).effectiveCap, 3, "fixed mode must not remain permanently at the recovery cap");
	clean(owner, 2);
	assert.equal(owner.getSnapshot(key).effectiveCap, 4);
	assert.equal(owner.getSnapshot(key).selectedCap, 4);
	assert.equal(owner.getSnapshot(key).learnedTier, 2);
	assert.equal(owner.getSnapshot(key).resources.observations, 0);
});

for (const reason of ["auth", "configuration", "schema", "provider_unhealthy"]) test(`2c ${reason} requires current probe proof and restores Auto gradually`, () => {
	let now = 0;
	const owner = createHistoricalAdaptiveTierOwner({now: () => now});
	clean(owner, 4);
	assert.equal(owner.getSnapshot(key).learnedTier, 4);
	owner.recordPressure(owner.capture(key), {reason});
	now = 1000000;
	clean(owner, 6);
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	const probe = owner.capture(key), sameWave = owner.capture(key);
	assert.equal(owner.recordRecovery(probe), true);
	assert.equal(owner.recordRecovery(probe), false);
	assert.equal(owner.recordClean(sameWave, {saturated: true}), false);
	assert.equal(owner.getSnapshot(key).promotionEvidence, 0);
	assert.equal(owner.getSnapshot(key, {safetyEnabled: false}).effectiveCap, 2);
	assert.equal(owner.getSnapshot(key).learnedTier, 4);
	for (const [cap, evidence] of [[2,1],[3,0],[3,1],[4,0]]) {
		clean(owner);
		assert.equal(owner.getSnapshot(key).effectiveCap, cap);
		assert.equal(owner.getSnapshot(key).promotionEvidence, evidence);
	}
	assert.equal(owner.getSnapshot(key).resources.observations, 0);
});

for (const mode of ["1", "2", "3", "4"]) test(`2c fixed ${mode} keeps selected target through blocked recovery`, () => {
	const owner = createHistoricalAdaptiveTierOwner();
	owner.setMode(mode);
	owner.recordPressure(owner.capture(key), {reason: "auth"});
	assert.equal(owner.recordRecovery(owner.capture(key)), true);
	assert.equal(owner.getSnapshot(key).effectiveCap, Math.min(2, Number(mode)));
	clean(owner, 6);
	const snapshot = owner.getSnapshot(key);
	assert.equal(snapshot.effectiveCap, Number(mode));
	assert.equal(snapshot.selectedCap, Number(mode));
	assert.equal(snapshot.learnedTier, 2);
	assert.equal(snapshot.resources.observations, 0);
});

test("2c recovery rejects older pressure epochs, mode changes, and stop generations", () => {
	const owner = createHistoricalAdaptiveTierOwner();
	owner.recordPressure(owner.capture(key), {reason: "auth"});
	const beforePressure = owner.capture(key);
	owner.recordPressure(owner.capture(key), {reason: "configuration"});
	assert.equal(owner.recordRecovery(beforePressure), false);
	const beforeMode = owner.capture(key);
	owner.setMode("4");
	assert.equal(owner.recordRecovery(beforeMode), false);
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	const beforeStop = owner.capture(key);
	owner.stop(); owner.start("4");
	owner.recordPressure(owner.capture(key), {reason: "auth"});
	assert.equal(owner.recordRecovery(beforeStop), false);
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	owner.stop();
	assert.equal(owner.getSnapshot().resources.observations, 0);
});

test("2c recovery is key-local; neutral evidence does not promote and repeated pressure returns to one", () => {
	const owner = createHistoricalAdaptiveTierOwner();
	clean(owner, 4);
	const other = "tk1:recovery-b";
	owner.recordClean(owner.capture(other), {saturated: true});
	const baseline = owner.getSnapshot(other);
	owner.recordPressure(owner.capture(key), {reason: "auth"});
	assert.equal(owner.recordRecovery(owner.capture(other)), false);
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	owner.recordRecovery(owner.capture(key));
	for (let n = 0; n < 5; n++) {
		owner.recordClean(owner.capture(key), {neutral: true, saturated: true});
		owner.recordClean(owner.capture(key), {saturated: false});
	}
	assert.equal(owner.getSnapshot(key).effectiveCap, 2);
	assert.equal(owner.getSnapshot(key).promotionEvidence, 0);
	assert.equal(owner.getSnapshot(other).promotionEvidence, baseline.promotionEvidence);
	assert.equal(owner.getSnapshot(other).learnedTier, baseline.learnedTier);
	owner.recordPressure(owner.capture(key), {reason: "auth"});
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	assert.equal(owner.getSnapshot(key).resources.observations, 0);
});

test("2c querying budget health neither resets a half-open key nor revokes an active Retry-After", async () => {
	let now = 0;
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => now});
	assert.equal(owner.isKeyHealthy(), false);
	assert.equal(owner.isKeyHealthy("invalid"), false);
	assert.equal(owner.isKeyHealthy(key), true);
	const first = owner.beginLogical();
	const a = await owner.acquireAttempt(first, {transportKey: key});
	const late = await owner.acquireAttempt(first, {transportKey: key});
	owner.releaseAttempt(a, {statusCode: 429, retryAfterMs: 5000});
	assert.equal(owner.isKeyHealthy(key), false);
	owner.releaseAttempt(late, {statusCode: 200});
	assert.equal(owner.isKeyHealthy(key), false);
	owner.finishLogical(first);
	now = 5000;
	assert.equal(owner.isKeyHealthy(key), false, "elapsed time is admission permission, not proof");
	const second = owner.beginLogical();
	const probe = await owner.acquireAttempt(second, {transportKey: key});
	owner.releaseAttempt(probe, {statusCode: 401, errorClass: "auth"});
	assert.equal(owner.resetHealth(key), true);
	assert.equal(owner.isKeyHealthy(key), false, "manual retry is not proof");
	const success = await owner.acquireAttempt(second, {transportKey: key});
	owner.releaseAttempt(success, {statusCode: 200});
	assert.equal(owner.isKeyHealthy(key), true);
	owner.finishLogical(second);
	await owner.stop();
	assert.equal(owner.isKeyHealthy(key), false);
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

for (const failure of [{statusCode: 401, errorClass: "auth"}, {statusCode: 503, errorClass: "server"}]) test(`2c old concurrent 2xx does not clear newer ${failure.errorClass} budget cooldown`, async () => {
	let now = 0;
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => now});
	const logical = owner.beginLogical();
	const failing = await owner.acquireAttempt(logical, {transportKey: key});
	const oldSuccess = await owner.acquireAttempt(logical, {transportKey: key});
	owner.releaseAttempt(failing, failure);
	owner.releaseAttempt(oldSuccess, {statusCode: 200});
	assert.equal(owner.isKeyHealthy(key), false, "old success must not revoke the newer failure");
	assert.equal(owner.getSnapshot().cooldownKeyCount, 1);
	const denied = await owner.acquireAttempt(logical, {transportKey: key});
	assert.equal(denied.granted, false);
	now = 300000;
	const probe = await owner.acquireAttempt(logical, {transportKey: key});
	assert.equal(probe.granted, true);
	owner.releaseAttempt(probe, {statusCode: 200});
	assert.equal(owner.isKeyHealthy(key), true);
	owner.finishLogical(logical);
	await owner.stop();
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

test("2c an evicted key's in-flight proof never unlocks a recreated key with the same pressure epoch", () => {
	const owner = createHistoricalAdaptiveTierOwner({keyLimit: 1});
	owner.recordPressure(owner.capture(key), {reason: "auth"});
	const oldProbe = owner.capture(key);
	owner.discard(owner.capture("tk1:eviction-b"));
	owner.recordPressure(owner.capture(key), {reason: "schema"});
	assert.equal(owner.recordRecovery(oldProbe), false);
	assert.equal(owner.getSnapshot(key).effectiveCap, 1);
	assert.equal(owner.getSnapshot(key).effectiveReason, "schema");
	assert.equal(owner.getSnapshot(key).resources.observations, 0);
	assert.equal(owner.recordRecovery(owner.capture(key)), true);
	assert.equal(owner.getSnapshot(key).effectiveCap, 2);
});
