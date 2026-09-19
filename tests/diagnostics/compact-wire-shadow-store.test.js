const test = require("node:test");
const assert = require("node:assert/strict");

const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
const {sanitizeCompactWireShadowDiagnostics, createAiLatencyDiagnosticsPayload, createDiagnosticsCopyPayload} = require("../../src/ui/settings-panel");

const SNAPSHOT_KEYS = Object.freeze(["schemaVersion", "generation", "contractRevision", "capacity", "count", "windowCount", "okCount", "identityMismatchCount", "budgetFailCount", "compileFailedCount", "prohibitedCount", "windowedCount", "windowedPermille", "bodyRatioPermille", "inputRatioPermille", "compileMicros", "typedBytes", "dBytes", "latest", "batches"]);
const RECORD_KEYS = Object.freeze(["schemaVersion", "contractRevision", "typedBytes", "typedPromptBytes", "typedEstimatedTokens", "typedSegmentCount", "dBytes", "dPromptBytes", "dEstimatedTokens", "dRangeCount", "bodyRatioPermille", "inputRatioPermille", "contextCoveragePermille", "translateCoveragePermille", "insertedBreaks", "prohibitedFieldCount", "compileMicros", "status", "failureReason", "identityMatch", "budgetOk", "windowed", "recordedAt"]);

function record(overrides = {}) {
	return Object.assign({schemaVersion: "w3-shadow-1", contractRevision: "whole-marker-v2.prompt-v3.validator-v2", status: "ok", failureReason: null, identityMatch: true, budgetOk: true, typedBytes: 1000, typedPromptBytes: 474, typedEstimatedTokens: 300, typedSegmentCount: 4, dBytes: 200, dPromptBytes: 399, dEstimatedTokens: 150, dRangeCount: 3, bodyRatioPermille: 200, inputRatioPermille: 406, windowed: false, contextCoveragePermille: 1000, translateCoveragePermille: 800, insertedBreaks: 0, prohibitedFieldCount: 0, compileMicros: 250}, overrides);
}

test("W3 shadow store keeps a bounded numeric window, closed enums and drops every unknown field", () => {
	let clock = 1000;
	const store = createProviderLatencyStore({now: () => clock});
	assert.equal(store.recordCompactWireShadow(null), false);
	assert.equal(store.recordCompactWireShadow({schemaVersion: "other"}), false);
	assert.equal(store.recordCompactWireShadow(record({source: "Degree of Interest", wire: "⟪1⟫secret", status: "weird", failureReason: "http://x", contractRevision: "Bad Label!", compileMicros: -5, dBytes: "12.9"})), true);
	const snapshot = store.getCompactWireShadowSnapshot();
	assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS.slice().sort());
	assert.deepEqual(Object.keys(snapshot.latest).sort(), RECORD_KEYS.slice().sort(), "unknown fields never reach the window");
	assert.equal(snapshot.latest.status, "compile-failed", "an unknown status falls to the closed failure value");
	assert.equal(snapshot.latest.failureReason, "unknown");
	assert.equal(snapshot.latest.contractRevision, null);
	assert.equal(snapshot.latest.compileMicros, 0);
	assert.equal(snapshot.latest.dBytes, 12);
	assert.equal(snapshot.latest.recordedAt, 1000);
	assert.doesNotMatch(JSON.stringify(snapshot), /Degree of Interest|secret|http/);
	for (let index = 0; index < 80; index++) {clock++; store.recordCompactWireShadow(record({typedBytes: 1000 + index, bodyRatioPermille: 100 + index, compileMicros: 100 + index, windowed: index % 4 === 0, prohibitedFieldCount: index === 3 ? 2 : 0}));}
	const bounded = store.getCompactWireShadowSnapshot();
	assert.equal(bounded.count, 81);
	assert.equal(bounded.windowCount, 64, "the window holds the newest 64 records");
	assert.equal(bounded.okCount, 80);
	assert.equal(bounded.compileFailedCount, 1);
	assert.equal(bounded.prohibitedCount, 1);
	assert.equal(bounded.windowedCount, 20);
	assert.equal(bounded.windowedPermille, 250);
	assert.equal(bounded.latest.typedBytes, 1079);
	assert.equal(bounded.bodyRatioPermille.count, 64);
	assert.equal(bounded.bodyRatioPermille.p50, 100 + 16 + 31, "quantiles come from the window, oldest rows evicted");
	assert.equal(bounded.compileMicros.max, 179);
	assert.ok(Object.isFrozen(bounded) && Object.isFrozen(bounded.latest) && Object.isFrozen(bounded.bodyRatioPermille));
});

