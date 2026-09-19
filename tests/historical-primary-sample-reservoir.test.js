const test = require("node:test");
const assert = require("node:assert/strict");
const {performance} = require("node:perf_hooks");
const {
	HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION,
	HISTORICAL_PRIMARY_SAMPLE_CAPACITY,
	HISTORICAL_VALIDATION_REASONS,
	createHistoricalPrimarySampleReservoir
} = require("../src/diagnostics/historical-primary-sample-reservoir");

const contract = (suffix = "a") => ({transportKey: `tk1:${suffix}`, workloadKey: `wk1:${suffix}`});

test("semantic validation labels enter the existing historical categories and survive reload", () => {
	let saved;
	const store = createHistoricalPrimarySampleReservoir({load: () => saved, save: value => {saved = structuredClone(value);}});
	store.start();
	const aliases = {"wrong-language": "wrong_language", "missing-id": "missing_id", "placeholder-mismatch": "placeholder_missing", "too-similar": "too_similar"};
	for (const [index, [reason, expected]] of Object.entries(aliases).entries()) {
		recordPrimary(store, index);
		assert.equal(store.recordValidation({jobKey: `job-${index}`, messageId: `m-${index}`, reason, repairEligible: true}), expected);
	}
	store.recordValidation({reason: "unrecognized-provider-detail"});
	store.flush();
	store.stop();
	store.start();
	const snapshot = store.getSnapshot();
	for (const reason of Object.values(aliases)) assert.equal(snapshot.validationReasons[reason], 1, reason);
	assert.equal(snapshot.validationReasons.unknown, 1);
	assert.equal(snapshot.contaminatedPrimaryCount, 4);
	assert.deepEqual(snapshot.repairs, {batchRequests: 0, batchMessages: 0, itemRequests: 0, itemMessages: 0});
	store.stop();
});

function recordPrimary(store, index, {suffix = "a", durationMs = 100 + index, failureKind = null, liveOverlap = false, cancelled = false} = {}) {
	const token = store.beginPrimary({jobKey: `job-${index}`, blockIndex: index, messageIds: [`m-${index}`], itemCount: 1, protectedChars: 100 + index, effectiveCap: 2, wave: 0});
	store.recordContract(token, Object.assign(contract(suffix), {bodyBytes: 1000 + index, promptChars: 800, inputChars: 100 + index}));
	store.recordSettle(token, {durationMs, outputChars: 30, usage: index % 2 ? null : {promptTokens: 10, completionTokens: 5, reasoningTokens: null}, httpStatus: failureKind ? 500 : 200, finishReason: failureKind ? null : "stop", status: failureKind ? "http_500" : "ok"});
	store.recordOutcome(token, {failureKind, liveOverlap, cancelled});
	return token;
}

test("S8a reservoir persists bounded anonymous numeric samples across restart with TTL eviction", () => {
	let saved = null, now = 1_000;
	const create = () => createHistoricalPrimarySampleReservoir({load: () => saved, save: value => {saved = JSON.parse(JSON.stringify(value));}, now: () => now, capacity: 3, ttlMs: 100});
	let store = create();
	store.start();
	for (let index = 0; index < 4; index++) recordPrimary(store, index);
	store.flush();
	assert.equal(saved.schemaVersion, HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION);
	assert.equal(saved.samples.length, 3);
	assert.equal(saved.evictedCount, 1);
	store.stop();

	store = create();
	store.start();
	assert.equal(store.getSnapshot().sampleCount, 3);
	now += 101;
	assert.equal(store.getSnapshot().sampleCount, 0);
	assert.equal(store.getSnapshot().expiredCount, 3);
	assert.deepEqual(store.getSnapshot().resources, {openSamples: 0, messageLinks: 0, pendingSave: false});
});

test("S8a validation reasons contaminate training without changing the retained risk denominator", () => {
	const store = createHistoricalPrimarySampleReservoir();
	store.start();
	for (let index = 0; index < HISTORICAL_VALIDATION_REASONS.length; index++) {
		recordPrimary(store, index);
		store.recordValidation({jobKey: `job-${index}`, messageId: `m-${index}`, reason: HISTORICAL_VALIDATION_REASONS[index], repairEligible: index % 2 === 0, phase: "primary"});
	}
	store.recordRepair({jobKey: "job-0", mode: "batch", messageCount: 1});
	store.recordRepair({jobKey: "job-0", mode: "item", messageCount: 1});
	store.recordFinal("job-0", {translatedIds: ["m-0"], skippedIds: [], failedIds: []});
	const snapshot = store.getSnapshot();
	assert.equal(snapshot.sampleCount, HISTORICAL_VALIDATION_REASONS.length);
	assert.equal(snapshot.trainingSampleCount, 0);
	assert.equal(snapshot.contaminatedPrimaryCount, HISTORICAL_VALIDATION_REASONS.length);
	for (const reason of HISTORICAL_VALIDATION_REASONS) assert.equal(snapshot.validationReasons[reason], 1, reason);
	assert.equal(snapshot.validationReasonSuggestions.missing_id, "retryable_candidate");
	assert.equal(snapshot.validationReasonSuggestions.too_similar, "terminal_candidate");
	assert.deepEqual(snapshot.repairs, {batchRequests: 1, batchMessages: 1, itemRequests: 1, itemMessages: 1});
	assert.equal(snapshot.finalOutcomes.translated, 1);
});

