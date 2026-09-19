const {validateWholeMarkerBatchResult} = require("./whole-marker-batch-canary");
const {isNameLikeMessage, legacySoftReasonLabel} = require("../planner/translation-soft-validation");

function sameAsSource(storedTranslation) {
	const original = String(storedTranslation && storedTranslation.originalContent || "").trim();
	const translated = String(storedTranslation && storedTranslation.translatedContent || "").trim();
	return !!original && original === translated;
}

// P3-b: a whole-message soft failure on a name-like message keeps the source text at once (P3
// rule 2a). The kept copy is rebuilt from the protected source, not from the provider's echo, and
// carries the kept count so the echo guards (display, cache) do not undo the keep.
function keepNameLikeSource({prepared, channelId, reason, addExceptions, createStored}) {
	const label = legacySoftReasonLabel(reason);
	const stored = label ? createStored(prepared.message, channelId, prepared.originalContentData, prepared.signature, addExceptions(String(prepared.protectedText || ""), prepared.exceptions), prepared.input, prepared.output, true) : null;
	if (!stored) return null;
	stored.keptSegmentCount = 1;
	stored.keptReasons = {[label]: 1};
	return {outcome: {ok: true, translation: stored, keptCount: 1, keptReasons: {[label]: 1}}, reason: null, repairEligible: false, kept: label};
}

function classifyHistoricalBatchValidation({prepared, rawTranslation, channelId, isSkipSignal, hasPlaceholders, addExceptions, likelyTarget, createStored, shouldKeep, tooSimilar}) {
	if (!prepared) return {outcome: {ok: false}, reason: "unknown", repairEligible: true};
	if (rawTranslation == null) return {outcome: {ok: false}, reason: "missing_id", repairEligible: true};
	if (String(rawTranslation).trim() === "") return {outcome: {ok: false}, reason: "empty", repairEligible: true};
	if (isSkipSignal(rawTranslation)) return {outcome: {ok: false, skipped: true, reason: "ai_skip_signal"}, reason: "policy_rejected", repairEligible: false};
	let translatedText = String(rawTranslation).replace(/\[NEWLINE\]/g, "\n").trim();
	if (!hasPlaceholders(translatedText, prepared.exceptions)) return {outcome: {ok: false}, reason: "placeholder_missing", repairEligible: true};
	translatedText = addExceptions(translatedText, prepared.exceptions);
	let nameLike;
	const nameLikeMessage = () => nameLike === undefined ? (nameLike = isNameLikeMessage(prepared.protectedText)) : nameLike;
	const keep = reason => nameLikeMessage() ? keepNameLikeSource({prepared, channelId, reason, addExceptions, createStored}) : null;
	if (!likelyTarget(translatedText, prepared.output && prepared.output.id)) return keep("wrong_language") || {outcome: {ok: false}, reason: "wrong_language", repairEligible: true};
	const storedTranslation = createStored(prepared.message, channelId, prepared.originalContentData, prepared.signature, translatedText, prepared.input, prepared.output, true);
	if (!storedTranslation) return {outcome: {ok: false}, reason: translatedText ? "unknown" : "empty", repairEligible: true};
	// The keep policy only reaches a rejection that is the similarity class; same-language and
	// source-filter policy rejections stay hard.
	if (!shouldKeep(storedTranslation, channelId)) return (nameLikeMessage() && tooSimilar(storedTranslation) ? keep(sameAsSource(storedTranslation) ? "same_as_source" : "too_similar") : null) || {outcome: {ok: false}, reason: "policy_rejected", repairEligible: true};
	if (tooSimilar(storedTranslation)) return keep(sameAsSource(storedTranslation) ? "same_as_source" : "too_similar") || {outcome: {ok: false}, reason: sameAsSource(storedTranslation) ? "same_as_source" : "too_similar", repairEligible: true};
	return {outcome: {ok: true, translation: storedTranslation}, reason: null, repairEligible: false};
}

function classifyHistoricalStoredRejection(storedTranslation, rejectReason, tooSimilar) {
	if (!storedTranslation) return "unknown";
	if (rejectReason && rejectReason !== "too_similar") return "policy_rejected";
	if (rejectReason === "too_similar" || tooSimilar) return sameAsSource(storedTranslation) ? "same_as_source" : "too_similar";
	return null;
}

module.exports = {classifyHistoricalBatchValidation, classifyHistoricalStoredRejection};