test("W3 shadow store counts identity, budget and compile failures separately and sums batches", () => {
	const store = createProviderLatencyStore();
	store.recordCompactWireShadow(record({status: "identity-mismatch", identityMatch: false, dBytes: null, bodyRatioPermille: null}));
	store.recordCompactWireShadow(record({status: "budget", failureReason: "body-budget", budgetOk: false, bodyRatioPermille: null}));
	store.recordCompactWireShadow(record({status: "compile-failed", failureReason: "no-segments", budgetOk: null, bodyRatioPermille: null}));
	store.recordCompactWireShadow(record({bodyRatioPermille: 300}));
	const snapshot = store.getCompactWireShadowSnapshot();
	assert.equal(snapshot.count, 4);
	assert.equal(snapshot.okCount, 1);
	assert.equal(snapshot.identityMismatchCount, 1);
	assert.equal(snapshot.budgetFailCount, 1);
	assert.equal(snapshot.compileFailedCount, 1);
	assert.deepEqual(snapshot.bodyRatioPermille, {count: 1, p50: 300, p95: 300, max: 300}, "ratios only come from successful compiles");
	assert.equal(snapshot.dBytes, 200);
	assert.equal(store.recordCompactWireShadowBatch({schemaVersion: "w3-shadow-1", contractRevision: "whole-marker-v2.prompt-v3.validator-v2", itemCount: 3, shadowedCount: 3, okCount: 3, identityMismatchCount: 0, windowedCount: 1, typedBatchBytes: 2300, typedPromptBytes: 600, dBytesSum: 500, dPromptBytes: 399, bodyRatioPermille: 217, inputRatioPermille: 310, text: "leak"}), true);
	assert.equal(store.recordCompactWireShadowBatch({schemaVersion: "nope"}), false);
	const batches = store.getCompactWireShadowSnapshot().batches;
	assert.equal(batches.count, 1);
	assert.equal(batches.itemCount, 3);
	assert.equal(batches.typedBatchBytes, 2300);
	assert.equal(batches.dBytesSum, 500);
	assert.deepEqual(batches.bodyRatioPermille, {count: 1, p50: 217, p95: 217, max: 217});
	assert.equal(Object.prototype.hasOwnProperty.call(batches.latest, "text"), false);
	assert.equal(store.resetCompactWireShadow(), true);
	const cleared = store.getCompactWireShadowSnapshot();
	assert.equal(cleared.count, 0);
	assert.equal(cleared.latest, null);
	assert.equal(cleared.batches.count, 0);
	store.recordCompactWireShadow(record());
	store.resetLatency();
	assert.equal(store.getCompactWireShadowSnapshot().count, 0, "a latency reset clears the shadow too");
	assert.equal(store.getLatencySnapshot().compactWireShadow.schemaVersion, "w3-shadow-1");
});

test("W3 shadow diagnostics copy publishes fixed keys with counts and permille quantiles only", () => {
	const store = createProviderLatencyStore();
	store.recordCompactWireShadow(record({bodyRatioPermille: 180, compileMicros: 700}));
	store.recordCompactWireShadow(record({bodyRatioPermille: 220, compileMicros: 900, windowed: true}));
	store.recordCompactWireShadowBatch({schemaVersion: "w3-shadow-1", contractRevision: "whole-marker-v2.prompt-v3.validator-v2", itemCount: 3, shadowedCount: 3, okCount: 3, identityMismatchCount: 0, windowedCount: 0, typedBatchBytes: 2300, typedPromptBytes: 600, dBytesSum: 500, dPromptBytes: 399, bodyRatioPermille: 217, inputRatioPermille: 310});
	const snapshot = store.getLatencySnapshot();
	const safe = sanitizeCompactWireShadowDiagnostics(Object.assign({}, snapshot.compactWireShadow, {latest: {wire: "text"}, endpoint: "https://x", extra: 1}));
	assert.deepEqual(Object.keys(safe).sort(), ["batches", "bodyRatioPermille", "budgetFailCount", "compileFailedCount", "compileMicros", "contractRevision", "count", "dBytes", "identityMismatchCount", "inputRatioPermille", "okCount", "prohibitedCount", "schemaVersion", "typedBytes", "windowedCount", "windowedPermille"]);
	assert.equal(safe.count, 2);
	assert.equal(safe.windowedPermille, 500);
	assert.deepEqual(safe.bodyRatioPermille, {count: 2, p50: 180, p95: 220, max: 220});
	assert.deepEqual(safe.compileMicros, {count: 2, p50: 700, p95: 900, max: 900});
	assert.deepEqual(safe.batches, {count: 1, itemCount: 3, typedBatchBytes: 2300, dBytesSum: 500, bodyRatioPermille: {count: 1, p50: 217, p95: 217, max: 217}, inputRatioPermille: {count: 1, p50: 310, p95: 310, max: 310}});
	assert.doesNotMatch(JSON.stringify(safe), /text|https|extra|latest/);
	const payload = createDiagnosticsCopyPayload({plugin: "x"}, createAiLatencyDiagnosticsPayload(snapshot, {}));
	assert.deepEqual(payload.compactWireShadow, safe);
	assert.deepEqual(payload.aiPerformance.compactWireShadow, safe);
	assert.deepEqual(sanitizeCompactWireShadowDiagnostics(undefined).bodyRatioPermille, {count: 0, p50: null, p95: null, max: null});
	assert.equal(sanitizeCompactWireShadowDiagnostics(undefined).schemaVersion, null);
});
