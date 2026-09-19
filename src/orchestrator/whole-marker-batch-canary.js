const {compileWholeMarkerSingle, isExplicitReceivedBodySingle} = require("./whole-marker-single-canary");
const {reassembleWholeMarkerResponse} = require("../planner/translation-whole-marker-wire");
const {buildWholeMarkerBatchRequest, parseWholeMarkerBatchResponse, buildWholeMarkerBatchRepairRequest, mergeWholeMarkerBatchRepair} = require("../planner/translation-whole-marker-batch");
const {historyW5Eligibility} = require("./history-w5-policy");
const trustedResults = new WeakMap();
function local(item, key, value) {Object.defineProperty(item, key, {value, writable: true, configurable: true, enumerable: false});}
function createWholeMarkerBatchCanary({now = Date.now, setTimeout = global.setTimeout, clearTimeout = global.clearTimeout, compile = () => null, validation = () => ({}), itemCurrent = () => true} = {}) {
 let generation = 0, grant = null, timer = null, counts = {admittedMessages: 0, applicationDispatches: 0, repairs: 0};
 const active = new Set();
 const disable = () => {generation++; grant = null; const prior = timer; timer = null; try {if(prior) clearTimeout(prior);} finally {for(const controller of active) controller.abort();}};
 const snapshot = () => Object.freeze(Object.assign({enabled: !!(grant && now() < grant.expiresAt && grant.remaining > 0), generation, remainingMessages: grant && now() < grant.expiresAt ? grant.remaining : 0, activeRequests: active.size}, counts));
 const enable = ({engineKey, channelId, messageIds, maxMessages, ttlMs} = {}) => {
  disable();
  if(typeof engineKey !== "string" || !engineKey || !channelId || !Array.isArray(messageIds) || messageIds.length < 2 || messageIds.length > 20 || new Set(messageIds).size !== messageIds.length || messageIds.some(id => typeof id !== "string" || !id || id.length > 128) || !Number.isInteger(maxMessages) || maxMessages < 2 || maxMessages > 20 || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) return false;
  grant = {engineKey, channelId: String(channelId), ids: new Set(messageIds), remaining: maxMessages, expiresAt: now() + ttlMs}; counts = {admittedMessages: 0, applicationDispatches: 0, repairs: 0}; timer = setTimeout(disable, ttlMs); if(timer && timer.unref) timer.unref(); return true;
 };
 const claim = (engineKey, items, timingContext) => {
  if(!snapshot().enabled || engineKey !== grant.engineKey || !Array.isArray(items) || items.length < 2 || items.length > 10 || items.length > grant.remaining || new Set(items.map(item => String(item && item.message && item.message.id))).size !== items.length) return null;
  const first = items[0], language = first && first.output && first.output.id;
  if(items.some(item => !item || item.wholeMarkerBatchFinal || item.semanticRepair || !item.semanticRequest || !item.semanticRequest.enabled || item.semanticRequest.adapter !== "typed-json" || String(item.channelId) !== grant.channelId || !grant.ids.has(String(item.message && item.message.id)) || !isExplicitReceivedBodySingle(item.message, item.originalContentData, {}) || !item.output || item.output.id !== language || !item.input || item.input.id !== first.input.id)) return null;
  const entries = items.map(item => ({id: String(item.message.id), request: compile(item)}));
  if(entries.some(entry => !entry.request || !entry.request.ok)) return null;
  // Keep the pure History W5 admission contract as a second, side-effect-free
  // gate.  The grant is only consumed below after all eligibility checks pass.
  const eligibility = historyW5Eligibility({
   items: entries,
   engineKey,
   channelId: first && first.channelId,
   grant: {engineKey: grant.engineKey, channelId: grant.channelId, ids: grant.ids, remaining: grant.remaining, expiresAt: grant.expiresAt, enabled: true},
   now
  });
  if (!eligibility.eligible) return null;
  // Multiple replacement spans can move meaning across emphasis boundaries. Keep
  // the original batch on typed before spending any grant or splitting its work.
  if(entries.some(({request}) => !Array.isArray(request.ranges) || request.ranges.length !== 1)) return null;
  // Range-only W5 must not silently remove W4's natural-language context.
  if(entries.some(({request}) => request.windowed === true || request.plan.nodes.some(node => node.kind === "text" && node.classification === "preserve-target" && /\p{L}/u.test(node.raw)))) return null;
  const batch = buildWholeMarkerBatchRequest(entries); if(!batch || !batch.ok) return null;
  const epoch = generation, controller = new AbortController(), previousContext = timingContext && timingContext.requestContext, admission = timingContext && timingContext.historicalAdmission;
  const priorSignal = previousContext && previousContext.signal, retired = new Set();
  const liveSignal = item => item.queueItem && item.queueItem.liveRequest && item.queueItem.liveRequest.signal;
  const signals = [...new Set([priorSignal, ...items.map(item => item.queueItem && item.queueItem.liveRequest && item.queueItem.liveRequest.signal)].filter(Boolean))];
  const abortListeners = new Map();
  for(const signal of signals) {const abort = () => {if(signal === priorSignal || items.some(item => !retired.has(item) && liveSignal(item) === signal)) controller.abort();}; abortListeners.set(signal, abort); signal.addEventListener("abort", abort, {once: true}); if(signal.aborted) abort();}
  // A settled History logical admission is no longer dispatchable, but its paid
  // result remains eligible for the separate job/message commit fence.
  const resultCurrent = () => {try {return !controller.signal.aborted && !(priorSignal && priorSignal.aborted) && epoch === generation && !!grant && now() < grant.expiresAt && items.every(item => retired.has(item) || itemCurrent(item));} catch {return false;}};
  const isCurrent = () => {try {return resultCurrent() && (!previousContext || !previousContext.isCurrent || previousContext.isCurrent()) && (!admission || !admission.isCurrent || admission.isCurrent());} catch {return false;}};
  for(const item of items) {grant.ids.delete(String(item.message.id)); local(item, "wholeMarkerBatchFinal", true); local(item, "wholeMarkerBatchIsCurrent", () => resultCurrent() && (!retired.has(item) || itemCurrent(item)) && !(liveSignal(item) && liveSignal(item).aborted));}
  grant.remaining -= items.length; counts.admittedMessages += items.length; active.add(controller);
  let applications = 0, compatibilityUsed = false;
  const context = Object.assign({}, previousContext, {wholeMarkerBatchCanary: true, logicalRequestId: `w5-${epoch}-${counts.admittedMessages}`, signal: controller.signal, isCurrent, compatibilityBudget: {consume() {if(compatibilityUsed || !isCurrent()) return false; compatibilityUsed = true; return true;}}});
  const finish = () => {active.delete(controller); for(const [signal, abort] of abortListeners) signal.removeEventListener("abort", abort);};
  const fail = reason => {for(const item of items) local(item, "wholeMarkerBatchFailureReason", reason); return {translations: null, failureKind: reason, statusCode: null};};
  const results = (outcome, primaryOnly = false) => {
   const translations = {};
   for(const entry of batch.entries) {
    const item = items.find(item => String(item.message.id) === entry.id), itemOutcome = outcome.items.get(entry.id) || {ok: false, reason: outcome.reason || "missing", valid: {}};
    if(retired.has(item) || primaryOnly && !itemOutcome.ok) continue;
    const raw = Object.freeze({wholeMarkerBatch: Object.freeze({request: entry.request, outcome: itemOutcome, contractRevision: batch.contractRevision})}); trustedResults.set(item, raw); translations[entry.id] = raw; local(item, "wholeMarkerBatchFailureReason", itemOutcome.ok ? null : itemOutcome.reason || "unresolved");
   }
   return translations;
  };
  const run = async dispatch => {
   try {
    const send = async (request, role) => {if(!isCurrent() || applications >= 2) return {failureKind: "stale"}; applications++; counts.applicationDispatches++; if(role === "retry") counts.repairs++; try {return await dispatch(request, role, context);} catch {return {failureKind: "transient"};}};
    const firstResponse = await send(batch, "primary"); if(!isCurrent()) return fail("stale"); if(firstResponse.failureKind) return Object.assign(fail(firstResponse.failureKind), {statusCode: firstResponse.statusCode || null});
    let outcome = parseWholeMarkerBatchResponse(batch, firstResponse.text, validation(first));
    if(outcome.rootMalformed) return fail(outcome.reason || "malformed");
    const repair = buildWholeMarkerBatchRepairRequest(batch, outcome);
    if(repair && repair.ok) {
     // Only the Live queue may settle primary successes before the combined repair.
     // Its synchronous validator/commit path claims each item before display ACK can
     // retire that item's signal; the physical slot and remaining items stay active.
     if(!admission && items.every(item => !!liveSignal(item)) && timingContext && typeof timingContext.onPrimaryResults === "function") {
      const primaryResults = results(outcome, true);
      const retireItem = item => {
       if(!items.includes(item) || retired.has(item) || !Object.prototype.hasOwnProperty.call(primaryResults, String(item.message.id)) || !isCurrent()) return false;
       retired.add(item);
       const signal = liveSignal(item);
       if(signal !== priorSignal && !items.some(other => !retired.has(other) && liveSignal(other) === signal)) {signal.removeEventListener("abort", abortListeners.get(signal)); abortListeners.delete(signal);}
       return true;
      };
      try {const notified = timingContext.onPrimaryResults(primaryResults, retireItem); if(notified && typeof notified.then === "function") Promise.resolve(notified).catch(() => {});} catch {}
     }
     const response = await send(repair, "retry"); if(!isCurrent()) return fail("stale");
     if(response.failureKind) {for(const entry of repair.entries) {const failed = {ok: false, reason: response.failureKind, repairable: false, valid: {}}; outcome.items.set(entry.id, failed); outcome.valid.delete(entry.id);}}
     else outcome = mergeWholeMarkerBatchRepair(batch, outcome, repair, parseWholeMarkerBatchResponse(repair, response.text, validation(first)));
    }
    if(!isCurrent()) return fail("stale");
    return {translations: results(outcome), failureKind: null, statusCode: 200};
   } catch {return fail("malformed");} finally {finish();}
  };
  return {run};
 };
 return Object.freeze({enable, disable, snapshot, claim});
}
function validateWholeMarkerBatchResult(plugin, prepared, raw, job) {
 const reject = reason => ({ok: false, terminal: true, reason});
 if(!prepared || !prepared.wholeMarkerBatchFinal || !raw || trustedResults.get(prepared) !== raw) return reject(prepared && prepared.wholeMarkerBatchFailureReason || "w5-invalid-result");
 if(!prepared.wholeMarkerBatchIsCurrent()) return reject("stale");
 const {request, outcome, contractRevision} = raw.wholeMarkerBatch, expected = compileWholeMarkerSingle(plugin, prepared.semanticRequest);
 const identity = value => JSON.stringify([value.plan, value.wire, value.ranges, value.protectedSegments, value.validatorVersion, value.contractRevision]);
 if(!expected || identity(expected) !== identity(request) || String(job.channelId) !== String(prepared.channelId) || prepared.message.content !== prepared.originalContentData.content) return reject("w5-source-mismatch");
 if(!outcome.ok) return reject(outcome.reason || "unresolved");
 const translation = plugin.addSemanticExceptions(reassembleWholeMarkerResponse(request, outcome.valid), request.protectedSegments);
 const stored = plugin.createStoredReceivedTranslationData(prepared.message, job.channelId, prepared.originalContentData, prepared.signature, translation, prepared.input, prepared.output, true);
 if(!stored) return reject("w5-empty-result");
 stored.wholeMarkerBatch = true; stored.validatorVersion = request.validatorVersion; stored.wireVersion = request.wireVersion; stored.reassemblyVersion = contractRevision;
 return {ok: true, translation: stored};
}
module.exports = {createWholeMarkerBatchCanary, validateWholeMarkerBatchResult};
