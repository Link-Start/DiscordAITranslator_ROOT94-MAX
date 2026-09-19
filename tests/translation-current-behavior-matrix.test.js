const test = require("node:test");
const assert = require("node:assert/strict");
const {createTranslationCurrentBehaviorMatrix, buildMatrixRowsFromTerminalLedger} = require("../src/diagnostics/translation-current-behavior-matrix");
const {createTranslationTerminalLedger, LEDGER_SCHEMA_VERSION} = require("../src/diagnostics/translation-terminal-ledger");

const complete = overrides => Object.assign({
	matrixId: "manual-custom", entry: "manual-click", eligibility: "eligible", sourceFilterReason: null,
	lane: "manual", laneTags: {manual: 1}, shape: "text", engineFamily: "custom", decisionApplied: false,
	promptFamily: "single-manual", validatorFamily: "manual-received", placeholderOccurrences: 9,
	ruleCounts: {"fenced-code": 1, "configured-or-wrapper": 1, "auto-slash-token": 1, "auto-uppercase-token": 1, "auto-hyphen-token": 5},
	cacheRead: "miss", cacheWrite: "translation", outcome: "translated", stage: "display-currentness", reason: "manual_applied",
	providerDispatchCount: 1, providerRoles: {primary: 1}, request: {providerFamily: "custom", role: "primary", promptFamily: "single-manual", bodyBytes: 4639, bodyIdentity: "bi1:0123456789abcdef0123"},
	repairTrajectory: [], displayCommit: "applied"
}, overrides || {});

test("S8b M0b matrix keeps every required current-behavior field and separates desired", () => {
	const desired = Object.freeze({naturalLanguageOptionsTranslate: true});
	const matrix = createTranslationCurrentBehaviorMatrix([complete(), complete({matrixId: "self-authored", entry: "received-auto", eligibility: "filtered", sourceFilterReason: "self_authored", lane: "none", engineFamily: "none", promptFamily: "none", validatorFamily: "received-filter", placeholderOccurrences: 0, ruleCounts: {}, cacheRead: "none", cacheWrite: "none", outcome: "skipped", stage: "precheck", reason: "self_authored", providerDispatchCount: 0, providerRoles: {}, request: {providerFamily: "none", role: null, promptFamily: "none", bodyBytes: null, bodyIdentity: null}, displayCommit: "not_entered"})], {desired});
	assert.equal(matrix.schemaVersion, 1); assert.equal(matrix.rowCount, 2); assert.equal(matrix.desiredIncluded, false);
	for (const key of ["entry", "eligibility", "sourceFilterReason", "lane", "laneTags", "shape", "engineFamily", "decisionApplied", "promptFamily", "validatorFamily", "placeholderOccurrences", "ruleCounts", "cacheRead", "cacheWrite", "outcome", "stage", "reason", "providerDispatchCount", "providerRoles", "request", "repairTrajectory", "displayCommit"]) assert.ok(Object.hasOwn(matrix.rows[0], key), key);
	assert.equal(JSON.stringify(matrix).includes("naturalLanguageOptionsTranslate"), false);
});

test("S8b M0b matrix is bounded, merges identical cells and rejects private payload fields", () => {
	const rows = Array.from({length: 90}, (_, index) => complete({matrixId: `cell-${index}`, request: {providerFamily: "custom", role: "primary", promptFamily: "single-manual", bodyBytes: index, bodyIdentity: `bi1:${String(index).padStart(20, "0")}`}, privateText: "Degree of Interest", endpoint: "https://secret.invalid", prompt: "private"}));
	rows.push(complete({matrixId: "cell-0"}));
	const matrix = createTranslationCurrentBehaviorMatrix(rows, {limit: 48});
	assert.equal(matrix.rowCount, 48); assert.equal(matrix.evictedRowCount, 42);
	const serialized = JSON.stringify(matrix); assert.doesNotMatch(serialized, /Degree of Interest|secret\.invalid|private/); assert.ok(Buffer.byteLength(serialized) < 1024 * 1024);
});

