const test = require("node:test");
const assert = require("node:assert/strict");
const {
	MAX_HISTORICAL_ITEMS_PER_ATTEMPT,
	MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT,
	MAX_HISTORICAL_BODY_BYTES_PER_ATTEMPT,
	MAX_HISTORICAL_ESTIMATED_TOKENS_PER_ATTEMPT,
	MAX_HISTORICAL_ATTEMPTS_PER_LOGICAL,
	createHistoricalProviderBudgetOwner
} = require("../src/orchestrator/historical-provider-budget-owner");

const settle = () => new Promise(resolve => setImmediate(resolve));

async function isPending(promise) {
	let pending = true;
	promise.finally(() => {pending = false;});
	await settle();
	return pending;
}

function metrics(overrides = {}) {
	return Object.assign({transportKey: "tk1:primary", workloadKey: "wk1:fixture", role: "primary", itemCount: 10, protectedChars: 1000, bodyBytes: 4000, estimatedTokens: 1000, isCurrent: () => true}, overrides);
}

test("S3H freezes the four request budgets and one logical attempt ceiling", () => {
	assert.equal(MAX_HISTORICAL_ITEMS_PER_ATTEMPT, 10);
	assert.equal(MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT, 12000);
	assert.equal(MAX_HISTORICAL_BODY_BYTES_PER_ATTEMPT, 65536);
	assert.equal(MAX_HISTORICAL_ESTIMATED_TOKENS_PER_ATTEMPT, 16384);
	assert.equal(MAX_HISTORICAL_ATTEMPTS_PER_LOGICAL, 3);
});

test("same Transport Key shares one role-neutral cap while a different key owns a separate provider budget", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 2});
	const primary = owner.beginLogical({isCurrent: () => true});
	const repair = owner.beginLogical({isCurrent: () => true});
	const backup = owner.beginLogical({isCurrent: () => true});
	const first = await owner.acquireAttempt(primary, metrics({role: "primary"}));
	const second = await owner.acquireAttempt(repair, metrics({role: "repair"}));
	const sameKeyWaiting = owner.acquireAttempt(backup, metrics({role: "backup"}));
	assert.equal(await isPending(sameKeyWaiting), true);
	const otherKey = await owner.acquireAttempt(backup, metrics({transportKey: "tk1:backup", role: "backup"}));
	assert.equal(otherKey.granted, true, "a backup Transport Key owns a distinct provider budget");
	let snapshot = owner.getSnapshot();
	assert.equal(snapshot.activeAttemptCount, 3);
	assert.equal(snapshot.waitingAttemptCount, 1);
	assert.equal(snapshot.activeKeyCount, 2);
	assert.equal(snapshot.maxActiveByKey, 2);
	owner.releaseAttempt(first);
	const third = await sameKeyWaiting;
	assert.equal(third.granted, true);
	for (const lease of [second, third, otherKey]) assert.equal(owner.releaseAttempt(lease), true);
	for (const logical of [primary, repair, backup]) owner.finishLogical(logical);
	snapshot = owner.getSnapshot();
	assert.equal(snapshot.activeAttemptCount, 0);
	assert.equal(snapshot.waitingAttemptCount, 0);
	assert.equal(snapshot.logicalCount, 0);
});

test("one logical shares a total attempt budget across primary retry and backup keys", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4});
	const logical = owner.beginLogical({isCurrent: () => true});
	const leases = [];
	leases.push(await owner.acquireAttempt(logical, metrics({role: "primary"})));
	leases.push(await owner.acquireAttempt(logical, metrics({role: "repair"})));
	leases.push(await owner.acquireAttempt(logical, metrics({transportKey: "tk1:backup", role: "backup"})));
	const denied = await owner.acquireAttempt(logical, metrics({transportKey: "tk1:backup", role: "backup"}));
	assert.deepEqual(denied, {granted: false, reason: "attempt_budget"});
	assert.equal(owner.getSnapshot().deniedAttemptBudgetCount, 1);
	for (const lease of leases) owner.releaseAttempt(lease);
	owner.finishLogical(logical);
});

