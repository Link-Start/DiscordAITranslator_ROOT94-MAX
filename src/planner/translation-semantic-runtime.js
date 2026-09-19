const {planReceivedMarkdown, reassembleReceivedMarkdown, hashReceivedMarkdownSource} = require("./received-markdown-lossless-planner");
const {SOURCE_CONTEXT_VERSION, NAME_KEEP_VERSION, SOURCE_CONTEXT_INSTRUCTION, NAME_KEEP_INSTRUCTION, NAME_REPAIR_INSTRUCTION, buildMessageSourceContext, isNameKeepDecision} = require("./translation-source-context");
const {CORE_SYSTEM_PROMPT, INLINE_FORMAT_INSTRUCTION, SEMANTIC_REVISION, parseTypedPlanResponse, resolveTypedRowAliases, isTranslatableOutputNode} = require("./translation-plan-serializer");
const {capabilityFor, compileAdapterWire, compileClassicTagged, compileClassicMarked} = require("./translation-plan-adapters");
const {validateSegmentResponse} = require("./translation-segment-validator");
const {planPreciseRepair} = require("./translation-precise-repair-shadow");
const {createSemanticWorkloadKey} = require("./translation-semantic-revision");
const {applyInlineProtectedRanges, restoreInlineProtectedTranslations, stripInlineTokens} = require("./translation-inline-ranges");
const {resolveSoftFailures, segmentKeepText, summarizeKept} = require("./translation-soft-validation");
const {buildTranslationPreferenceBlock} = require("../settings/translation-preferences");

// P2 merged ranges expose the text the model actually saw; letter counts and repair budgets
// use it without its tokens, so a merged range weighs exactly what its P1 fragments weighed.
function nodeLanguageText(node) {return typeof node.wireText === "string" ? stripInlineTokens(node.wireText) : String(node.raw || "");}
function nodeWireText(node) {return typeof node.wireText === "string" ? node.wireText : String(node.raw || "");}

const semanticLocalState = new WeakMap();
// P3: soft failures kept as source text, accumulated per root plan across repair rounds so the
// final outcome reports every kept segment of the message, not only the last round's.
const keptByRootPlan = new WeakMap();
function accumulateKept(request, kept, {fresh = false} = {}) {
	const root = request && (request.rootPlan || request.plan);
	if (!root || typeof root !== "object") return Object.freeze(Object.assign({}, kept));
	// A first answer (attempt 1) starts the message over; only repair rounds add to what was kept.
	const store = fresh ? {} : keptByRootPlan.get(root) || {};
	Object.assign(store, kept);
	keptByRootPlan.set(root, store);
	return Object.freeze(Object.assign({}, store));
}
function attachSemanticLocalState(request, state = {}) {if (request && typeof request === "object") semanticLocalState.set(request, Object.freeze({protectedSegments: Object.freeze(Object.assign({}, state.protectedSegments || {})), cachePlanHash: String(state.cachePlanHash || request.plan && request.plan.sourceHash || "")})); return request;}
function getSemanticLocalState(request) {return request && semanticLocalState.get(request) || Object.freeze({protectedSegments: Object.freeze({}), cachePlanHash: String(request && request.plan && request.plan.sourceHash || "")});}

