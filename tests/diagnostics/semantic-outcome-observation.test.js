const test = require("node:test");
const assert = require("node:assert/strict");

const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
const {createPluginHistoricalBatchPerformance} = require("../../src/diagnostics/historical-batch-performance-wiring");

const SEMANTIC_REASONS = Object.freeze([
	"malformed",
	"unknown-id",
	"duplicate-id",
	"missing-id",
	"empty",
	"placeholder-mismatch",
	"wrong-language",
	"too-similar",
	"attempt-budget",
	"body-budget",
	"token-budget",
	"capability-unverified",
	"unknown"
]);

function method(store, name) {
	assert.equal(typeof store[name], "function", `W0 provider-latency-store.${name} is not implemented`);
	return store[name].bind(store);
}

test("W0 semantic producer owns one bounded reason/fallback/budget vocabulary", () => {
	const store = createProviderLatencyStore();
	const recordSemanticObservation = method(store, "recordSemanticObservation");
	const getWireObservationSnapshot = method(store, "getWireObservationSnapshot");
	const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});

	for (const reason of SEMANTIC_REASONS)
		recordSemanticObservation({token, reason, count: 1});
	recordSemanticObservation({token, reason: "malformed", fallbackKind: "root-malformed", count: 1});
	recordSemanticObservation({token, reason: "unknown-id", fallbackKind: "root-schema-incompatible", count: 1});
	recordSemanticObservation({token, reason: "RAW_SECRET_REASON", fallbackKind: "RAW_SECRET_FALLBACK", count: 1});

	const snapshot = getWireObservationSnapshot();
	assert.equal(snapshot.schemaVersion, "w0-1");
	assert.equal(snapshot.generation, token.generation);
	assert.equal(snapshot.attemptCount, 0, "serializer/repair observations do not invent physical dispatches");
	for (const reason of SEMANTIC_REASONS)
		assert.ok(snapshot.repairReasonCounts[reason] >= 1, `missing fixed semantic reason counter: ${reason}`);
	assert.equal(snapshot.repairReasonCounts.unknown, 2, "unknown reason folds into the fixed unknown bucket");
	assert.deepEqual(snapshot.budgetCounts, {attempt: 1, body: 1, token: 1, capability: 1});
	assert.equal(snapshot.fallbackReasonCounts["root-malformed"], 1);
	assert.equal(snapshot.fallbackReasonCounts["root-schema-incompatible"], 1);
	assert.equal(snapshot.fallbackReasonCounts.unknown, 1);

	const serialized = JSON.stringify(snapshot);
	assert.doesNotMatch(serialized, /RAW_SECRET_REASON|RAW_SECRET_FALLBACK/);
	assert.deepEqual(
		Object.keys(snapshot.repairReasonCounts).sort(),
		SEMANTIC_REASONS.slice().sort(),
		"repair reason counters must stay a finite source-backed vocabulary"
	);
	assert.deepEqual(Object.keys(snapshot.budgetCounts).sort(), ["attempt", "body", "capability", "token"]);
});

test("W0 semantic counters share generation reset and reject late repair/fallback events", () => {
	const store = createProviderLatencyStore();
	const recordSemanticObservation = method(store, "recordSemanticObservation");
	const getWireObservationSnapshot = method(store, "getWireObservationSnapshot");
	const old = store.beginLatencyRequest({kind: "manual", lane: "manual"});
	recordSemanticObservation({token: old, reason: "missing-id", fallbackKind: "root-malformed", count: 1});
	store.resetLatency();

	assert.equal(
		recordSemanticObservation({token: old, reason: "body-budget", fallbackKind: "RAW_LATE_FALLBACK", count: 999}),
		null,
		"old-generation semantic event must be rejected"
	);
	const snapshot = getWireObservationSnapshot();
	assert.equal(snapshot.generation, old.generation + 1);
	assert.deepEqual(snapshot.repairReasonCounts, {});
	assert.deepEqual(snapshot.fallbackReasonCounts, {});
	assert.deepEqual(snapshot.budgetCounts, {attempt: 0, body: 0, token: 0, capability: 0});
	assert.doesNotMatch(JSON.stringify(snapshot), /RAW_LATE_FALLBACK/);
	assert.deepEqual(store.getLatencySnapshot().wireObservation, snapshot,
		"diagnostics and direct W0 access must expose the same schema, not parallel stores");
});

test("W0 historical validation reuses the dispatch token so a reset fences an old job reason", () => {
	const store = createProviderLatencyStore();
	const performance = createPluginHistoricalBatchPerformance({recordSemanticObservation: event => store.recordSemanticObservation(event)});
	const old = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});
	const prepared = {semanticRequest: {enabled: true}, wireObservationToken: old, message: {id: "private-message-id"}};
	store.resetLatency();
	performance.recordValidationReason({id: "private-job-id"}, prepared, "missing-id", {repairEligible: true, phase: "primary"});
	assert.deepEqual(store.getWireObservationSnapshot().repairReasonCounts, {});
	performance.stop();
});