test("a single oversized item is explicit and exclusive while a multi-item violation never dispatches", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4});
	const ordinaryLogical = owner.beginLogical({isCurrent: () => true});
	const oversizedLogical = owner.beginLogical({isCurrent: () => true});
	const followerLogical = owner.beginLogical({isCurrent: () => true});
	const ordinary = await owner.acquireAttempt(ordinaryLogical, metrics());
	const oversizedPending = owner.acquireAttempt(oversizedLogical, metrics({itemCount: 1, protectedChars: 12001, bodyBytes: 65537, estimatedTokens: 16385}));
	assert.equal(await isPending(oversizedPending), true, "oversized single waits to own the key exclusively");
	owner.releaseAttempt(ordinary);
	const oversized = await oversizedPending;
	assert.equal(oversized.granted, true);
	assert.equal(oversized.oversized, true);
	assert.deepEqual(oversized.exceeded, ["protected_chars", "body_bytes", "estimated_tokens"]);
	const followerPending = owner.acquireAttempt(followerLogical, metrics());
	assert.equal(await isPending(followerPending), true, "ordinary work cannot overlap an exclusive single");
	const multiDenied = await owner.acquireAttempt(followerLogical, metrics({itemCount: 2, bodyBytes: 65537}));
	assert.deepEqual(multiDenied, {granted: false, reason: "request_budget", exceeded: ["body_bytes"]});
	owner.releaseAttempt(oversized);
	const follower = await followerPending;
	owner.releaseAttempt(follower);
	for (const logical of [ordinaryLogical, oversizedLogical, followerLogical]) owner.finishLogical(logical);
	const snapshot = owner.getSnapshot();
	assert.equal(snapshot.oversizedSingleCount, 1);
	assert.equal(snapshot.deniedRequestBudgetCount, 1);
	assert.equal(snapshot.activeAttemptCount, 0);
});

