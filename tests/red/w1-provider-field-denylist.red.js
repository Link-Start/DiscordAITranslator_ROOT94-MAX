const test = require("node:test");
const {assert, requireW1, planFor} = require("../helpers/w1-compact-wire-test-kit");

test("W1 inspector blocks internal keys and plugin identity shapes without false positives in user prose", () => {
	const w1 = requireW1(), legal = JSON.stringify({c: "schemaVersion direction are user words", x: ["translate id naturally"]});
	assert.equal(w1.inspectProviderWire(legal).ok, true);
	for (const key of ["id","segmentId","contextIds","contexts","schemaVersion","semanticRevision","plannerVersion","fieldPath","direction","sourceLength","document","sourceStart","sourceEnd","hash","classification","cacheKey","workloadKey"]) {
		const inspected = w1.inspectProviderWire(JSON.stringify({c: "ok", x: ["Hello"], [key]: "leak"}));
		assert.equal(inspected.ok, false, key);
		assert.ok(inspected.prohibitedKeys.includes(key), key);
	}
	for (const value of ["m3i-v1|received|body|52:74|a3668301", "ctx|m3i-v1|x", "swk1:deadbeef", "52:74|a3668301"]) assert.equal(w1.inspectProviderWire(JSON.stringify({x: [value]})).ok, false, value);
});

test("W1 serializer never emits plan internals", () => {
	const w1 = requireW1(), request = w1.buildCompactOrderRequest(planFor("# Degree\n- A. Graduate"), "# Degree\n- A. Graduate", {}), wire = request.wire;
	assert.equal(request.ok, true);
	assert.equal(w1.inspectProviderWire(wire).ok, true);
	for (const secret of ["m3i-v1|", "ctx|", "schemaVersion", "semanticRevision", "plannerVersion", "sourceStart", "classification", "swk1:"]) assert.equal(wire.includes(secret), false, secret);
});

test("W1 inspector rejects prototype pollution, deep structure and oversized input", () => {
	const w1 = requireW1();
	assert.equal(w1.inspectProviderWire('{"x":["ok"],"__proto__":{"polluted":true}}').ok, false);
	let deep = "x"; for (let i = 0; i < 40; i++) deep = [deep];
	assert.equal(w1.inspectProviderWire({x: deep}).ok, false);
	assert.equal(w1.buildCompactOrderRequest(planFor("A".repeat(1024 * 1024)), "A".repeat(1024 * 1024), {}).reason, "source-budget");
});
