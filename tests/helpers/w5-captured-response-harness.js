"use strict";
// Reuse the established real-plugin harness boundaries: in-memory transport and display ACK.
const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("./createPluginInstance");
const CURRENT = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const ENGINE = "custom-w5owners", CHANNEL = "w5-owner-channel";
const message = row => ({id: row.id, channel_id: CHANNEL, content: row.content, embeds: [], attachments: [], author: {id: "other-user"}});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
async function until(predicate, label) {const deadline = Date.now() + 3000; while (Date.now() < deadline) {if (predicate()) return; await new Promise(r => setTimeout(r, 5));} assert.ok(predicate(), label);}

function harness(script, {nativeFetch = true} = {}) {
 const requests = [], commits = [], cacheWrites = [], skipWrites = [], singles = [], errors = [], views = new Map(), messages = new Map();
 const dispatch = async (url, options, transport) => {
  assert.match(url, /^https:\/\/w5-owner\.fixture\//, "only in-memory fixture requests");
  const outer = JSON.parse(options.body), payload = JSON.parse(outer.messages.at(-1).content);
  const call = {payload, body: String(options.body), signal: options.signal, transport, family: payload && !Array.isArray(payload) && Object.keys(payload).every(key => /^[1-9]\d*\.[1-9]\d*$/.test(key)) ? "D-batch" : payload.schemaVersion}; requests.push(call);
  const content = await script({payload, call, index: requests.length, requests});
  return new Response(JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}], usage: {prompt_tokens: 12, completion_tokens: 7}}), {status: 200, headers: {"content-type": "application/json"}});
 };
 const request = (url, options, callback) => {dispatch(url, options, "callback").then(async result => callback(null, {statusCode: result.status, headers: {}}, await result.text())).catch(error => {errors.push(String(error)); callback(error);}); return {abort() {}};};
 const plugin = createPluginInstance({pluginPath: CURRENT, callSetLanguages: false, bdfdb: {LibraryRequires: {request}}, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]}, performance: {historicalConcurrency: "1", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: false, compactWireShadow: "off"}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wordStart: ["!"], protectedTerms: [], wrapperPairs: [], protectedTermsForReceived: true, wrapperPairsForReceived: true}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
 if (nativeFetch) global.BdApi.Net = {fetch: (url, options) => dispatch(url, options, "native")}; else delete global.BdApi.Net;
 try {plugin.onLoad();} catch {}
 plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Fixture"}];
 try {plugin.setLanguages();} catch {} try {plugin.onStart();} catch {}
 plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://w5-owner.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
 plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
 plugin.getEffectivePrimaryEngine = () => ENGINE; plugin.getEffectiveBackupEngine = () => "----"; plugin.getHistoricalAiBatchEngineKey = () => ENGINE; plugin.getHistoricalPrimaryEngineKey = () => ENGINE;
 plugin.isEngineConfiguredForRuntime = () => true; plugin.validTranslator = () => true; plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true;
 plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null;
 plugin.isTranslationLikelyInTargetLanguage = value => /[\p{Script=Han}]/u.test(String(value || "")); plugin.getTextSimilarityScore = (a,b) => String(a).trim() === String(b).trim() ? 1 : 0;
 plugin.persistTranslationCacheEntry = (...args) => cacheWrites.push(args); plugin.persistReceivedSkipDecision = (...args) => skipWrites.push(args);
 plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
 plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null;
 plugin.commitHistoricalReceivedDisplayBatch = results => {commits.push(results); for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false})); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
 plugin.commitReceivedDisplayResult = result => {commits.push(result); views.set(String(result.messageId), result); return Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []});};
 plugin.applyStoredTranslationToMessage = () => {}; plugin.scheduleReceivedDisplayFlush = () => {};
 return {plugin, requests, commits, cacheWrites, skipWrites, singles, errors, views, messages};
}
function grant(h, rows) {const provider = h.plugin.ensureProviderClient(); assert.equal(typeof provider.enableWholeMarkerBatchCanary, "function", "W5 session grant public API"); assert.equal(provider.enableWholeMarkerBatchCanary({engineKey: ENGINE, channelId: CHANNEL, messageIds: rows.map(row => row.id), maxMessages: 20, ttlMs: 300000}), true); return provider;}
function runHistory(h, rows) {for (const row of rows) assert.equal(h.plugin.queueAutoTranslateMessage((h.messages.set(row.id, message(row)), h.messages.get(row.id)), {id: CHANNEL}, {content: row.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true); return h.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);}
async function runLive(h, rows) {const queue = h.plugin.ensureLiveTranslationQueue(); h.plugin.translateMessage = item => {h.singles.push(String(item.id)); return Promise.resolve(false);}; queue.setBusyTranslating(true); for (const row of rows) assert.equal(h.plugin.queueAutoTranslateMessage((h.messages.set(row.id, message(row)), h.messages.get(row.id)), {id: CHANNEL}, {content: row.content, embeds: []}), true); queue.setBusyTranslating(false); queue.processQueue(); await until(() => queue.getQueueLength() === 0 && !queue.isLiveAutoTranslating(), "all live items settle");}
function assertNoW5Cache(h) {assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.skipWrites, []); const store = h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot(); assert.equal(store.activeRequests, 0);}
function assertResources(h) {const provider = h.plugin.ensureProviderClient(); assert.equal(provider.getProviderAttemptSnapshot().active, 0); const s = h.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(s.physical.active, 0); assert.equal(s.historicalAbortControllerCount, 0); assert.deepEqual(s.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0}); assert.deepEqual(h.errors, []);}
async function close(h) {try {await h.plugin.onStop();} finally {delete global.BdApi.Net;}}


module.exports = {harness, grant, runLive, runHistory, close, ENGINE, CHANNEL};