test("cancellation rejects queued admission and exact-token release is idempotent", async () => {
	let secondCurrent = true;
	const owner = createHistoricalProviderBudgetOwner({capacity: 1});
	const firstLogical = owner.beginLogical({isCurrent: () => true});
	const secondLogical = owner.beginLogical({isCurrent: () => secondCurrent});
	const first = await owner.acquireAttempt(firstLogical, metrics());
	const queued = owner.acquireAttempt(secondLogical, metrics({isCurrent: () => secondCurrent}));
	assert.equal(await isPending(queued), true);
	secondCurrent = false;
	assert.equal(owner.cancelLogical(secondLogical, "cancelled"), true);
	assert.deepEqual(await queued, {granted: false, reason: "cancelled"});
	assert.equal(owner.releaseAttempt(Object.freeze({})), false);
	assert.equal(owner.releaseAttempt(first), true);
	assert.equal(owner.releaseAttempt(first), false);
	owner.finishLogical(firstLogical);
	owner.finishLogical(secondLogical);
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

test("stop rejects queued work, retains active logical admission until settle, then restarts empty", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 1});
	const firstLogical = owner.beginLogical({isCurrent: () => true});
	const secondLogical = owner.beginLogical({isCurrent: () => true});
	const first = await owner.acquireAttempt(firstLogical, metrics());
	const queued = owner.acquireAttempt(secondLogical, metrics());
	assert.equal(await isPending(queued), true);
	const draining = owner.stop();
	assert.deepEqual(await queued, {granted: false, reason: "stopped"});
	assert.equal(await isPending(draining), true);
	assert.equal(owner.getSnapshot().activeAttemptCount, 1, "S4-before logical lease remains until callback settle");
	owner.releaseAttempt(first);
	await draining;
	owner.finishLogical(firstLogical);
	owner.finishLogical(secondLogical);
	owner.start(2);
	const freshLogical = owner.beginLogical({isCurrent: () => true});
	const fresh = await owner.acquireAttempt(freshLogical, metrics());
	assert.equal(fresh.granted, true);
	owner.releaseAttempt(fresh);
	owner.finishLogical(freshLogical);
	const snapshot = owner.getSnapshot();
	assert.equal(snapshot.stopped, false);
	assert.deepEqual(snapshot.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

test("one hundred cancel/stop/restart cycles leave every S3H resource at zero", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4});
	for (let cycle = 0; cycle < 100; cycle++) {
		const logical = owner.beginLogical({isCurrent: () => true});
		const lease = await owner.acquireAttempt(logical, metrics({transportKey: `tk1:key${cycle % 3}`}));
		const drain = owner.stop();
		owner.releaseAttempt(lease);
		await drain;
		owner.finishLogical(logical);
		owner.start(4);
	}
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

test("S5 Retry-After blocks only its captured key and recovers that key at effective cap1", async () => {
	let clock = 1000;
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => clock});
	const failedLogical = owner.beginLogical({isCurrent: () => true});
	const failed = await owner.acquireAttempt(failedLogical, metrics({transportKey: "tk1:limited"}));
	owner.releaseAttempt(failed, {statusCode: 429, errorClass: "rate_limit", retryAfterMs: 500});
	owner.finishLogical(failedLogical);
	const limitedLogical = owner.beginLogical({isCurrent: () => true});
	assert.deepEqual(await owner.acquireAttempt(limitedLogical, metrics({transportKey: "tk1:limited"})), {granted: false, reason: "rate_limit", retryAfterMs: 500});
	const healthyLogical = owner.beginLogical({isCurrent: () => true});
	const healthy = await owner.acquireAttempt(healthyLogical, metrics({transportKey: "tk1:healthy"}));
	assert.equal(healthy.granted, true, "healthy key bypasses the limited queue in one tick");
	owner.releaseAttempt(healthy, {statusCode: 200});
	owner.finishLogical(healthyLogical);
	clock += 500;
	const recoveringA = owner.beginLogical({isCurrent: () => true});
	const recoveringB = owner.beginLogical({isCurrent: () => true});
	const first = await owner.acquireAttempt(recoveringA, metrics({transportKey: "tk1:limited"}));
	const secondPending = owner.acquireAttempt(recoveringB, metrics({transportKey: "tk1:limited"}));
	assert.equal(await isPending(secondPending), true, "post-window recovery is capped at one");
	owner.releaseAttempt(first, {statusCode: 200});
	const second = await secondPending;
	owner.releaseAttempt(second, {statusCode: 200});
	for (const logical of [limitedLogical, recoveringA, recoveringB]) owner.finishLogical(logical);
	const snapshot = owner.getSnapshot();
	assert.equal(snapshot.rateLimitCount, 1);
	assert.equal(snapshot.recoveryKeyCount, 0);
	assert.deepEqual(snapshot.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

test("P4 auth schema and configuration health cool down only the failed Transport Key and leave a healthy backup", async () => {
	for (const errorClass of ["auth", "schema", "not_found", "invalid_request"]) {
		let clock = 0;
		const owner = createHistoricalProviderBudgetOwner({capacity: 2, now: () => clock, unhealthyCooldownMs: 15000});
		const failedLogical = owner.beginLogical({isCurrent: () => true});
		const failed = await owner.acquireAttempt(failedLogical, metrics({transportKey: "tk1:bad"}));
		owner.releaseAttempt(failed, {statusCode: errorClass === "auth" ? 401 : 400, errorClass});
		owner.finishLogical(failedLogical);
		// The failed key is denied while the breaker cools, but now with a retry window instead
		// of the old permanent block; the healthy backup key is still admitted immediately.
		const blockedLogical = owner.beginLogical({isCurrent: () => true});
		assert.deepEqual(await owner.acquireAttempt(blockedLogical, metrics({transportKey: "tk1:bad"})), {granted: false, reason: "provider_unhealthy", retryAfterMs: 15000});
		const backupLogical = owner.beginLogical({isCurrent: () => true});
		const backup = await owner.acquireAttempt(backupLogical, metrics({transportKey: "tk1:backup", role: "backup"}));
		assert.equal(backup.granted, true);
		owner.releaseAttempt(backup, {statusCode: 200});
		owner.finishLogical(blockedLogical);
		owner.finishLogical(backupLogical);
		assert.equal(owner.getSnapshot().invalidatedHealthCount, 1);
		assert.equal(owner.getSnapshot().blockedKeyCount, 0, "config-class failures no longer hard-block the key");
	}
});

test("P4 an unhealthy key recovers on a single post-cooldown probe and backs off on repeated failures", async () => {
	let clock = 0;
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => clock, unhealthyCooldownMs: 15000, unhealthyCooldownMaxMs: 300000});
	const first = owner.beginLogical({isCurrent: () => true});
	const firstLease = await owner.acquireAttempt(first, metrics({transportKey: "tk1:startup"}));
	owner.releaseAttempt(firstLease, {statusCode: 404, errorClass: "not_found"});
	owner.finishLogical(first);
	// Still cooling: denied with the base window.
	const during = owner.beginLogical({isCurrent: () => true});
	assert.deepEqual(await owner.acquireAttempt(during, metrics({transportKey: "tk1:startup"})), {granted: false, reason: "provider_unhealthy", retryAfterMs: 15000});
	owner.finishLogical(during);
	// After the cooldown one recovery probe is admitted (recovery caps the key at 1).
	clock += 15000;
	const probeA = owner.beginLogical({isCurrent: () => true});
	const probeB = owner.beginLogical({isCurrent: () => true});
	const probe = await owner.acquireAttempt(probeA, metrics({transportKey: "tk1:startup"}));
	assert.equal(probe.granted, true, "the key is probeable once the cooldown elapses");
	const secondPending = owner.acquireAttempt(probeB, metrics({transportKey: "tk1:startup"}));
	assert.equal(await isPending(secondPending), true, "recovery admits a single probe at a time");
	// The probe fails again: the breaker re-cools with a doubled window (backoff), and the
	// queued sibling is denied for that longer window rather than let through.
	owner.releaseAttempt(probe, {statusCode: 400, errorClass: "schema"});
	assert.deepEqual(await secondPending, {granted: false, reason: "provider_unhealthy", retryAfterMs: 30000});
	owner.finishLogical(probeA);
	owner.finishLogical(probeB);
	// After the longer window a probe that succeeds clears the key entirely: full capacity returns.
	clock += 30000;
	const healA = owner.beginLogical({isCurrent: () => true});
	const heal = await owner.acquireAttempt(healA, metrics({transportKey: "tk1:startup"}));
	assert.equal(heal.granted, true);
	owner.releaseAttempt(heal, {statusCode: 200});
	owner.finishLogical(healA);
	const cleared = owner.beginLogical({isCurrent: () => true});
	const clearedLease = await owner.acquireAttempt(cleared, metrics({transportKey: "tk1:startup"}));
	assert.equal(clearedLease.granted, true, "a 2xx probe clears the breaker so the key is healthy again");
	owner.releaseAttempt(clearedLease, {statusCode: 200});
	owner.finishLogical(cleared);
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
});