function translatableNodes(plan) {return (plan && plan.nodes || []).filter(isTranslatableOutputNode);}
function isPlanTranslationMeaningful(plan) {return translatableNodes(plan).some(node => /\p{L}/u.test(nodeLanguageText(node)));}
function createSemanticPlanEligibility({source, direction = "received", fieldPath = "body", targetLanguageId = "zh-CN"} = {}) {try {const plan = planReceivedMarkdown(String(source || ""), {direction, fieldPath, targetLanguageId}); if ((plan.nodes || []).some(node => node.role === "oversized-document")) return Object.freeze({enabled: false, fallbackReason: "planner-budget", semanticRevision: "legacy", plan}); return Object.freeze({enabled: true, planOnly: true, semanticRevision: SEMANTIC_REVISION, plan, segmentOrder: Object.freeze(translatableNodes(plan).map(node => node.id))});} catch {return Object.freeze({enabled: false, fallbackReason: "planner-error", semanticRevision: "legacy"});}}
function subsetPlan(plan, ids) {const wanted = new Set([].concat(ids || []).map(String)); return Object.assign({}, plan, {nodes: plan.nodes.filter(node => wanted.has(String(node.id))), contexts: plan.contexts.filter(context => plan.nodes.some(node => wanted.has(String(node.id)) && (node.contextIds || []).includes(context.id)))});}
function parseNativeRows(value, order) {try {const parsed = typeof value === "string" ? JSON.parse(value) : value, items = Array.isArray(parsed) ? parsed : parsed && parsed.items; if (!Array.isArray(items)) return null; return items.map((item, index) => typeof item === "string" ? {id: order[index], translation: item} : item);} catch {return null;}}
function parseClassicRows(value, order) {const text = String(value || ""), rows = []; for (let index = 0; index < order.length; index++) {const match = text.match(new RegExp(`<S${index}>([\\s\\S]*?)<\\/S${index}>`)); if (match) rows.push({id: order[index], translation: match[1]});} return rows.length ? rows : null;}
function parseClassicMarkedRows(value, order) {const text=String(value||""),matches=[...text.matchAll(/⟦(\d+)⟧/g)],positions=new Map();for(const match of matches){const index=Number(match[1]);if(!Number.isInteger(index)||index<0||index>order.length||positions.has(index))continue;positions.set(index,{start:match.index,end:match.index+match[0].length});}const rows=[];for(let index=0;index<order.length;index++){const start=positions.get(index),end=positions.get(index+1);if(start&&end&&start.end<=end.start){let translation=text.slice(start.end,end.start);translation=translation.replace(/^\r?\n/,"").replace(/\r?\n$/,"");rows.push({id:order[index],translation});}}return rows.length?rows:null;}
function parseRows(request, value) {if (!request) return null; if (request.adapter === "typed-json") return resolveTypedRowAliases(parseTypedPlanResponse(value), request.segmentAliases); if (request.adapter === "native-multi") return parseNativeRows(value, request.segmentOrder); if (request.adapter === "classic-tagged") return parseClassicRows(value, request.segmentOrder); if(request.adapter==="classic-marked")return parseClassicMarkedRows(value,request.segmentOrder); return null;}

function createSemanticRequest({engineKey, source, direction = "received", fieldPath = "body", inputLanguageId = "auto", targetLanguageId = "zh-CN", customPromptDigest = "none", customPrompt = "", attempt = 1, maxAttempts = 3, maxBodyBytes = 65536, maxEstimatedTokens = 16384, maxContextChars = 4096, forceClassic = false, inlineFormatting = true, includeNameKeep = true, nameRepair = false} = {}) {
	const capability = capabilityFor(engineKey); if (!capability.enabled && !forceClassic) return Object.freeze({enabled: false, fallbackReason: capability.reason || "capability-unverified", semanticRevision: "legacy"});
	// P2 applies only to the typed-json AI wire; classic adapters keep the untouched plan.
	// Disabling formatting/name permission is reserved for offline replay of older contracts.
	const planned = planReceivedMarkdown(String(source || ""), {direction, fieldPath, targetLanguageId}), sourceContext = !forceClassic && capability.adapter === "typed-json" ? buildMessageSourceContext(planned, maxContextChars) : null;
	const ranged = !forceClassic && capability.adapter === "typed-json" ? applyInlineProtectedRanges(planned, {inlineFormatting}) : planned;
	const plan = sourceContext ? Object.assign({}, ranged, {sourceContext}) : ranged, compiled = forceClassic === "marked" ? compileClassicMarked(plan, {maxBodyBytes}) : forceClassic ? compileClassicTagged(plan, {maxBodyBytes}) : compileAdapterWire(engineKey, plan, {attempt, maxAttempts, maxBodyBytes, maxEstimatedTokens, maxContextChars, includeNameKeep});
	if (!compiled.enabled || !compiled.wire) return Object.freeze({enabled: false, fallbackReason: compiled.fallbackReason || "serializer-failed", semanticRevision: "legacy", plan});
	const hasInlineFormatting = !!(plan.inlineRanges && plan.inlineRanges.formatCount), hasContext = !!(compiled.typed && compiled.typed.payload.sourceContext), hasNameKeep = !!(compiled.typed && compiled.typed.contextNameIds.length), segmentOrder = compiled.segmentOrder || [], workload = createSemanticWorkloadKey({plannerVersion: plan.plannerVersion, customPromptDigest, languagePair: `${inputLanguageId}:${targetLanguageId}`, providerSemanticRevision: SEMANTIC_REVISION, inlineFormatting: hasInlineFormatting, sourceContextVersion: hasContext ? SOURCE_CONTEXT_VERSION : null, nameKeepVersion: hasNameKeep ? NAME_KEEP_VERSION : null});
	return Object.freeze({enabled: true, engineKey: String(engineKey), adapter: compiled.adapter, semanticRevision: SEMANTIC_REVISION, targetLanguageId: String(targetLanguageId || "zh-CN"), plan, rootPlan: plan, rootSegmentOrder: Object.freeze(segmentOrder.slice()), wire: compiled.wire, segmentOrder: Object.freeze(segmentOrder.slice()), segmentAliases: compiled.typed && compiled.typed.aliases || null, contextNameIds: compiled.typed && compiled.typed.contextNameIds || [], wireVersion: compiled.typed && compiled.typed.wireVersion || null, systemPrompt: `${CORE_SYSTEM_PROMPT} The exact targetLanguageId for this request is ${String(targetLanguageId || "zh-CN")}.${hasInlineFormatting ? INLINE_FORMAT_INSTRUCTION : ""}${hasContext ? SOURCE_CONTEXT_INSTRUCTION : ""}${hasNameKeep ? NAME_KEEP_INSTRUCTION : ""}${buildTranslationPreferenceBlock(customPrompt)}${hasNameKeep && nameRepair ? NAME_REPAIR_INSTRUCTION : ""}`, workload, attempt, maxAttempts, bodyBytes: compiled.typed && compiled.typed.bodyBytes || Buffer.byteLength(compiled.wire), estimatedTokens: compiled.typed && compiled.typed.estimatedTokens || Math.ceil(Buffer.byteLength(compiled.wire) / 4)});
}

