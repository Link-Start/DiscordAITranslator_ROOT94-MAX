const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const CHANNEL = "manual-cache-cost-fixture", ENGINE = "custom-manualcachecost";
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const item = () => ({id: "paid-message", channel_id: CHANNEL, content: "Please translate this short sentence.", embeds: [], attachments: [], author: {id: "synthetic-author"}});
const TEXT = "请翻译这个简短句子。";

// The public translateMessage, display/cache owners, signatures and guards are real
// bundle methods. Signature observation delegates to the unchanged public method. HTTP, disk, Discord Store and host timers
// are synthetic boundaries. No real network or Discord DOM is involved.
function harness({responseText = TEXT, beforeResponse = () => {}} = {}) {
 const disk = {}, timers = new Map(), messages = new Map(), requests = [], cacheLoads = [], cacheSaves = [];
 let timerId = 0, failCacheSave = false;
 const fetch = async (_url, options) => {
  const body = JSON.parse(options.body), wire = body.messages.at(-1).content; requests.push(wire);
  assert.equal(wire.startsWith("{"), true, "the default remains typed JSON, not compact canary");
  const answer = JSON.stringify({segments: JSON.parse(wire).segments.map(row => ({id: row.id, translation: responseText}))});
  beforeResponse({body, wire});
  return {status: 200, headers: {get: () => "application/json"}, text: async () => JSON.stringify({choices: [{message: {content: answer}, finish_reason: "stop"}]})};
 };
 const request = (url, options, callback) => {let cancelled = false; fetch(url, options).then(async response => {if (!cancelled) callback(null, {statusCode: response.status, headers: {}}, await response.text());}, error => {if (!cancelled) callback(error);}); return {abort() {cancelled = true;}};};
 const plugin = createPluginInstance({callSetLanguages: false, bdfdb: {
  LibraryRequires: {request}, dotCN: new Proxy({}, {get: (_t, key) => "." + String(key)}), dotCNS: new Proxy({}, {get: (_t, key) => "." + String(key) + " "}),
  LibraryStores: {MessageStore: {getMessage: (channelId, id) => messages.get(channelId + ":" + id) || null}},
  TimeUtils: {timeout: (callback, delay) => {timers.set(++timerId, {callback, delay}); return timerId;}, interval: callback => {timers.set(++timerId, {callback, interval: true}); return timerId;}, clear: id => timers.delete(id)},
  DataUtils: {load: (_plugin, key) => {if (key === "translationCache") cacheLoads.push(clone(disk[key])); return clone(disk[key]);}, save: (value, _plugin, key) => {if (key === "translationCache") {cacheSaves.push(clone(value)); if (failCacheSave) throw new Error("synthetic disk failure");} disk[key] = clone(value);}}
 }, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Manual cache cost fixture"}]}, performance: {liveStreaming: false}, filters: {skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
 global.BdApi.Net = {fetch};
 plugin.onLoad(); plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Manual cache cost fixture"}]; plugin.setLanguages();
 disk.authKeys = {[ENGINE]: {key: "synthetic", endpoint: "https://manual-cache-cost.invalid/v1/chat/completions", model: "synthetic-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}};
 plugin.ensureSettingsStore().replaceAuthKeys(clone(disk.authKeys));
 plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place][type];
 plugin.isTranslationEnabled = () => true; plugin.isOwnMessage = () => false;
 plugin.ensureTranslationCacheStore().loadPersisted();
 const capture = message => {
  messages.set(CHANNEL + ":" + message.id, message);
  const source = plugin.extractOriginalContentData(message), signature = plugin.createReceivedTranslationSignature(message, CHANNEL, source);
  plugin.ensureReceivedDisplayRuntime().captureSource({messageId: message.id, channelId: CHANNEL, generation: plugin.getReceivedDisplayCommitGeneration(CHANNEL), sourceSignature: signature, source});
  return {source, signature};
 };
 return {plugin, disk, requests, cacheLoads, cacheSaves, capture, failCacheSave(value) {failCacheSave = value;},
  seed(message = item()) {const {source, signature} = capture(message), stored = plugin.createStoredReceivedTranslationData(message, CHANNEL, source, signature, TEXT, {id: "en"}, {id: "zh-CN"}, false); plugin.persistTranslationCacheEntry(message.id, signature, stored); return message;},
  async close() {failCacheSave = false; await plugin.onStop(); delete global.BdApi.Net; assert.equal(timers.size, 0, "host timer handles retire");}
 };
}
const run = (h, message) => h.plugin.translateMessage(message, {id: CHANNEL}, {manual: true, silent: true, trackBusy: false});


// Count only the public operation, after a valid paid result and source capture exist.
// Do not stub lookup/display/signature or infer a cache hit from a false toggle result.
function observeSignatures(plugin) {
 const original = plugin.createReceivedTranslationSignature;
 const calls = [];
 plugin.createReceivedTranslationSignature = function (...args) {const result = original.apply(this, args); calls.push({messageId: args[0] && args[0].id, channelId: args[1], result}); return result;};
 return calls;
}

test("manual paid cache hit displays the guarded result with one public signature computation and zero requests", async () => {
 const h = harness();
 try {
  const message = h.seed();
  assert.ok(h.plugin.getCachedReceivedTranslation(message, CHANNEL), "the seed passes the independent real cache guards");
  const signatures = observeSignatures(h.plugin);
  assert.equal(await run(h, message), true);
  assert.equal(h.requests.length, 0);
  const terminal = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
  assert.equal(terminal.cacheRead, "translation-hit"); assert.equal(terminal.outcome, "translated"); assert.equal(terminal.reason, "translation_hit"); assert.equal(terminal.displayCommit, "cache-applied");
  const view = h.plugin.getReceivedDisplayRuntimeView(message.id);
  assert.equal(view.translation.translatedContent, TEXT); assert.equal(view.translation.originalContent, message.content);
  assert.equal(view.translation.channelId, CHANNEL); assert.equal(view.translation.manual, true);
  assert.equal(signatures.length, 1, "manual cache hit must not construct the discarded pipeline signature in addition to the cache owner's signature");
  assert.equal(h.plugin.ensureTranslationPipeline().getWholeMarkerSingleCanarySnapshot().enabled, false);
 } finally {await h.close();}
});


test("manual cache miss still dispatches once and persists a usable signature for the final configuration", async () => {
 const h = harness(), message = item();
 try {
  const {signature} = h.capture(message);
  assert.equal(await run(h, message), true); assert.equal(h.requests.length, 1);
  const sent = JSON.parse(h.requests[0]); assert.equal(sent.targetLanguageId, "zh-CN");
  const entry = h.plugin.getPersistedTranslationCacheEntry(message.id);
  assert.ok(entry); assert.equal(h.plugin.ensureTranslationCacheStore().matchesSignature(entry, signature), true);
  assert.equal(entry.translation.translatedContent, TEXT); assert.equal(entry.translation.originalContent, message.content);
  assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).cacheRead, "miss");
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id).translation.translatedContent, TEXT);
  assert.ok(h.plugin.getCachedReceivedTranslation(item(), CHANNEL), "the newly paid result passes the independent cache lookup");
 } finally {await h.close();}
});