function validateHistoricalTranslationJobResult(plugin, prepared, rawTranslation, job, historicalBatchPerformance) {
				if (prepared && prepared.wholeMarkerBatchFinal) {
 const result = validateWholeMarkerBatchResult(plugin, prepared, rawTranslation, job);
 historicalBatchPerformance.recordParseValidate(job, {parsed: 1, valid: result.ok ? 1 : 0, invalid: result.ok ? 0 : 1});
 if (!result.ok) historicalBatchPerformance.recordValidationReason(job, prepared, result.reason, {repairEligible: false, phase: "batch"});
 const routeId = prepared.queueItem && prepared.queueItem.terminalRouteId;
 if (routeId) plugin.recordTranslationTerminalStage(routeId, result.ok ? "target-language" : "parse", result.reason || "valid", {requestFamily: "whole-marker-batch", validatorFamily: rawTranslation && rawTranslation.wholeMarkerBatch && rawTranslation.wholeMarkerBatch.request.validatorVersion || "whole-marker-batch", semanticRevision: "w5-whole-marker-batch-v1"});
 return result;
}
				if (prepared && prepared.semanticRequest && rawTranslation && (rawTranslation.semanticSegments || Object.prototype.hasOwnProperty.call(rawTranslation, "semanticWire"))) {const semanticValue = Object.prototype.hasOwnProperty.call(rawTranslation, "semanticWire") ? rawTranslation.semanticWire : {segments: rawTranslation.semanticSegments}, semantic = plugin.validateAtomicSemanticResponse(prepared.semanticRequest, semanticValue, {priorValid: prepared.semanticPriorValid || {}, likelyTarget: value => plugin.isTranslationLikelyInTargetLanguage(value, prepared.output && prepared.output.id), similarity: (source, value) => plugin.getTextSimilarityScore(source, value), maxSimilarity: 0.94}); prepared.semanticOutcome = semantic; historicalBatchPerformance.recordParseValidate(job, {parsed: 1, valid: semantic.ok ? 1 : 0, invalid: semantic.ok ? 0 : 1}); const routeId = prepared.queueItem && prepared.queueItem.terminalRouteId; if (!semantic.ok) {historicalBatchPerformance.recordValidationReason(job, prepared, semantic.reason || "unknown", {repairEligible: true, phase: prepared.semanticRepair ? "repair" : "batch"}); if (routeId) plugin.recordTranslationTerminalStage(routeId, ["wrong-language", "wrong_language"].includes(semantic.reason) ? "target-language" : ["too-similar", "too_similar"].includes(semantic.reason) ? "similarity" : ["placeholder-mismatch", "placeholder_missing"].includes(semantic.reason) ? "placeholder" : "parse", semantic.reason || "unknown", {validatorFamily: "segment-validator-v3", semanticRevision: prepared.semanticRequest.semanticRevision}); return {ok: false, reason: semantic.reason || "unknown"};} if (semantic.unchanged) {if (routeId) plugin.recordTranslationTerminalStage(routeId, "target-language", "confirmed_unchanged", {validatorFamily: "segment-validator-v3", keptSegmentCount: semantic.keptCount || 0}); return {ok: false, skipped: true, reason: "ai_skip_signal"};} const stored = plugin.createStoredReceivedTranslationData(prepared.message, job.channelId, prepared.originalContentData, prepared.signature, semantic.translation, prepared.input, prepared.output, true); if (stored) {const fields = prepared.semanticRequest.workload && prepared.semanticRequest.workload.fields || {}; stored.semanticRevision = prepared.semanticRequest.semanticRevision; stored.semanticWorkloadKey = prepared.semanticRequest.workload && prepared.semanticRequest.workload.key || null; stored.plannerVersion = prepared.semanticRequest.plan && prepared.semanticRequest.plan.plannerVersion || null; stored.planHash = plugin.getAtomicSemanticPlanHash(prepared.semanticRequest); stored.validatorVersion = fields.validatorVersion || null; stored.outputSchemaVersion = fields.outputSchemaVersion || null; if (semantic.keptCount > 0) {stored.keptSegmentCount = semantic.keptCount; stored.keptReasons = Object.assign({}, semantic.keptReasons || {});}} if (routeId) plugin.recordTranslationTerminalStage(routeId, "target-language", "valid", {validatorFamily: "segment-validator-v3", semanticRevision: prepared.semanticRequest.semanticRevision, keptSegmentCount: semantic.keptCount || 0, keptReasons: semantic.keptReasons || {}}); return stored ? {ok: true, translation: stored} : {ok: false, reason: "unknown"};}
				const result = classifyHistoricalBatchValidation({prepared, rawTranslation, channelId: job.channelId, isSkipSignal: value => plugin.isSkipTranslationSignal(value), hasPlaceholders: (value, exceptions) => plugin.hasAllProtectionPlaceholders(value, exceptions), addExceptions: (value, exceptions) => plugin.addExceptions(value, exceptions), likelyTarget: (value, output) => plugin.isTranslationLikelyInTargetLanguage(value, output), createStored: (...args) => plugin.createStoredReceivedTranslationData(...args), shouldKeep: (value, channelId) => plugin.shouldKeepAutoTranslatedResult(value, channelId), tooSimilar: value => plugin.isTranslationResultTooSimilar(value)});
				historicalBatchPerformance.recordParseValidate(job, {parsed: 1, valid: result.outcome.ok ? 1 : 0, invalid: result.outcome.ok ? 0 : 1});
				if (result.reason) historicalBatchPerformance.recordValidationReason(job, prepared, result.reason, {repairEligible: result.repairEligible, phase: "batch"});
				const routeId = prepared && prepared.queueItem && prepared.queueItem.terminalRouteId;
				if (routeId) {plugin.recordTranslationTerminalStage(routeId, result.reason === "placeholder_missing" ? "placeholder" : result.reason === "wrong_language" ? "target-language" : ["same_as_source", "too_similar", "policy_rejected"].includes(result.reason) ? "similarity" : result.reason ? "parse" : "target-language", result.reason || "valid", {validatorFamily: "history-batch", keptSegmentCount: result.outcome.keptCount || 0, keptReasons: result.outcome.keptReasons || {}}); if (prepared.classicPrimaryDispatched && result.reason) plugin.recordHistoricalAutoCheckpoint(routeId, "primary", result.reason);}
				return result.outcome;
			}
module.exports.validateHistoricalTranslationJobResult = validateHistoricalTranslationJobResult;
