const {planTranslationDocument, collectTranslationDocumentFields} = require("../planner/translation-document-plan");

const DOCUMENT_SHADOW_SCHEMA_VERSION = 1;
const DOCUMENT_SHADOW_CAPACITY = 128;
const DOCUMENT_SHADOW_PLAN_KEY_MAX_CODE_UNITS = 64 * 1024;

function safeLabel(value, fallback = "unknown") {
	const text = String(value == null ? "" : value).toLowerCase();
	return /^[a-z0-9_.:-]{1,64}$/.test(text) ? text : fallback;
}

function fieldSummary(field) {
	const plan = field.plan;
	const counts = {translate: 0, "preserve-target": 0, protected: 0, uncertain: 0, syntax: 0, context: (plan.contexts || []).length};
	for (const node of plan.nodes || []) {
		if (counts[node.classification] != null) counts[node.classification]++;
		if (node.kind === "syntax") counts.syntax++;
	}
	return Object.freeze({fieldPath: safeLabel(field.fieldPath), planHash: plan.sourceHash, sourceLength: plan.sourceLength, nodeCount: plan.nodes.length, counts: Object.freeze(counts), relation: Object.freeze({documentType: safeLabel(field.relation && field.relation.documentType, "field"), reusesDocument: !!(field.relation && field.relation.reuseDocumentIdentity)})});
}

function normalizeLoaded(raw) {
	if (!raw || raw.schemaVersion !== DOCUMENT_SHADOW_SCHEMA_VERSION) return [];
	return [].concat(raw.rows || []).filter(row => row && /^dp1:[a-f0-9]{8}$/.test(String(row.documentIdentity || ""))).slice(-DOCUMENT_SHADOW_CAPACITY);
}

function createTranslationDocumentShadowStore({load = () => null, save = () => {}, now = Date.now, capacity = DOCUMENT_SHADOW_CAPACITY, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer)} = {}) {
 const limit = Math.max(1, Math.min(DOCUMENT_SHADOW_CAPACITY, Number(capacity) || DOCUMENT_SHADOW_CAPACITY));
 let rows = [], evictedCount = 0, active = 0, started = false, dirty = false, timer = null, timerGeneration = 0, lastPlanKey = null, lastPlanSummary = null;
 const persist = () => {if (!dirty) return false; try {save({schemaVersion: DOCUMENT_SHADOW_SCHEMA_VERSION, rows, evictedCount}); dirty = false; return true;} catch {return false;}};
 function flush() {const prior = timer; timer = null; timerGeneration++; if (prior != null) {try {clearTimer(prior);} catch {}} return persist();}
 function schedule() {dirty = true; if (timer != null) return; const generation = ++timerGeneration; timer = setTimer(() => {if (generation !== timerGeneration || !started) return; timer = null; persist();}, 500); if (timer && typeof timer.unref === "function") timer.unref();}
 function start() {flush(); lastPlanKey = lastPlanSummary = null; if (!dirty) {try {rows = normalizeLoaded(load());} catch {rows = [];}} active = 0; started = true; return true;}
 function observe(input, metadata = {}) {
  if (!started) start(); active++;
  try {
   const startedAt = Number(now()) || 0, options = {direction: String(metadata.direction || "received"), targetLanguageId: String(metadata.targetLanguageId || "zh-CN")};
   const planKey = JSON.stringify([options.direction, options.targetLanguageId, collectTranslationDocumentFields(input || {}, options)]);
   const reusable = planKey.length <= DOCUMENT_SHADOW_PLAN_KEY_MAX_CODE_UNITS;
   if (!reusable) lastPlanKey = lastPlanSummary = null;
   let summary = reusable && lastPlanKey === planKey ? lastPlanSummary : null;
   if (!summary) {
    const plan = planTranslationDocument(input || {}, options);
    summary = Object.freeze({documentIdentity: plan.documentIdentity, plannerVersion: plan.plannerVersion, direction: safeLabel(plan.direction), fieldCount: plan.fieldCount, nodeCount: plan.nodeCount, coverageComplete: plan.coverageComplete, attachmentPolicy: plan.attachmentPolicy, attachmentsIncluded: false, fields: Object.freeze(plan.fields.map(fieldSummary))});
    if (reusable) {lastPlanKey = planKey; lastPlanSummary = summary;}
   }
   const key = `${summary.documentIdentity}|${safeLabel(metadata.lane)}`;
   const row = Object.freeze(Object.assign({key}, summary, {lane: safeLabel(metadata.lane), durationMicros: Math.max(0, Math.floor(((Number(now()) || startedAt) - startedAt) * 1000)), recordedAt: Number(now()) || 0}));
   const prior = rows.findIndex(value => value.key === key); if (prior >= 0) rows.splice(prior, 1); rows.push(row); while (rows.length > limit) {rows.shift(); evictedCount++;} schedule(); return row;
  }
  catch {return null;}
  finally {active--;}
 }
 function getSnapshot() {const state = {schemaVersion: DOCUMENT_SHADOW_SCHEMA_VERSION, rows, evictedCount}; return Object.freeze({schemaVersion: DOCUMENT_SHADOW_SCHEMA_VERSION, rowCount: rows.length, evictedCount, rows: Object.freeze(rows.slice()), persistedBytes: Buffer.byteLength(JSON.stringify(state)), attachmentsIncluded: false, resources: Object.freeze({active})});}
 function reset() {lastPlanKey = lastPlanSummary = null; rows = []; evictedCount = 0; dirty = true; flush(); return true;}
 function stop() {flush(); active = 0; lastPlanKey = lastPlanSummary = null; started = false; return true;}
 return Object.freeze({start, observe, getSnapshot, reset, stop, flush});
}

module.exports = {DOCUMENT_SHADOW_SCHEMA_VERSION, DOCUMENT_SHADOW_CAPACITY, createTranslationDocumentShadowStore};