// softKeep=false restores the strict P2 verdict; the W2 diagnostics harness uses it so arm
// comparisons keep measuring the wire, not the keep policy.
function validateSemanticResponse(request, value, {likelyTarget = () => true, similarity = () => 0, maxSimilarity = 0.94, priorValid = {}, softKeep = true} = {}) {
	const fresh = Number(request.attempt || 1) <= 1, priorKept = softKeep ? accumulateKept(request, {}, {fresh}) : Object.freeze({}), priorSummary = summarizeKept(priorKept);
	const rows = parseRows(request, value); if (!rows) return Object.freeze({ok: false, reason: "malformed", valid: Object.freeze(Object.assign({}, priorValid)), invalidIds: Object.freeze(request.segmentOrder.slice()), rows: null, kept: priorKept, keptCount: priorSummary.keptCount, keptReasons: priorSummary.keptReasons});
	const nameCandidates = new Set(request.contextNameIds || []), declaredNameIds = [];
	const resolvedRows = rows.map(row => {
		if (!row || !softKeep || !nameCandidates.has(String(row.id))) return row;
		const node = request.plan.nodes.find(part => part.id === String(row.id));
		if (!node || !isNameKeepDecision(node, row.translation)) return row;
		declaredNameIds.push(String(row.id));
		return Object.assign({}, row, {translation: node.wireText || node.raw});
	});
	const validation = validateSegmentResponse(request.plan, resolvedRows, {likelyTarget, similarity, maxSimilarity}), valid = Object.assign({}, priorValid, validation.valid); for (const row of validation.invalid) delete valid[row.id];
	// A recognised name/technical label can retain its source. Other rejected segments
	// remain invalid even after repair; they cannot turn a partial result into success.
	const soft = softKeep ? resolveSoftFailures({plan: request.rootPlan || request.plan, invalid: validation.invalid, rows: resolvedRows, declaredNameIds, protectedSegments: getSemanticLocalState(request).protectedSegments}) : Object.freeze({kept: Object.freeze({}), remaining: validation.invalid}), nodesById = new Map((request.plan.nodes || []).map(node => [String(node.id), node]));
	for (const id of Object.keys(soft.kept)) valid[id] = segmentKeepText(nodesById.get(id));
	const kept = softKeep ? accumulateKept(request, soft.kept) : Object.freeze({}), keptSummary = summarizeKept(kept);
	const expectedRoot = request.rootSegmentOrder || translatableNodes(request.rootPlan).map(node => node.id), invalidIds = [...new Set(expectedRoot.filter(id => !Object.prototype.hasOwnProperty.call(valid, id)).concat(soft.remaining.map(row => row.id).filter(id => nodesById.has(id))))], ok = validation.unknownIds.length === 0 && validation.duplicateIds.length === 0 && soft.remaining.length === 0 && invalidIds.length === 0;
	// Local ⟦Cn⟧ leaves are restored per range before reassembly; the accumulated `valid` map
	// keeps the wire form so repair rounds and P1 placeholder restore stay unchanged.
	const translation = ok ? reassembleReceivedMarkdown(request.rootPlan, restoreInlineProtectedTranslations(request.rootPlan, valid)) : null;
	return Object.freeze({ok, unchanged: ok && translation === request.rootPlan.source, reason: ok ? null : validation.unknownIds.length ? "unknown-id" : validation.duplicateIds.length ? "duplicate-id" : soft.remaining[0] && soft.remaining[0].reason || "missing-id", valid: Object.freeze(valid), invalidIds: Object.freeze(invalidIds), validation, rows: Object.freeze(rows.slice()), kept, keptCount: keptSummary.keptCount, keptReasons: keptSummary.keptReasons, translation});
}