test("S8 validation reasons with underscores land in their hyphenated wire counters, not in unknown", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});
	for (const reason of ["missing_id", "wrong_language", "too_similar", "same_as_source", "placeholder_missing", "policy_rejected"]) store.recordSemanticObservation({token, reason, count: 1});
	assert.deepEqual(store.getWireObservationSnapshot().repairReasonCounts, {"missing-id": 1, "wrong-language": 1, "too-similar": 2, "placeholder-mismatch": 1, unknown: 1});
	const performance = createPluginHistoricalBatchPerformance({recordSemanticObservation: event => store.recordSemanticObservation(event)});
	const prepared = {semanticRequest: {enabled: true}, wireObservationToken: token, message: {id: "private-message-id"}};
	performance.recordValidationReason({id: "private-job-id"}, prepared, "missing_id", {repairEligible: true, phase: "batch"});
	assert.equal(store.getWireObservationSnapshot().repairReasonCounts["missing-id"], 2, "the historical wiring maps the S8 name before recording");
	performance.stop();
});

test("batch answer shapes are counted under a closed vocabulary and reset with the generation", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});
	store.recordSemanticObservation({token, shapes: ["plan-nested", "alt-list"]});
	store.recordSemanticObservation({token, shape: "malformed-not-json"});
	store.recordSemanticObservation({token, shape: "RAW_SECRET_SHAPE"});
	const snapshot = store.getWireObservationSnapshot();
	assert.deepEqual(snapshot.batchShapeCounts, {"plan-nested": 1, "alt-list": 1, "malformed-not-json": 1, unknown: 1});
	assert.deepEqual(snapshot.repairReasonCounts, {}, "shapes are not repair reasons");
	assert.doesNotMatch(JSON.stringify(snapshot), /RAW_SECRET_SHAPE/);
	store.resetLatency();
	assert.deepEqual(store.getWireObservationSnapshot().batchShapeCounts, {});
});

test("batch structure observations are bounded, anonymous, immutable and fenced by reset", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});
	const dirty = {promptVersion: "typed-batch-v4", envelope: "messages", expectedMessageCount: 3, rowCount: 2, missingMessageCount: 1, malformed: null, fallbackStarted: false, rawResponse: "PRIVATE_TEXT", messageId: "PRIVATE_ID", requestId: "PRIVATE_ID"};
	for (let index = 0; index < 25; index++) store.recordSemanticObservation({token, batchAnswer: dirty});
	const snapshot = store.getWireObservationSnapshot();
	assert.equal(snapshot.batchAnswerCount, 25);
	assert.equal(snapshot.recentBatchAnswers.length, 20);
	assert.equal(snapshot.recentBatchAnswers[0].requestId, token.requestId);
	assert.equal(snapshot.recentBatchAnswers[0].missingMessageCount, 1);
	assert.equal(snapshot.recentBatchAnswers[0].promptVersion, "typed-batch-v4");
	assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|rawResponse|messageId/);
	assert.equal(Object.isFrozen(snapshot.recentBatchAnswers), true);
	assert.equal(Object.isFrozen(snapshot.recentBatchAnswers[0]), true);
	dirty.missingMessageCount = 999;
	assert.equal(snapshot.recentBatchAnswers[0].missingMessageCount, 1);
	store.resetLatency();
	assert.equal(store.recordSemanticObservation({token, batchAnswer: dirty}), null);
	assert.equal(store.getWireObservationSnapshot().batchAnswerCount, 0);
	assert.deepEqual(store.getWireObservationSnapshot().recentBatchAnswers, []);
});

test("recent successful batches do not erase the retained malformed answer", () => {
	const store = createProviderLatencyStore();
	const record = batchAnswer => {
		const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});
		store.recordSemanticObservation({token, batchAnswer: {promptVersion: "typed-batch-v4", expectedMessageCount: 10, ...batchAnswer}});
		return token.requestId;
	};
	const failureId = record({envelope: "segment-root", malformed: "malformed-segment-root", fallbackStarted: true, rootRowCount: 10, rootSegmentIdRowCount: 10});
	let latestId;
	for (let index = 0; index < 40; index++) latestId = record({envelope: "messages", parsedMessageCount: 10, recognizedMessageCount: 10});
	const snapshot = store.getWireObservationSnapshot();
	assert.equal(snapshot.batchAnswerCount, 41);
	assert.equal(snapshot.recentBatchAnswers.length, 20);
	assert.equal(snapshot.recentBatchAnswers[0].requestId, failureId);
	assert.equal(snapshot.recentBatchAnswers[0].rootSegmentIdRowCount, 10);
	assert.equal(snapshot.recentBatchAnswers.at(-1).requestId, latestId);
});

test("the same buffer retains the latest eight partial or malformed answers and recent successes", () => {
	const store = createProviderLatencyStore();
	for (let index = 0; index < 32; index++) {
		const token = store.beginLatencyRequest({kind: "historical"});
		store.recordSemanticObservation({token, batchAnswer: {envelope: "messages", expectedMessageCount: 10, ...(index < 6 ? {malformed: "malformed-empty-list"} : index < 12 ? {missingMessageCount: 1} : {parsedMessageCount: 10})}});
	}
	const snapshot = store.getWireObservationSnapshot();
	assert.equal(snapshot.batchAnswerCount, 32, "retention never changes the full-session denominator");
	assert.deepEqual(snapshot.recentBatchAnswers.map(row => row.requestId), [5, 6, 7, 8, 9, 10, 11, 12, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
	assert.equal(Object.isFrozen(snapshot.recentBatchAnswers), true);
	store.resetLatency();
	assert.deepEqual(store.getWireObservationSnapshot().recentBatchAnswers, []);
});