test("formatted cache cannot bypass the new semantic contract through an unchanged legacy source signature", async () => {
 const h = harness({responseText: "请在周五前⟦F0⟧不要发布⟦/F0⟧这份草稿。"});
 const message = {...item(), content: "Please **do not publish** the draft before Friday."};
 try {
  const {source} = h.capture(message), plugin = h.plugin;
  // This is the exact pre-format signature constructor, not a modified current signature.
  const oldSignature = JSON.stringify(Object.assign({}, plugin.getReceivedTranslationConfigurationData(CHANNEL), {content: source.content || "", embeds: source.embeds || []}));
  const old = plugin.createStoredReceivedTranslationData(message, CHANNEL, source, oldSignature, "请**不要发布**周五之前的草稿。", {id:"en"}, {id:"zh-CN"}, false);
  const request = plugin.createAtomicSemanticRevisionContract(message.content, {place:"received", channelId:CHANNEL, inputLanguageId:"en", targetLanguageId:"zh-CN"});
  const previous = require("../../src/planner/translation-semantic-revision").createSemanticWorkloadKey({...request.workload.fields, inlineFormatting:false});
  Object.assign(old, {semanticRevision:request.semanticRevision, semanticWorkloadKey:previous.key, plannerVersion:request.plan.plannerVersion, planHash:plugin.getAtomicSemanticPlanHash(request), validatorVersion:previous.fields.validatorVersion, outputSchemaVersion:previous.fields.outputSchemaVersion});
  plugin.persistTranslationCacheEntry(message.id, oldSignature, old);
  assert.equal(plugin.getCachedReceivedTranslation(message, CHANNEL, source), null, "old fragmented translation is not reusable through the direct signature hit");
  assert.equal(await run(h, message), true);
  assert.equal(h.requests.length, 1);
  assert.equal(plugin.getCachedReceivedTranslation(message, CHANNEL, source).translatedContent, "请在周五前**不要发布**这份草稿。");
  assert.equal(h.requests.length, 1, "the newly translated result is reusable without a second request");
 } finally {await h.close();}
});