test("S8b M3f ledger v4 counts physical dispatch roles and migrates v1 routes", () => {
	let saved = {schemaVersion: 1, sequence: 1, routes: [{routeId: "rt1:1", startedAt: 1, durationMs: 1, lane: "manual", laneTags: {manual: 1}, shape: "text", engineFamily: "custom", decisionApplied: false, promptFamily: "single-manual", validatorFamily: "manual-received", placeholderOccurrences: 9, ruleCounts: {"auto-hyphen-token": 5}, cacheRead: "miss", cacheWrite: "translation", outcome: "translated", stage: "display-currentness", reason: "manual_applied", timingMs: 0}]};
	const ledger = createTranslationTerminalLedger({now: () => 10, load: () => saved, save: value => {saved = value;}}); ledger.start();
	assert.equal(LEDGER_SCHEMA_VERSION, 5); assert.equal(ledger.getSnapshot().recent[0].providerDispatchCount, 0);
	const route = ledger.begin({lane: "auto-single", entry: "received-auto", eligibility: "eligible"});
	ledger.stage(route, "provider", "dispatch", {providerRole: "primary", requestFamily: "single-text", requestBodyBytes: 99, requestBodyIdentity: "bi1:0123456789abcdef0123"});
	ledger.stage(route, "provider", "dispatch", {providerRole: "backup"});
	ledger.terminal(route, {outcome: "failed", stage: "provider", reason: "timeout", displayCommit: "failed"}); ledger.flush();
	const item = ledger.getSnapshot().recent.at(-1);
	assert.equal(item.entry, "received-auto"); assert.equal(item.eligibility, "eligible"); assert.equal(item.providerDispatchCount, 2); assert.deepEqual(item.providerRoles, {primary: 1, backup: 1});
	assert.equal(item.requestBodyBytes, 99); assert.equal(item.requestBodyIdentity, "bi1:0123456789abcdef0123"); assert.equal(saved.schemaVersion, 5);
});

test("S8b M0b derives a production matrix from the bounded terminal ledger", () => {
	const ledger = createTranslationTerminalLedger(); ledger.start(); const route = ledger.begin({lane: "history-primary", entry: "historical-load", eligibility: "eligible"});
	ledger.stage(route, "protection", "rules_applied", {placeholderOccurrences: 9, ruleCounts: {"fenced-code": 1, "configured-or-wrapper": 1, "auto-slash-token": 1, "auto-uppercase-token": 1, "auto-hyphen-token": 5}});
	ledger.stage(route, "provider", "dispatch", {providerRole: "primary", engineFamily: "custom", decisionApplied: false, promptFamily: "batch-json", validatorFamily: "history-batch"});
	ledger.stage(route, "repair", "batch_repair", {laneTag: "batch-repair", providerDispatch: true, providerRole: "repair"});
	ledger.terminal(route, {outcome: "translated", stage: "display-currentness", reason: "committed", displayCommit: "atomic"});
	const rows = buildMatrixRowsFromTerminalLedger(ledger.getSnapshot());
	assert.equal(rows.length, 1); assert.equal(rows[0].providerDispatchCount, 2); assert.deepEqual(rows[0].repairTrajectory, [{role: "batch-repair", count: 1}]); assert.equal(rows[0].displayCommit, "atomic");
});

test("S8b M0b checked-in generator emits the complete fourteen-cell current matrix", () => {
	const result = require("../scripts/generate-s8b-m0b-current-matrix").build();
	assert.equal(result.matrix.rowCount, 14); assert.equal(result.fixture.placeholderOccurrences, 9); assert.equal(result.fixture.naturalLanguageProtectedOccurrences, 7); assert.equal(result.interpretation.selfAuthoredExplainsScreenshot, false);
	for (const lane of ["manual", "auto-single", "live-burst", "history-primary", "item-repair", "reply", "sent", "cache-hit"]) assert.ok(result.matrix.rows.some(row => row.lane === lane), lane);
	assert.ok(result.matrix.rows.some(row => row.laneTags["batch-repair"] === 1)); assert.ok(result.matrix.rows.some(row => row.laneTags["embed-forward"] === 1));
});