function planSemanticRepair(request, outcome, {parentSettled = false, maxItems = 10, maxChars = 12000, maxBodyBytes = 65536, maxEstimatedTokens = 16384} = {}) {
	const rootIds=new Set(request.rootSegmentOrder||translatableNodes(request.rootPlan).map(node=>node.id)),segments=translatableNodes(request.rootPlan).filter(node=>rootIds.has(node.id)).map(node => ({id: node.id, text: nodeWireText(node)})), schedule = planPreciseRepair({segments, validIds: Object.keys(outcome && outcome.valid || {}), failedIds: outcome && outcome.invalidIds || [], attempt: request.attempt, parentSettled, maxAttempts: request.maxAttempts, maxItems, maxChars});
	if (!schedule.dispatchable) return Object.freeze({dispatchable: false, reason: schedule.reason, requests: Object.freeze([]), replayedSuccessCount: schedule.replayedSuccessCount});
	const requests = [];
	for (const batch of schedule.batches) {
		const ids = batch.map(item => item.id), plan = subsetPlan(request.rootPlan, ids);
		const includeSourceContext = !!(request.workload && request.workload.fields.sourceContextVersion), includeNameKeep = !!(request.workload && request.workload.fields.nameKeepVersion);
		const compiled = request.adapter === "classic-marked" ? compileClassicMarked(plan, {maxBodyBytes}) : request.adapter === "classic-tagged" ? compileClassicTagged(plan, {maxBodyBytes}) : compileAdapterWire(request.engineKey, plan, {attempt: schedule.nextAttempt, maxAttempts: request.maxAttempts, maxBodyBytes, maxEstimatedTokens, includeSourceContext, includeNameKeep});
		if (!compiled.enabled || !compiled.wire) return Object.freeze({dispatchable: false, reason: compiled.fallbackReason || "serializer-failed", requests: Object.freeze([]), replayedSuccessCount: schedule.replayedSuccessCount});
		const systemPrompt = includeNameKeep && !request.systemPrompt.endsWith(NAME_REPAIR_INSTRUCTION) ? request.systemPrompt + NAME_REPAIR_INSTRUCTION : request.systemPrompt;
		const nextRequest = Object.freeze(Object.assign({}, request, {plan, systemPrompt, wire: compiled.wire, segmentOrder: Object.freeze(ids), segmentAliases: compiled.typed && compiled.typed.aliases || null, contextNameIds: compiled.typed && compiled.typed.contextNameIds || [], attempt: schedule.nextAttempt, bodyBytes: compiled.typed && compiled.typed.bodyBytes || Buffer.byteLength(compiled.wire), estimatedTokens: compiled.typed && compiled.typed.estimatedTokens || Math.ceil(Buffer.byteLength(compiled.wire) / 4)}));
		attachSemanticLocalState(nextRequest, getSemanticLocalState(request));
		requests.push(nextRequest);
	}
	return Object.freeze({dispatchable: true, reason: "candidate", requests: Object.freeze(requests), replayedSuccessCount: schedule.replayedSuccessCount, nextAttempt: schedule.nextAttempt});
}

module.exports = {createSemanticRequest, createSemanticPlanEligibility, isPlanTranslationMeaningful, validateSemanticResponse, planSemanticRepair, parseRows, translatableNodes, attachSemanticLocalState, getSemanticLocalState, hashSemanticSource: hashReceivedMarkdownSource};