test("S8a gate trains only same-cohort clean noncache primary samples and computes prediction metrics", () => {
	const store = createHistoricalPrimarySampleReservoir({capacity: 256});
	store.start();
	for (let index = 0; index < 100; index++) recordPrimary(store, index, {suffix: "cohort-a", durationMs: 200 + index * 2});
	for (let index = 100; index < 110; index++) recordPrimary(store, index, {suffix: "cohort-b", durationMs: 999});
	for (let index = 110; index < 115; index++) recordPrimary(store, index, {suffix: "cohort-a", failureKind: "server"});
	store.recordCache({hit: 7, miss: 115});
	const gate = store.getSnapshot().s8Gate;
	assert.equal(gate.cohortCount, 2);
	assert.equal(gate.sampleCount, 100);
	assert.equal(gate.contaminatedCount, 5);
	assert.equal(gate.ready, true);
	assert.ok(gate.mapePercent <= 30 || gate.spearman >= 0.6);
	assert.equal(gate.blockedReason, null);
	assert.equal(store.getSnapshot().cache.hit, 7);
});

test("S8a below one hundred clean cohort samples reports progress instead of readiness", () => {
	const store = createHistoricalPrimarySampleReservoir();
	store.start();
	for (let index = 0; index < 99; index++) recordPrimary(store, index, {suffix: "small"});
	const gate = store.getSnapshot().s8Gate;
	assert.equal(gate.sampleCount, 99);
	assert.equal(gate.ready, false);
	assert.equal(gate.blockedReason, "insufficient_clean_samples");
	assert.equal(gate.requiredSampleCount, 100);
});

test("S8a clean pressure cancellation live repair and cache counters remain separate", () => {
	const store = createHistoricalPrimarySampleReservoir();
	store.start();
	recordPrimary(store, 1);
	recordPrimary(store, 2, {failureKind: "server"});
	recordPrimary(store, 3, {cancelled: true});
	recordPrimary(store, 4, {liveOverlap: true});
	store.recordRepair({jobKey: "job-2", mode: "batch", messageCount: 1});
	store.recordCache({hit: 2, miss: 4, invalidated: 1});
	const snapshot = store.getSnapshot();
	assert.equal(snapshot.cleanPrimaryCount, 1);
	assert.equal(snapshot.pressurePrimaryCount, 1);
	assert.equal(snapshot.cancelledPrimaryCount, 1);
	assert.equal(snapshot.liveOverlapPrimaryCount, 1);
	assert.deepEqual(snapshot.cache, {hit: 2, miss: 4, invalidated: 1});
	assert.equal(snapshot.repairs.batchRequests, 1);
});

test("S8a persisted payload contains no fixture secrets and remains below one megabyte at capacity", () => {
	let saved = null;
	const store = createHistoricalPrimarySampleReservoir({save: value => {saved = JSON.parse(JSON.stringify(value));}});
	store.start();
	for (let index = 0; index < HISTORICAL_PRIMARY_SAMPLE_CAPACITY; index++) recordPrimary(store, index, {suffix: `anon-${index}`});
	store.flush();
	const serialized = JSON.stringify(saved);
	assert.ok(Buffer.byteLength(serialized, "utf8") < 1024 * 1024);
	assert.doesNotMatch(serialized, /fixture-secret|raw prompt|https?:|Authorization|api[_-]?key|message content/i);
	assert.equal(saved.samples.every(sample => Object.keys(sample).every(key => !["body", "headers", "endpoint", "model", "rawError", "prompt", "text", "messageId", "jobKey"].includes(key))), true);
});

test("S8a migrates legacy numeric samples and one hundred reset stop cycles leave no resources", () => {
	let saved = {schemaVersion: 0, samples: [{transportKey: "tk1:legacy", workloadKey: "wk1:legacy", itemCount: 2, bodyBytes: 100, durationMs: 10, recordedAt: 1}], evictedCount: 2};
	const store = createHistoricalPrimarySampleReservoir({load: () => saved, save: value => {saved = JSON.parse(JSON.stringify(value));}, now: () => 10});
	for (let cycle = 0; cycle < 100; cycle++) {
		store.start();
		assert.equal(store.getSnapshot().schemaVersion, HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION);
		store.reset();
		store.stop();
		assert.deepEqual(store.getSnapshot().resources, {openSamples: 0, messageLinks: 0, pendingSave: false});
	}
});

