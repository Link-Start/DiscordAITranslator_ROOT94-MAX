const test = require("node:test");
const assert = require("node:assert/strict");
const {performance} = require("node:perf_hooks");
const {original14Markdown, targetBodyForeignTitle} = require("./fixtures/s8b-m0a-mixed-language-fixtures");
const {createTranslationPlanShadowStore} = require("../src/diagnostics/translation-plan-shadow-store");

const legacyExact = {0: "```text\n1:\n2:\n3:\n4:\n5:\n6:（提供题干/截图）\n7:\n8:\n9:\n10:\n11:\n12:\n13:\n14:\n```", 1: "“4-3”", 2: "Spouse/Dependent", 3: "GED", 4: "Non-Degree", 5: "Non-Degree", 6: "In-state", 7: "Out-of-state", 8: "Self-Pay"};

test("S8b M1b merges one stable plan across every received-body lane", () => {
	const store = createTranslationPlanShadowStore(); store.start();
	for (const lane of ["manual", "auto-single", "live-burst", "history-primary", "batch-repair", "item-repair", "reply"]) store.observe({source: original14Markdown, lane, targetLanguageId: "zh-CN", legacyHardSkip: false, legacyEligibility: "eligible", legacyProtectedSegments: legacyExact});
	const snapshot = store.getSnapshot(); assert.equal(snapshot.rowCount, 1); const row = snapshot.rows[0];
	assert.equal(row.eventCount, 7); assert.deepEqual(Object.keys(row.lanes), ["manual", "auto-single", "live-burst", "history-primary", "batch-repair", "item-repair", "reply"]);
	assert.equal(row.candidateHasTranslate, true); assert.equal(row.legacyPlaceholderOccurrences, 9); assert.equal(row.legacyProtectedCandidateTranslateCount, 7); assert.equal(row.alignedProtectedCount, 2);
	assert.equal(row.coveredCodeUnits, original14Markdown.length); assert.equal(row.coverageComplete, true); assert.match(row.planHash, /^ph1:/); assert.match(row.sourceIdentity, /^si1:/);
});

test("S8b M1b observes legacy skip versus candidate translate without changing either", () => {
	const store = createTranslationPlanShadowStore(); store.start(); store.observe({source: targetBodyForeignTitle, lane: "manual", targetLanguageId: "zh-CN", legacyHardSkip: true, legacyEligibility: "filtered", legacyProtectedSegments: {}});
	const row = store.getSnapshot().rows[0]; assert.equal(row.legacyHardSkip, true); assert.equal(row.candidateHasTranslate, true); assert.ok(row.diffReasons.includes("legacy-skip-candidate-translate"));
});

test("S8b M1b planner throw oversized and budget paths fail open into anonymous fallback counters", () => {
	let now = 0; const store = createTranslationPlanShadowStore({now: () => now, planner: source => {if (source === "throw") throw new Error("private raw error"); now += 10; return {source, sourceLength: source.length, nodes: [], contexts: [], plannerVersion: "fixture", sourceHash: "x"};}, budgetMs: 1}); store.start();
	assert.equal(store.observe({source: "throw", lane: "manual"}).fallbackReason, "planner-error");
	assert.equal(store.observe({source: "slow", lane: "manual"}).fallbackReason, "budget");
	const real = createTranslationPlanShadowStore(); real.start(); assert.equal(real.observe({source: "a".repeat(200001), lane: "manual"}).fallbackReason, "oversized");
	assert.equal(store.getSnapshot().resources.active, 0); assert.doesNotMatch(JSON.stringify(store.getSnapshot()), /private raw error|throw|slow/);
});

test("S8b M1b persistence is bounded private and one hundred lifecycle cycles zero resources", () => {
	let saved = null; const create = () => createTranslationPlanShadowStore({capacity: 8, load: () => saved, save: value => {saved = JSON.parse(JSON.stringify(value));}}); let store = create(); store.start();
	for (let index = 0; index < 20; index++) store.observe({source: `${original14Markdown}${index}`, lane: "manual", legacyProtectedSegments: legacyExact}); store.flush();
	assert.equal(saved.rows.length, 8); assert.ok(saved.evictedCount >= 12); const serialized = JSON.stringify(saved); assert.doesNotMatch(serialized, /Degree of Interest|Spouse\/Dependent|https?:|prompt|endpoint|authorization/i); assert.ok(Buffer.byteLength(serialized) < 1024 * 1024);
	for (let index = 0; index < 100; index++) {store.stop(); store = create(); store.start(); store.reset(); assert.deepEqual(store.getSnapshot().resources, {active: 0, pendingSave: false});}
});

test("S8b M1b shadow event and matrix throughput stay below 0.5ms", () => {
	const store = createTranslationPlanShadowStore(); store.start(); let started = performance.now();
	for (let index = 0; index < 1000; index++) store.observe({source: original14Markdown, lane: index % 2 ? "manual" : "auto-single", targetLanguageId: "zh-CN", legacyProtectedSegments: legacyExact});
	const eventAverageMs = (performance.now() - started) / 1000; started = performance.now(); for (let index = 0; index < 200; index++) store.getSnapshot(); const matrixAverageMs = (performance.now() - started) / 200;
	assert.ok(eventAverageMs < 0.5, JSON.stringify({eventAverageMs})); assert.ok(matrixAverageMs < 0.5, JSON.stringify({matrixAverageMs}));
});
