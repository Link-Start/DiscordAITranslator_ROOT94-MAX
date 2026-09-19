// W3 compile shadow for the D (whole-marker) wire. When performance.compactWireShadow is
// "shadow", every production typed-json request is mirrored by one local D compile over the
// same masked source, and only numbers leave this module: byte counts, ratios, coverage,
// budget and identity verdicts, compile time. Nothing here is ever sent, cached or displayed,
// and the typed request object is read, never touched.
//
// Docs: docs/ai-fast-translation-optimization-plan.zh-CN.md §11 W3 row, §15.

const {planReceivedMarkdown, hashReceivedMarkdownSource} = require("./received-markdown-lossless-planner");
const {buildWholeMarkerRequest, WHOLE_MARKER_CONTRACT_REVISION, WHOLE_MARKER_MAX_BODY_BYTES} = require("./translation-whole-marker-wire");

const SHADOW_SCHEMA_VERSION = "w3-shadow-1";
const SHADOW_STATUSES = Object.freeze(["ok", "identity-mismatch", "budget", "compile-failed"]);
const BUDGET_REASONS = Object.freeze(["body-budget", "item-budget", "system-prompt-budget"]);
const SHADOW_FAILURE_REASONS = Object.freeze(["body-budget", "item-budget", "system-prompt-budget", "no-segments", "invalid-plan", "protected-leak", "marker-collision", "lookalike-marker", "planner-error", "unknown"]);
// A D wire is marker-delimited text. Any JSON metadata key of the typed wire, or a planner
// node id, appearing in it means the compact contract has leaked typed structure.
const PROHIBITED_FIELD_RE = /"(?:id|contextIds|contexts|schemaVersion|semanticRevision|segments|plannerVersion|document|direction|fieldPath|sourceLength)"\s*:/g;
const PLANNER_ID_RE = /m3i-v\d+\|(?:received|sent)\|/g;

const shadowRecords = new WeakMap();

function utf8(value) {return Buffer.byteLength(String(value == null ? "" : value));}
function whole(value, maximum = Number.MAX_SAFE_INTEGER) {const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.floor(number))) : 0;}
function permille(numerator, denominator) {return denominator > 0 ? whole(Math.round(1000 * numerator / denominator), 1000000) : null;}
function count(text, regex) {let total = 0; regex.lastIndex = 0; while (regex.exec(text)) {total++; if (total >= 4096) break;} return total;}
function defaultNow() {return typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now();}
function failureReason(reason) {return SHADOW_FAILURE_REASONS.includes(String(reason || "")) ? String(reason) : "unknown";}

function finish(fields, startedAt, now) {
	const record = Object.freeze(Object.assign({
		schemaVersion: SHADOW_SCHEMA_VERSION,
		contractRevision: WHOLE_MARKER_CONTRACT_REVISION,
		status: "ok",
		failureReason: null,
		identityMatch: true,
		budgetOk: null,
		typedBytes: 0,
		typedPromptBytes: 0,
		typedEstimatedTokens: 0,
		typedSegmentCount: 0,
		dBytes: null,
		dPromptBytes: null,
		dEstimatedTokens: null,
		dRangeCount: null,
		bodyRatioPermille: null,
		inputRatioPermille: null,
		windowed: false,
		contextCoveragePermille: null,
		translateCoveragePermille: null,
		insertedBreaks: null,
		prohibitedFieldCount: null
	}, fields, {compileMicros: whole(Math.round((now() - startedAt) * 1000), 3600000000)}));
	return record;
}

