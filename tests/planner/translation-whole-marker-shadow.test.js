const test = require("node:test");
const assert = require("node:assert/strict");

const {createProtectionLogic, MESSAGE_PLACES} = require("../../src/protection/protection-logic");
const {createSemanticRequest, attachSemanticLocalState} = require("../../src/planner/translation-semantic-runtime");
const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
const {WHOLE_MARKER_CONTRACT_REVISION, WHOLE_MARKER_VERSION, WHOLE_MARKER_PROMPT_VERSION, WHOLE_MARKER_VALIDATOR_VERSION} = require("../../src/planner/translation-whole-marker-wire");
const {W2_ALL_FIXTURES} = require("../../src/diagnostics/w2-wire-benchmark-fixtures");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");
const {SHADOW_SCHEMA_VERSION, SHADOW_STATUSES, SHADOW_FAILURE_REASONS, compileTypedRequestShadow, lookupTypedRequestShadow, summarizeTypedBatchShadow} = require("../../src/planner/translation-whole-marker-shadow");
const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");

const RECORD_FIELDS = Object.freeze(["schemaVersion", "contractRevision", "status", "failureReason", "identityMatch", "budgetOk", "typedBytes", "typedPromptBytes", "typedEstimatedTokens", "typedSegmentCount", "dBytes", "dPromptBytes", "dEstimatedTokens", "dRangeCount", "bodyRatioPermille", "inputRatioPermille", "windowed", "contextCoveragePermille", "translateCoveragePermille", "insertedBreaks", "prohibitedFieldCount", "compileMicros"]);
const plugin = {settings: {exceptions: {wordStart: ["!"], protectedTerms: ["Longma"], wrapperPairs: ['"|"'], protectedTermsForReceived: true, wrapperPairsForReceived: true}}, getProtectedWrapperRules() {return [];}};
const logic = createProtectionLogic();

function typedFor(source, targetLanguageId = "zh-CN") {
	const protection = logic.prepareSemanticSource(plugin, source, MESSAGE_PLACES.RECEIVED);
	const request = createSemanticRequest({engineKey: "oaicompat", source: protection.source, direction: "received", fieldPath: "body", inputLanguageId: "auto", targetLanguageId});
	attachSemanticLocalState(request, {protectedSegments: protection.protectedSegments, cachePlanHash: "x"});
	return {protection, request};
}

test("W3 shadow compiles every W2 fixture from the typed request's own source with numbers only", () => {
	for (const fixture of W2_ALL_FIXTURES) {
		const {protection, request} = typedFor(fixture.source, fixture.targetLanguageId);
		assert.equal(request.enabled, true, fixture.id);
		const record = compileTypedRequestShadow({request, source: request.plan.source, protectedSegments: protection.protectedSegments});
		assert.ok(Object.isFrozen(record));
		assert.deepEqual(Object.keys(record).sort(), RECORD_FIELDS.slice().sort(), fixture.id);
		assert.equal(record.schemaVersion, SHADOW_SCHEMA_VERSION);
		assert.equal(record.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
		assert.equal(record.status, "ok", `${fixture.id} ${record.failureReason}`);
		assert.equal(record.identityMatch, true);
		assert.equal(record.budgetOk, true);
		assert.equal(record.typedBytes, request.bodyBytes);
		assert.equal(record.typedPromptBytes, Buffer.byteLength(request.systemPrompt));
		assert.equal(record.typedSegmentCount, request.segmentOrder.length);
		assert.ok(record.dBytes > 0 && record.dPromptBytes > 0 && record.dRangeCount > 0, fixture.id);
		assert.equal(record.bodyRatioPermille, Math.round(1000 * record.dBytes / record.typedBytes));
		assert.equal(record.inputRatioPermille, Math.round(1000 * (record.dBytes + record.dPromptBytes) / (record.typedBytes + record.typedPromptBytes)));
		assert.equal(record.prohibitedFieldCount, 0, `${fixture.id} leaks typed structure into the D wire`);
		assert.equal(record.windowed, fixture.id === "f04-target-body-title" || fixture.id === "f13-long-chinese-one-english", fixture.id);
		assert.ok(record.contextCoveragePermille >= 0 && record.contextCoveragePermille <= 1000);
		assert.ok(Number.isInteger(record.compileMicros) && record.compileMicros >= 0);
		for (const value of Object.values(record)) assert.ok(value === null || typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && /^[a-z0-9_.:-]{1,48}$/.test(value)), `${fixture.id} ${String(value).slice(0, 20)}`);
		const serialized = JSON.stringify(Object.values(record));
		for (const word of fixture.source.split(/\s+/).filter(word => /^[\p{L}\p{N}]{6,}$/u.test(word)).slice(0, 12)) assert.equal(serialized.includes(word), false, `${fixture.id} record carries source text: ${word}`);
		assert.equal(lookupTypedRequestShadow(request), record);
	}
	assert.deepEqual(SHADOW_STATUSES, ["ok", "identity-mismatch", "budget", "compile-failed"]);
	assert.ok(SHADOW_FAILURE_REASONS.includes("unknown"));
});

