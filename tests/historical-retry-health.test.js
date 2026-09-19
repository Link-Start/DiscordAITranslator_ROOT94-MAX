const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createHistoricalProviderBudgetOwner} = require(process.env.DTA_OWNER_PATH ? path.resolve(process.env.DTA_OWNER_PATH) : "../src/orchestrator/historical-provider-budget-owner");
const request = key => ({transportKey: key, role: "primary", itemCount: 1, bodyBytes: 100});
const pending = async promise => {let settled = false; promise.then(() => {settled = true;}); await new Promise(resolve => setImmediate(resolve)); return !settled;};
async function seed(owner, key, outcome) {const token = owner.beginLogical(); const lease = await owner.acquireAttempt(token, request(key)); assert.equal(lease.granted, true); owner.releaseAttempt(lease, outcome); owner.finishLogical(token);}

test("2b explicit key probe retains cap1 and failure streak without changing another key's Retry-After", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => 1000});
	await seed(owner, "tk1:retry-a", {statusCode: 401, errorClass: "auth"});
	await seed(owner, "tk1:limited-b", {statusCode: 429, errorClass: "rate_limit", retryAfterMs: 9000});
	try {
		assert.equal(owner.resetHealth("tk1:retry-a"), true);
		assert.equal(owner.getSnapshot().recoveryKeyCount, 1, "explicit retry opens a probe; it does not declare the provider healthy");
		const a = owner.beginLogical(), b = owner.beginLogical(), other = owner.beginLogical();
		assert.deepEqual(await owner.acquireAttempt(other, request("tk1:limited-b")), {granted: false, reason: "rate_limit", retryAfterMs: 9000});
		const first = await owner.acquireAttempt(a, request("tk1:retry-a"));
		const sibling = owner.acquireAttempt(b, request("tk1:retry-a"));
		assert.equal(await pending(sibling), true);
		assert.equal(owner.resetHealth("tk1:retry-a"), false, "repeat reset does not grant a second in-flight probe");
		owner.releaseAttempt(first, {statusCode: 401, errorClass: "auth"});
		assert.deepEqual(await sibling, {granted: false, reason: "provider_unhealthy", retryAfterMs: 30000});
		for (const token of [a, b, other]) owner.finishLogical(token);
		assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	} finally {await owner.stop();}
});

for (const late of [{statusCode: 401, errorClass: "auth"}, {statusCode: 503, errorClass: "server"}, {statusCode: 200}]) test(`2b an in-flight ${late.statusCode} after 429 cannot erase the server deadline during retry`, async () => {
	let clock = 1000;
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => clock});
	const a = owner.beginLogical(), b = owner.beginLogical(), denied = owner.beginLogical();
	const first = await owner.acquireAttempt(a, request("tk1:overlap")), second = await owner.acquireAttempt(b, request("tk1:overlap"));
	owner.releaseAttempt(first, {statusCode: 429, errorClass: "rate_limit", retryAfterMs: 9000});
	owner.releaseAttempt(second, late);
	owner.resetHealth("tk1:overlap");
	const during = await owner.acquireAttempt(denied, request("tk1:overlap"));
	if (during.granted) owner.releaseAttempt(during);
	for (const token of [a, b, denied]) owner.finishLogical(token);
	assert.equal(during.granted, false, "valid Retry-After remains authoritative despite a later overlapping outcome");
	assert.equal(during.retryAfterMs, 9000);
	clock = 10000;
	owner.resetHealth("tk1:overlap");
	const c = owner.beginLogical(), d = owner.beginLogical();
	const probe = await owner.acquireAttempt(c, request("tk1:overlap"));
	const sibling = owner.acquireAttempt(d, request("tk1:overlap"));
	const wasPending = await pending(sibling);
	owner.releaseAttempt(probe, {statusCode: 200});
	const next = await sibling;
	owner.releaseAttempt(next, {statusCode: 200});
	for (const token of [c, d]) owner.finishLogical(token);
	assert.equal(wasPending, true, "window expiry still leaves one recovery probe");
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	await owner.stop();
});

test("2b absent, invalid and rate-limited keys are not reset; adaptive caps remain owned by S6", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => 1000});
	await seed(owner, "tk1:auth", {statusCode: 401, errorClass: "auth"});
	await seed(owner, "tk1:limited", {statusCode: 429, errorClass: "rate_limit", retryAfterMs: 7000});
	owner.setKeyCapacity("tk1:auth", 1);
	for (const key of [undefined, null, "", "invalid", "tk1:missing", "tk1:limited"]) assert.equal(owner.resetHealth(key), false);
	for (const [key, reason, delay] of [["tk1:auth", "provider_unhealthy", 15000], ["tk1:limited", "rate_limit", 7000]]) {
		const token = owner.beginLogical();
		assert.deepEqual(await owner.acquireAttempt(token, request(key)), {granted: false, reason, retryAfterMs: delay});
		owner.finishLogical(token);
	}
	assert.equal(owner.getSnapshot().capacityOverrideKeyCount, 1);
	await owner.stop();
});

test("2b probe authorization is applied only after logical and request budgets pass", async () => {
	const owner = createHistoricalProviderBudgetOwner({capacity: 4, now: () => 1000});
	await seed(owner, "tk1:guarded", {statusCode: 401, errorClass: "auth"});
	const token = owner.beginLogical();
	const oversized = await owner.acquireAttempt(token, {...request("tk1:guarded"), itemCount: 11, probeHealth: true});
	assert.deepEqual(oversized, {granted: false, reason: "request_budget", exceeded: ["items"]});
	assert.equal(owner.getSnapshot().cooldownKeyCount, 1, "budget-denied work does not alter health");
	for (let index = 0; index < 3; index++) {const lease = await owner.acquireAttempt(token, request("tk1:healthy")); owner.releaseAttempt(lease, {statusCode: 200});}
	assert.deepEqual(await owner.acquireAttempt(token, {...request("tk1:guarded"), probeHealth: true}), {granted: false, reason: "attempt_budget"});
	owner.finishLogical(token);
	assert.deepEqual(await owner.acquireAttempt(token, {...request("tk1:guarded"), probeHealth: true}), {granted: false, reason: "cancelled"});
	assert.equal(owner.getSnapshot().cooldownKeyCount, 1);
	const fresh = owner.beginLogical();
	const probe = await owner.acquireAttempt(fresh, {...request("tk1:guarded"), probeHealth: true});
	assert.equal(probe.granted, true);
	assert.equal(owner.getSnapshot().recoveryKeyCount, 1);
	owner.releaseAttempt(probe, {statusCode: 200}); owner.finishLogical(fresh);
	assert.deepEqual(owner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	await owner.stop();
});