// One shadow per production typed request. `request` is the frozen createSemanticRequest
// result, `source` the same P1-masked text it was compiled from, `protectedSegments` the
// P1 placeholder map. Returns null when the request is not a typed-json wire.
function compileTypedRequestShadow({request, source, protectedSegments = {}, now = defaultNow} = {}) {
	if (!request || request.enabled !== true || request.adapter !== "typed-json" || !request.plan) return null;
	const startedAt = now();
	const typedPlan = request.plan;
	const typed = {
		typedBytes: whole(request.bodyBytes != null ? request.bodyBytes : utf8(request.wire)),
		typedPromptBytes: utf8(request.systemPrompt),
		typedEstimatedTokens: whole(request.estimatedTokens),
		typedSegmentCount: whole((request.segmentOrder || []).length)
	};
	const targetLanguageId = String(request.targetLanguageId || typedPlan.targetLanguageId || "zh-CN");
	let dPlan = null;
	try {dPlan = planReceivedMarkdown(String(source == null ? "" : source), {direction: typedPlan.direction || "received", fieldPath: typedPlan.fieldPath || "body", targetLanguageId});}
	catch {dPlan = null;}
	if (!dPlan) {const record = finish(Object.assign({status: "compile-failed", failureReason: "planner-error", identityMatch: false}, typed), startedAt, now); shadowRecords.set(request, record); return record;}
	// Identity: the shadow must have planned exactly the bytes the typed wire was planned from.
	const sourceText = String(source == null ? "" : source);
	const identityMatch = hashReceivedMarkdownSource(sourceText) === typedPlan.sourceHash && sourceText.length === typedPlan.sourceLength && dPlan.sourceHash === typedPlan.sourceHash && dPlan.sourceLength === typedPlan.sourceLength && dPlan.plannerVersion === typedPlan.plannerVersion && String(dPlan.targetLanguageId) === String(typedPlan.targetLanguageId || targetLanguageId);
	if (!identityMatch) {const record = finish(Object.assign({status: "identity-mismatch", identityMatch: false}, typed), startedAt, now); shadowRecords.set(request, record); return record;}
	const compiled = buildWholeMarkerRequest(dPlan, protectedSegments || {}, {targetLanguageId, maxBodyBytes: WHOLE_MARKER_MAX_BODY_BYTES});
	if (!compiled || compiled.ok !== true) {
		const reason = failureReason(compiled && compiled.reason);
		const record = finish(Object.assign({status: BUDGET_REASONS.includes(reason) ? "budget" : "compile-failed", failureReason: reason, budgetOk: BUDGET_REASONS.includes(reason) ? false : null, dBytes: compiled && compiled.bodyBytes != null ? whole(compiled.bodyBytes) : null}, typed), startedAt, now);
		shadowRecords.set(request, record);
		return record;
	}
	const dBytes = whole(compiled.bodyBytes), dPromptBytes = whole(compiled.systemPromptBytes);
	const record = finish(Object.assign({
		status: "ok",
		budgetOk: dBytes <= WHOLE_MARKER_MAX_BODY_BYTES,
		dBytes,
		dPromptBytes,
		dEstimatedTokens: whole(compiled.estimatedInputTokens),
		dRangeCount: whole(compiled.segmentCount),
		bodyRatioPermille: permille(dBytes, typed.typedBytes),
		inputRatioPermille: permille(dBytes + dPromptBytes, typed.typedBytes + typed.typedPromptBytes),
		windowed: compiled.windowed === true,
		contextCoveragePermille: permille(compiled.contextCoverage, 1),
		translateCoveragePermille: permille(compiled.translateCoverage, 1),
		insertedBreaks: whole(compiled.insertedBreaks),
		prohibitedFieldCount: whole(count(compiled.wire, PROHIBITED_FIELD_RE) + count(compiled.wire, PLANNER_ID_RE), 4096)
	}, typed), startedAt, now);
	shadowRecords.set(request, record);
	return record;
}

function lookupTypedRequestShadow(request) {return request && shadowRecords.get(request) || null;}

// History batches send one typed body for N messages; the D counterpart would send N marked
// wires under one system prompt. Both sides are summed from the per-message shadows so W5
// has a batch-level byte comparison without a single extra compile.
function summarizeTypedBatchShadow({requests = [], typedBatchBytes = 0, typedPromptBytes = 0} = {}) {
	const records = [].concat(requests || []).map(lookupTypedRequestShadow).filter(Boolean);
	if (!records.length) return null;
	const ok = records.filter(record => record.status === "ok");
	const dBytesSum = ok.reduce((total, record) => total + whole(record.dBytes), 0);
	const dPromptBytes = ok.reduce((max, record) => Math.max(max, whole(record.dPromptBytes)), 0);
	const batchBytes = whole(typedBatchBytes), promptBytes = whole(typedPromptBytes);
	return Object.freeze({
		schemaVersion: SHADOW_SCHEMA_VERSION,
		contractRevision: WHOLE_MARKER_CONTRACT_REVISION,
		itemCount: whole([].concat(requests || []).length, 4096),
		shadowedCount: whole(records.length, 4096),
		okCount: whole(ok.length, 4096),
		identityMismatchCount: whole(records.filter(record => record.status === "identity-mismatch").length, 4096),
		windowedCount: whole(ok.filter(record => record.windowed).length, 4096),
		typedBatchBytes: batchBytes,
		typedPromptBytes: promptBytes,
		dBytesSum,
		dPromptBytes,
		bodyRatioPermille: ok.length === records.length ? permille(dBytesSum, batchBytes) : null,
		inputRatioPermille: ok.length === records.length ? permille(dBytesSum + dPromptBytes, batchBytes + promptBytes) : null
	});
}

module.exports = {
	SHADOW_SCHEMA_VERSION,
	SHADOW_STATUSES,
	SHADOW_FAILURE_REASONS,
	compileTypedRequestShadow,
	lookupTypedRequestShadow,
	summarizeTypedBatchShadow
};