test("W3 shadow input identity is the typed plan's hash: a different source, plan or target stops the shadow before compiling", () => {
	const {protection, request} = typedFor(original14Markdown);
	const drifted = compileTypedRequestShadow({request, source: request.plan.source + " ", protectedSegments: protection.protectedSegments});
	assert.equal(drifted.status, "identity-mismatch");
	assert.equal(drifted.identityMatch, false);
	assert.equal(drifted.dBytes, null, "no D compile after an identity mismatch");
	assert.equal(drifted.typedBytes, request.bodyBytes);
	const otherTarget = Object.freeze(Object.assign({}, request, {targetLanguageId: "ja"}));
	assert.equal(compileTypedRequestShadow({request: otherTarget, source: request.plan.source, protectedSegments: protection.protectedSegments}).status, "identity-mismatch");
	const stalePlan = Object.freeze(Object.assign({}, request, {plan: Object.assign({}, request.plan, {plannerVersion: "m3i-v1"})}));
	assert.equal(compileTypedRequestShadow({request: stalePlan, source: request.plan.source, protectedSegments: protection.protectedSegments}).status, "identity-mismatch");
	assert.equal(compileTypedRequestShadow({request: Object.freeze(Object.assign({}, request, {adapter: "classic-marked"})), source: request.plan.source}), null, "classic adapters are never shadowed");
	assert.equal(compileTypedRequestShadow({request: Object.freeze({enabled: false}), source: ""}), null);
	assert.equal(compileTypedRequestShadow({}), null);
});

test("W3 shadow reports a D compile failure as a closed reason and never throws", () => {
	const plan = planReceivedMarkdown("https://example.invalid/only-a-link", {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	const request = Object.freeze({enabled: true, adapter: "typed-json", plan, targetLanguageId: "zh-CN", wire: "{}", bodyBytes: 2, systemPrompt: "x", estimatedTokens: 1, segmentOrder: Object.freeze([])});
	const record = compileTypedRequestShadow({request, source: plan.source, protectedSegments: {}});
	assert.equal(record.status, "compile-failed");
	assert.equal(record.failureReason, "no-segments");
	assert.equal(record.identityMatch, true);
	assert.equal(record.dBytes, null);
	const broken = Object.freeze({enabled: true, adapter: "typed-json", plan: Object.freeze({sourceHash: "00000000", sourceLength: 0, plannerVersion: "m3i-v2"}), targetLanguageId: "zh-CN", wire: "", bodyBytes: 0, systemPrompt: "", estimatedTokens: 0, segmentOrder: Object.freeze([])});
	assert.doesNotThrow(() => compileTypedRequestShadow({request: broken, source: null}));
	assert.equal(compileTypedRequestShadow({request: broken, source: null}).status, "identity-mismatch");
});

test("W3 shadow sums a history batch from its per-message records and reports typed batch bytes against them", () => {
	const items = ["Financial Aid requirement one for an international application.", "Financial Aid requirement two for an international application.", "Financial Aid requirement three for an international application."].map(source => typedFor(source));
	for (const item of items) compileTypedRequestShadow({request: item.request, source: item.request.plan.source, protectedSegments: item.protection.protectedSegments});
	const typedBatchBytes = items.reduce((total, item) => total + item.request.bodyBytes, 0) + 120;
	const summary = summarizeTypedBatchShadow({requests: items.map(item => item.request), typedBatchBytes, typedPromptBytes: 500});
	assert.equal(summary.schemaVersion, SHADOW_SCHEMA_VERSION);
	assert.equal(summary.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
	assert.equal(summary.itemCount, 3);
	assert.equal(summary.shadowedCount, 3);
	assert.equal(summary.okCount, 3);
	assert.equal(summary.identityMismatchCount, 0);
	assert.equal(summary.typedBatchBytes, typedBatchBytes);
	assert.equal(summary.typedPromptBytes, 500);
	assert.equal(summary.dBytesSum, items.reduce((total, item) => total + lookupTypedRequestShadow(item.request).dBytes, 0));
	assert.equal(summary.dPromptBytes, Math.max(...items.map(item => lookupTypedRequestShadow(item.request).dPromptBytes)));
	assert.equal(summary.bodyRatioPermille, Math.round(1000 * summary.dBytesSum / typedBatchBytes));
	assert.equal(summary.inputRatioPermille, Math.round(1000 * (summary.dBytesSum + summary.dPromptBytes) / (typedBatchBytes + 500)));
	assert.equal(summarizeTypedBatchShadow({requests: [typedFor("Unshadowed message text here.").request], typedBatchBytes: 10}), null, "a batch with no shadowed item records nothing");
	const mixed = summarizeTypedBatchShadow({requests: items.map(item => item.request).concat([typedFor("Another unshadowed message.").request]), typedBatchBytes});
	assert.equal(mixed.itemCount, 4);
	assert.equal(mixed.shadowedCount, 3);
});

test("W3 contract revision closes wire, prompt and validator versions in one label", () => {
	assert.equal(WHOLE_MARKER_CONTRACT_REVISION, `${WHOLE_MARKER_VERSION}.prompt-v3.validator-v2`);
	assert.equal(WHOLE_MARKER_PROMPT_VERSION, "w3-whole-marker-prompt-v3");
	assert.equal(WHOLE_MARKER_VALIDATOR_VERSION, "w2c-whole-marker-validator-v2");
	const store = createProviderLatencyStore();
	const {protection, request} = typedFor(original14Markdown);
	store.recordCompactWireShadow(compileTypedRequestShadow({request, source: request.plan.source, protectedSegments: protection.protectedSegments}));
	assert.equal(store.getCompactWireShadowSnapshot().contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
	assert.equal(store.getCompactWireShadowSnapshot().latest.contractRevision, WHOLE_MARKER_CONTRACT_REVISION);
});