test("P4 explicit-key resetHealth opens the breaker so a retry probes immediately", async () => {
	let clock = 0;
	const owner = createHistoricalProviderBudgetOwner({capacity: 2, now: () => clock, unhealthyCooldownMs: 60000});
	const failedLogical = owner.beginLogical({isCurrent: () => true});
	const failed = await owner.acquireAttempt(failedLogical, metrics({transportKey: "tk1:bad"}));
	owner.releaseAttempt(failed, {statusCode: 401, errorClass: "auth"});
	owner.finishLogical(failedLogical);
	const stillCooling = owner.beginLogical({isCurrent: () => true});
	assert.deepEqual(await owner.acquireAttempt(stillCooling, metrics({transportKey: "tk1:bad"})), {granted: false, reason: "provider_unhealthy", retryAfterMs: 60000});
	owner.finishLogical(stillCooling);
	// The explicit key probe drops the cooldown without advancing the clock.
	assert.equal(owner.resetHealth("tk1:bad"), true);
	const retryLogical = owner.beginLogical({isCurrent: () => true});
	const retry = await owner.acquireAttempt(retryLogical, metrics({transportKey: "tk1:bad"}));
	assert.equal(retry.granted, true, "reset lets the very next attempt through");
	owner.releaseAttempt(retry, {statusCode: 200});
	owner.finishLogical(retryLogical);
	assert.equal(owner.resetHealth("tk1:bad"), false, "reset reports nothing to clear once the key is healthy");
});