test("S8a numeric event write P95 stays below 0.5ms", () => {
	const store = createHistoricalPrimarySampleReservoir();
	store.start();
	const timings = [];
	for (let index = 0; index < 1000; index++) {
		const started = performance.now();
		recordPrimary(store, index);
		timings.push(performance.now() - started);
	}
	timings.sort((a, b) => a - b);
	const p95 = timings[Math.floor(timings.length * 0.95)];
	assert.ok(p95 < 0.5, `P95 ${p95.toFixed(4)}ms`);
});

test("primary sample keeps first contract and settle while totaling distinct fallback attempts", () => {
 let saved; const store=createHistoricalPrimarySampleReservoir({save:value=>{saved=structuredClone(value);}});store.start();
 const token=store.beginPrimary({jobKey:"fallback-job",messageIds:["m"],protectedChars:80});
 const primary={providerRequestId:41,providerAttempt:1,durationMs:1200,outputChars:17,usage:{promptTokens:100,completionTokens:7,reasoningTokens:null},httpStatus:500,finishReason:null,status:"http_500"};
 store.recordContract(token,{...contract("primary"),bodyBytes:900,promptChars:700,inputChars:80});store.recordSettle(token,primary);
 store.recordContract(token,{...contract("fallback"),bodyBytes:400,promptChars:300,inputChars:60});
 const fallback={providerRequestId:41,providerAttempt:2,durationMs:4800,outputChars:60,usage:{promptTokens:40,completionTokens:20,reasoningTokens:3},httpStatus:200,finishReason:"stop",status:"ok"};
 store.recordSettle(token,fallback);store.recordSettle(token,{...fallback});store.recordOutcome(token);store.flush();
 const sample=saved.samples[0];assert.equal(sample.transportKey,"tk1:primary");assert.equal(sample.workloadKey,"wk1:primary");assert.equal(sample.bodyBytes,900);assert.equal(sample.promptChars,700);assert.equal(sample.inputChars,80);assert.equal(sample.estimatedTokens,225);
 assert.equal(sample.durationMs,1200);assert.equal(sample.outputChars,17);assert.deepEqual(sample.usage,primary.usage);assert.equal(sample.httpStatus,500);assert.equal(sample.status,"http_500");assert.equal(sample.finishReason,null);
 assert.deepEqual(sample.transportAttempts,{requestCount:2,measuredDurationCount:2,unknownDurationCount:0,durationMs:6000});assert.equal(sample.trainingEligible,false);assert.equal(sample.contaminated,true);store.stop();
});

test("primary sample does not collapse distinct null-identity settles or invent unknown durations", () => {
 let saved;const store=createHistoricalPrimarySampleReservoir({save:value=>{saved=structuredClone(value);}});store.start();const token=store.beginPrimary();store.recordContract(token,{...contract(),bodyBytes:100});
 const first={providerRequestId:null,providerAttempt:null,durationMs:100,httpStatus:200,status:"ok"};store.recordSettle(token,first);store.recordSettle(token,first);
 store.recordSettle(token,{providerRequestId:null,providerAttempt:null,durationMs:200,httpStatus:200,status:"ok"});store.recordSettle(token,{providerRequestId:null,providerAttempt:null,durationMs:null,httpStatus:200,status:"ok"});store.recordOutcome(token);store.flush();
 assert.equal(saved.samples[0].durationMs,100);assert.deepEqual(saved.samples[0].transportAttempts,{requestCount:3,measuredDurationCount:2,unknownDurationCount:1,durationMs:300});assert.equal(saved.samples[0].trainingEligible,false);store.stop();
});

for(const schemaVersion of [0,1])test(`primary sample retains unknown old aggregate and roundtrips new totals in schema ${schemaVersion}`, () => {
 let saved={schemaVersion,samples:[{...contract("legacy"),sampleId:1,recordedAt:1,durationMs:4980,bodyBytes:500,status:"ok",httpStatus:200,trainingEligible:true}]};const store=createHistoricalPrimarySampleReservoir({load:()=>saved,save:value=>{saved=structuredClone(value);},now:()=>10});store.start();store.recordCache({hit:1});store.flush();assert.equal(saved.samples[0].durationMs,4980);assert.equal(saved.samples[0].transportAttempts,null,"old fallback-expanded duration is unknown, not inferred");recordPrimary(store,2);store.flush();const aggregate=saved.samples[1].transportAttempts;assert.deepEqual(aggregate,{requestCount:1,measuredDurationCount:1,unknownDurationCount:0,durationMs:102});store.stop();store.start();store.recordCache({hit:1});store.flush();assert.deepEqual(saved.samples[1].transportAttempts,aggregate);assert.equal(saved.schemaVersion,HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION);assert.doesNotMatch(JSON.stringify(saved),/providerRequestId|providerAttempt|settledKeys|settledEvents/);store.stop();
});