test("legacy fallback cache for code containing a star remains reusable without semantic metadata or another request", async () => {
 const h = harness(), message = {...item(), content: "Please keep `a*b` unchanged while checking the report."};
 try {
  const {source} = h.capture(message), plugin = h.plugin;
  const oldSignature = JSON.stringify(Object.assign({}, plugin.getReceivedTranslationConfigurationData(CHANNEL), {content:source.content, embeds:source.embeds || []}));
  const stored = plugin.createStoredReceivedTranslationData(message, CHANNEL, source, oldSignature, "检查报告时，请保留 `a*b` 不变。", {id:"en"}, {id:"zh-CN"}, false);
  plugin.persistTranslationCacheEntry(message.id, oldSignature, stored);
  assert.equal(await run(h, message), true);
  assert.equal(h.requests.length, 0, "formatting inside protected code did not change the translation contract");
  assert.equal(plugin.getReceivedDisplayRuntimeView(message.id).translation.translatedContent, "检查报告时，请保留 `a*b` 不变。");
  const entry = plugin.getPersistedTranslationCacheEntry(message.id);
  assert.equal(plugin.ensureTranslationCacheStore().matchesSignature(entry, plugin.createReceivedTranslationSignature(message, CHANNEL, source)), true, "compatibility check migrates the signature once");
 } finally {await h.close();}
});


test("automatic currentness rejects an invalidated live request before reading valid paid cache", async () => {
 const h = harness();
 try {
  const message = h.seed(), source = h.plugin.extractOriginalContentData(message);
  const live = h.plugin.createLiveTranslationRequest(message, CHANNEL, source);
  assert.ok(live); h.plugin.invalidateLiveTranslationRequests(CHANNEL); assert.equal(live.signal.aborted, true);
  let lookups = 0; const lookup = h.plugin.getCachedReceivedTranslation;
  h.plugin.getCachedReceivedTranslation = function (...args) {lookups++; return lookup.apply(this, args);};
  const signatures = observeSignatures(h.plugin);
  assert.equal(await h.plugin.translateMessage(message, {id: CHANNEL}, {auto: true, liveRequest: live, silent: true, trackBusy: false}), false);
  assert.equal(lookups, 0); assert.equal(h.requests.length, 0); assert.equal(signatures.length, 1, "auto retains its eager signature before currentness even with a paid cache entry");
  const terminal = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
  assert.equal(terminal.outcome, "stale"); assert.equal(terminal.reason, "stale_before_request");
  const view = h.plugin.getReceivedDisplayRuntimeView(message.id); assert.ok(!view || !view.translated);
  assert.ok(h.plugin.getPersistedTranslationCacheEntry(message.id), "stale auto work does not erase the paid cache");
 } finally {await h.close();}
});