test("S5 5xx cooldown is per key bounded and healthy backup bypasses head-of-line blocking", async () => {
	let clock = 0;
	const owner = createHistoricalProviderBudgetOwner({capacity: 2, now: () => clock, serverCooldownMs: 1000});
	const failedLogical = owner.beginLogical({isCurrent: () => true});
	const failed = await owner.acquireAttempt(failedLogical, metrics({transportKey: "tk1:server-a"}));
	owner.releaseAttempt(failed, {statusCode: 503, errorClass: "server"});
	owner.finishLogical(failedLogical);
	const sameKey = owner.beginLogical({isCurrent: () => true});
	assert.deepEqual(await owner.acquireAttempt(sameKey, metrics({transportKey: "tk1:server-a"})), {granted: false, reason: "server_cooldown", retryAfterMs: 1000});
	const backupLogical = owner.beginLogical({isCurrent: () => true});
	const backup = await owner.acquireAttempt(backupLogical, metrics({transportKey: "tk1:server-b", role: "backup"}));
	assert.equal(backup.granted, true);
	owner.releaseAttempt(backup, {statusCode: 200});
	clock = 1000;
	const recovered = await owner.acquireAttempt(sameKey, metrics({transportKey: "tk1:server-a"}));
	assert.equal(recovered.granted, true);
	owner.releaseAttempt(recovered, {statusCode: 200});
	owner.finishLogical(sameKey);
	owner.finishLogical(backupLogical);
	assert.equal(owner.getSnapshot().serverCooldownCount, 1);
});

test("S6 captured-key capacity overrides are isolated and clear on restart", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4});
	const keyA = "tk1:s6-a", keyB = "tk1:s6-b";
	assert.equal(owner.setKeyCapacity(keyA, 1), true);
	assert.equal(owner.setKeyCapacity(keyB, 3), true);
	const logicals = Array.from({length: 6}, () => owner.beginLogical({isCurrent: () => true}));
	const requests = logicals.map((logical, index) => owner.acquireAttempt(logical, metrics({transportKey: index < 3 ? keyA : keyB, role: "primary"})));
	const active = await Promise.all([requests[0], requests[3], requests[4], requests[5]]);
	const snapshot = owner.getSnapshot();
	assert.equal(snapshot.capacityOverrideKeyCount, 2);
	assert.equal(snapshot.activeAttemptCount, 4, "A owns one slot and B owns three slots");
	const stopping = owner.stop();
	assert.equal(owner.getSnapshot().capacityOverrideKeyCount, 0);
	for (const lease of active) owner.releaseAttempt(lease);
	for (const logical of logicals) owner.cancelLogical(logical);
	await stopping;
	owner.start(4);
	assert.equal(owner.getSnapshot().capacityOverrideKeyCount, 0);
});
