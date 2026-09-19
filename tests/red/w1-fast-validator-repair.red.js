const test = require("node:test");
const {assert, requireW1, planFor, validArray} = require("../helpers/w1-compact-wire-test-kit");

test("W1 repair request preserves dense child -> root ordinal -> stable ID mapping", () => {
	const w1 = requireW1(), source = "First\nSecond\nThird\nFourth", root = w1.buildCompactOrderRequest(planFor(source), source, {});
	const repair = w1.createOrdinalRepairRequest(root, [3, 1, 3], {parentSettled: true});
	assert.equal(repair.ok, true);
	assert.deepEqual(repair.mapping.map(row => row.localOrdinal), [0, 1]);
	assert.deepEqual(repair.mapping.map(row => row.rootOrdinal), [1, 3]);
	assert.deepEqual(repair.mapping.map(row => row.stableId), [root.mapping[1].stableId, root.mapping[3].stableId]);
	assert.deepEqual(JSON.parse(repair.wire).x, [root.mapping[1].text, root.mapping[3].text]);
});

test("W1 repair merges only failed stable IDs and never overwrites prior successes", () => {
	const w1 = requireW1(), source = "First\nSecond\nThird", root = w1.buildCompactOrderRequest(planFor(source), source, {}), initial = validArray(root);
	const prior = {[root.mapping[0].stableId]: initial[0], [root.mapping[2].stableId]: initial[2]};
	const repair = w1.createOrdinalRepairRequest(root, [1], {parentSettled: true}), parsed = w1.parseCompactOrderResponse(repair, JSON.stringify(["第二"]), {likelyTarget: () => true});
	const merged = w1.mergeCompactResults(root, prior, parsed.valid);
	assert.equal(merged[root.mapping[0].stableId], initial[0]);
	assert.equal(merged[root.mapping[1].stableId], "第二");
	assert.equal(merged[root.mapping[2].stableId], initial[2]);
	assert.equal(w1.createOrdinalRepairRequest(root, [99], {parentSettled: true}).reason, "unknown-index");
});

test("W1 reassembly preserves target text, line endings, combining characters and surrogate pairs", () => {
	const w1 = requireW1(), source = "中文\r\nCafe\u0301 😀\r\nمرحبا", root = w1.buildCompactOrderRequest(planFor(source), source, {}), rows = validArray(root, "译");
	rows[0] = "译e\u0301😀"; if (rows.length > 1) rows[1] = "阿拉伯译文";
	const parsed = w1.parseCompactOrderResponse(root, JSON.stringify(rows), {likelyTarget: () => true});
	const output = w1.reassembleCompactResponse(root, parsed.valid);
	assert.match(output, /^中文\r\n/);
	assert.equal((output.match(/\r\n/g) || []).length, 2);
	assert.equal(output.includes("e\u0301😀"), true);
	assert.equal(output.normalize("NFD"), output, "no hidden Unicode normalization");
});

test("W1 repair is exactly one merged application request or a terminal repair-budget", () => {
	const w1 = requireW1(), source = Array.from({length: 25}, (_, index) => `Failure item ${index}`).join("\n"), root = w1.buildCompactOrderRequest(planFor(source), source, {}), all = root.mapping.map(row => row.rootOrdinal);
	const one = w1.createOrdinalRepairRequests(root, all, {parentSettled: true});
	assert.equal(one.dispatchable, true);
	assert.equal(one.requests.length, 1);
	assert.equal(one.requests[0].mapping.length, 25);
	const denied = w1.createOrdinalRepairRequests(root, all, {parentSettled: true, maxItems: 10});
	assert.equal(denied.dispatchable, false);
	assert.equal(denied.reason, "repair-budget");
	assert.equal(denied.requests.length, 0);
});
