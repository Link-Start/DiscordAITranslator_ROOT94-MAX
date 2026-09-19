const {sha256Hex} = require("../diagnostics/sha256");
const {planReceivedMarkdown, hashReceivedMarkdownSource} = require("../planner/received-markdown-lossless-planner");
const {buildWholeMarkerRequest, buildWholeMarkerRepairRequest, mergeWholeMarkerRepair, parseWholeMarkerResponse, reassembleWholeMarkerResponse, WHOLE_MARKER_VERSION, WHOLE_MARKER_VALIDATOR_VERSION} = require("../planner/translation-whole-marker-wire");

// Session-only, explicit and bounded. Neither settings nor the shadow flag can grant a lease.
function createWholeMarkerSingleCanary({now = Date.now, setTimeout = global.setTimeout, clearTimeout = global.clearTimeout} = {}) {
 let generation = 0, grant = null, timer = null;
 const active = new Set();
 let counts = {admittedMessages: 0, applicationDispatches: 0, dDispatches: 0, repairs: 0, typedFallbacks: 0};
 const disable = () => {generation++; grant = null; const pendingTimer = timer; timer = null; try {if (pendingTimer) clearTimeout(pendingTimer);} finally {for (const lease of [...active]) lease.abort();}};
 const snapshot = () => Object.freeze(Object.assign({enabled: !!(grant && now() < grant.expiresAt && grant.remaining > 0), generation, remainingMessages: grant && now() < grant.expiresAt ? grant.remaining : 0, activeRequests: active.size}, counts));
 const enable = ({channelId, messageIds, maxMessages, ttlMs, cache = false} = {}) => {
  disable();
  if (!channelId || !Array.isArray(messageIds) || !messageIds.length || messageIds.length > 20 || messageIds.some(id => typeof id !== "string" || !id || id.length > 128) || !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 20 || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) return false;
  counts = {admittedMessages: 0, applicationDispatches: 0, dDispatches: 0, repairs: 0, typedFallbacks: 0};
  grant = {cache: cache === true, channelId: String(channelId), ids: new Set(messageIds), remaining: maxMessages, expiresAt: now() + ttlMs};
  timer = setTimeout(disable, ttlMs); if (timer && typeof timer.unref === "function") timer.unref();
  return true;
 };
 const claim = ({channelId, messageId, signal, isCurrent}) => {
  if (!snapshot().enabled || String(channelId) !== grant.channelId || !grant.ids.has(String(messageId))) return null;
  const epoch = generation, controller = new AbortController();
  grant.ids.delete(String(messageId)); grant.remaining--; counts.admittedMessages++;
  let applications = 0, released = false;
  const abort = () => controller.abort();
  const lease = Object.freeze({signal: controller.signal, abort, cacheEnabled: grant.cache,
   isCurrent: () => !released && !controller.signal.aborted && epoch === generation && !!grant && now() < grant.expiresAt && (!isCurrent || isCurrent()),
   dispatch(kind) {if (applications >= 2 || !lease.isCurrent()) return false; applications++; counts.applicationDispatches++; if (kind === "typed") counts.typedFallbacks++; else {counts.dDispatches++; if (kind === "repair") counts.repairs++;} return true;},
   finish() {if (released) return; released = true; active.delete(lease); abort(); if (signal) signal.removeEventListener("abort", abort);}
  });
  active.add(lease); if (signal) {signal.addEventListener("abort", abort, {once: true}); if (signal.aborted) abort();}
  return lease;
 };
 return Object.freeze({enable, disable, snapshot, claim});
}
function isExplicitReceivedBodySingle(message, original, options) {
 if (!message || typeof message.content !== "string" || !message.content.trim() || !original || original.content !== message.content) return false;
 if (message.type != null && message.type !== 0 || options.historicalTraceContext || options.historicalLoad || options.latencyKind === "historical" || options.semanticFieldPath && options.semanticFieldPath !== "body") return false;
 if (options.auto && options.liveSingleSource !== "direct-single") return false;
 for (const value of [message.embeds, original.embeds, message.attachments, message.message_snapshots, message.messageSnapshots]) if (value && Object.keys(value).length) return false;
 for (const key of ["message_reference", "messageReference", "referenced_message", "referencedMessage", "reference", "snapshot"]) if (message[key] || original[key]) return false;
 return true;
}
function compileWholeMarkerSingle(plugin, typed) {
 try {
  if (!typed || typed.adapter !== "typed-json" || !typed.enabled || !typed.plan) return null;
  const state = plugin.getAtomicSemanticLocalState(typed), sourcePlan = typed.rootPlan || typed.plan, source = String(sourcePlan.source);
  const plan = planReceivedMarkdown(source, {direction: "received", fieldPath: "body", targetLanguageId: typed.targetLanguageId});
  if (hashReceivedMarkdownSource(source) !== typed.plan.sourceHash || source.length !== typed.plan.sourceLength || plan.sourceHash !== typed.plan.sourceHash || plan.sourceLength !== typed.plan.sourceLength || plan.plannerVersion !== typed.plan.plannerVersion || String(plan.targetLanguageId) !== String(typed.targetLanguageId)) return null;
  const request = buildWholeMarkerRequest(plan, state.protectedSegments, {targetLanguageId: typed.targetLanguageId, allowSourceSpoilerEcho: true});
  return request.ok ? request : null;
 } catch {return null;}
}
// Called only under an explicit cache-enabled lease. Auth values never leave this helper.
function createWholeMarkerCacheIdentity(plugin, request, context, input, output, engineKey) {
 if (!request || !request.ok || !request.plan) return null;
 const config = plugin.getReceivedTranslationRequestConfigurationData(context.channelId), provider = plugin.ensureProviderClient();
 const auth = plugin.ensureSettingsStore().getAuthKeys()[engineKey] || {}, reasoning = provider.getReasoningControlStatus(engineKey);
 const digest = value => sha256Hex(JSON.stringify(value));
 return Object.freeze({messageId: String(context.messageId), channelId: String(context.channelId), source: context.source,
  inputLanguageId: input.id, targetLanguageId: output.id,
  providerHash: digest({fingerprint: provider.getEngineConfigFingerprint(engineKey), endpoint: auth.endpoint || "", model: auth.model || reasoning.model, candidateId: reasoning.candidateId, support: reasoning.support, resolvedValue: reasoning.resolvedValue, format: reasoning.format, adapterVersion: reasoning.adapterVersion, mode: reasoning.mode, profile: reasoning.effectiveProfile, schema: reasoning.schemaId, raw: reasoning.dispatchedRaw, onRaw: reasoning.onRaw, temperature: 0.2, top_p: 0.8}),
  promptHash: digest([request.promptVersion, request.systemPrompt]),
  protectionHash: digest([config, request.protectedSegments]),
  policyHash: digest([plugin.getReceivedTranslationPolicyConfigurationData(), {maxSimilarity: 0.94, strict: true}]),
  planHash: digest([context.source, request.plan, request.ranges, request.contextMarkers, request.wire]),
  plannerVersion: request.plan.plannerVersion, wireVersion: request.wireVersion, validatorVersion: request.validatorVersion,
  reassemblyVersion: "whole-marker-reassembly-v1:" + request.contractRevision + ":" + config.protectionVersion
 });
}
function runWholeMarkerSingle({plugin, request, lease, dispatch, dispatchTyped, finish, validation, onFailure = () => {}}) {
 const send = (request, role, callback) => {let settled = false; dispatch(request, role, (raw, providerFailure) => {if (settled) return; settled = true; if (providerFailure && providerFailure.terminalFailure === "auth" && [401, 403].includes(providerFailure.httpStatus)) return finish("", {reason: lease.isCurrent() ? "auth" : "stale"}); callback(raw);});};
 const typedFallback = () => {if (!lease.dispatch("typed")) return finish("", {reason: "stale"}); dispatchTyped();};
 if (!request) return typedFallback();
 if (!lease.dispatch("primary")) return finish("", {reason: "stale"});
 send(request, "primary", raw => {
  if (!lease.isCurrent()) return finish("", {reason: "stale"});
  const outcome = parseWholeMarkerResponse(request, raw, validation);
  if (!outcome.ok) onFailure(outcome);
  if (!outcome.ok && !outcome.repairable) return typedFallback();
  if (!outcome.ok && outcome.repairable) {
   const repair = buildWholeMarkerRepairRequest(request, outcome.repairOrdinals);
   if (repair.ok && lease.dispatch("repair")) return send(repair, "repair", repairRaw => {
    if (!lease.isCurrent()) return finish("", {reason: "stale"});
    const merged = mergeWholeMarkerRepair(request, outcome, repair, parseWholeMarkerResponse(repair, repairRaw, validation));
    finish(merged.ok ? plugin.addSemanticExceptions(reassembleWholeMarkerResponse(request, merged.valid), request.protectedSegments) : "", {reason: merged.reason});
   });
  }
  finish(outcome.ok ? plugin.addSemanticExceptions(reassembleWholeMarkerResponse(request, outcome.valid), request.protectedSegments) : "", {reason: outcome.reason});
 });
}
module.exports = {createWholeMarkerCacheIdentity, createWholeMarkerSingleCanary, isExplicitReceivedBodySingle, compileWholeMarkerSingle, runWholeMarkerSingle, WHOLE_MARKER_VERSION, WHOLE_MARKER_VALIDATOR_VERSION};