test("independent cache lookup still rechecks source, channel and target configuration without pipeline precomputation", async () => {
 const h = harness();
 try {
  const message = h.seed();
  assert.ok(h.plugin.getCachedReceivedTranslation(message, CHANNEL));
  const entryBefore = clone(h.plugin.getPersistedTranslationCacheEntry(message.id)); // after the normal display-metadata upgrade
  const edited = {...item(), content: "Please bring the red notebook."};
  assert.equal(h.plugin.getCachedReceivedTranslation(edited, CHANNEL), null);
  assert.equal(h.plugin.getCachedReceivedTranslation(message, "different-channel"), null);
  h.plugin.settings.choices.received.output = "ja";
  assert.equal(h.plugin.getCachedReceivedTranslation(message, CHANNEL), null);
  h.plugin.settings.choices.received.output = "zh-CN";
  assert.ok(h.plugin.getCachedReceivedTranslation(message, CHANNEL));
  assert.deepEqual(h.plugin.getPersistedTranslationCacheEntry(message.id), entryBefore);
  assert.equal(h.requests.length, 0);
 } finally {await h.close();}
});


test("manual miss after a synchronous cache-boundary target change signs the actual final dispatch configuration", async () => {
 const japanese = "この短い文を翻訳してください。", h = harness({responseText: japanese});
 try {
  const message = h.seed(), before = h.plugin.createReceivedTranslationSignature(message, CHANNEL, h.plugin.extractOriginalContentData(message));
  const lookup = h.plugin.getCachedReceivedTranslation; let changed = false, expected;
  h.plugin.getCachedReceivedTranslation = function (...args) {
   if (!changed) {changed = true; this.settings.choices.received.output = "ja"; expected = this.createReceivedTranslationSignature(args[0], args[1], args[2]);}
   return lookup.apply(this, args); // real owner must reject the old zh-CN cached signature
  };
  assert.equal(await run(h, message), true); assert.equal(changed, true); assert.equal(h.requests.length, 1);
  assert.notEqual(expected, before); assert.equal(JSON.parse(h.requests[0]).targetLanguageId, "ja");
  const entry = h.plugin.getPersistedTranslationCacheEntry(message.id);
  assert.equal(h.plugin.ensureTranslationCacheStore().matchesSignature(entry, expected), true, "stored signature describes the configuration actually sent, not the discarded pre-lookup configuration");
  assert.equal(h.plugin.ensureTranslationCacheStore().matchesSignature(entry, before), false);
  assert.equal(entry.translation.output.id, "ja"); assert.equal(entry.translation.translatedContent, japanese);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(message.id).translation.translatedContent, japanese);
  assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).cacheRead, "miss");
 } finally {await h.close();}
});


test("manual miss after a cache-boundary target change still rejects a late response after a newer configuration", async () => {
 let h;
 h = harness({responseText: "この短い文を翻訳してください。", beforeResponse: () => {h.plugin.settings.choices.received.output = "zh-CN";}});
 try {
  const message = h.seed(); assert.ok(h.plugin.getCachedReceivedTranslation(message, CHANNEL));
  const before = clone(h.plugin.getPersistedTranslationCacheEntry(message.id));
  const lookup = h.plugin.getCachedReceivedTranslation; let changed = false;
  h.plugin.getCachedReceivedTranslation = function (...args) {if (!changed) {changed = true; this.settings.choices.received.output = "ja";} return lookup.apply(this, args);};
  assert.equal(await run(h, message), false); assert.equal(h.requests.length, 1);
  assert.equal(JSON.parse(h.requests[0]).targetLanguageId, "ja");
  assert.equal(h.plugin.settings.choices.received.output, "zh-CN");
  const terminal = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
  assert.equal(terminal.outcome, "stale"); assert.equal(terminal.reason, "stale_after_provider");
  const view = h.plugin.getReceivedDisplayRuntimeView(message.id); assert.ok(!view || !view.translated, "outdated Japanese output is not displayed");
  assert.deepEqual(h.plugin.getPersistedTranslationCacheEntry(message.id), before, "late result never overwrites the previously paid entry");
 } finally {await h.close();}
});
