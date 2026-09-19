const test = require("node:test");
const {assert, requireW1, planFor, exactBaseline, performance, p95} = require("../helpers/w1-compact-wire-test-kit");

test("W1 hard budgets reject without truncating or dispatching", () => {
	const w1 = requireW1(), base = exactBaseline();
	assert.equal(w1.buildCompactOrderRequest(base.plan, base.source, {maxBodyBytes: 100}).reason, "body-budget");
	assert.equal(w1.buildCompactOrderRequest(base.plan, base.source, {maxEstimatedTokens: 1}).reason, "token-budget");
	assert.equal(w1.buildCompactOrderRequest(base.plan, base.source, {attempt: 4, maxAttempts: 3}).reason, "attempt-budget");
	assert.equal(w1.buildCompactOrderRequest({source: "x", nodes: Array.from({length: 10_000}, (_, index) => ({id: `i${index}`,kind:"text",classification:"translate",raw:"x",sourceStart:index,sourceEnd:index+1}))}, "x", {}).reason, "item-budget");
});

test("W1 95B and 2000B single foreign messages omit context and meet source+512", () => {
	const w1 = requireW1();
	for (const source of ["A".repeat(95), "B".repeat(2000)]) {
		const request = w1.buildCompactOrderRequest(planFor(source), source, {});
		assert.equal(request.contextIncluded, false);
		assert.ok(request.bodyBytes <= Buffer.byteLength(source) + 512);
	}
});

test("W1 serializer remains bounded under repeat and reset-style reconstruction", () => {
	const w1 = requireW1(), base = exactBaseline(), identities = new Set();
	for (let round = 0; round < 100; round++) {
		const request = w1.buildCompactOrderRequest(base.plan, base.source, {});
		identities.add(request.mappingIdentity);
	}
	assert.equal(identities.size, 1);
});
