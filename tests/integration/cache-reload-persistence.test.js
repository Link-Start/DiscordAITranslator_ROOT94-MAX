const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const CHANNEL = "cache-reload-fixture", ENGINE = "custom-cachereload";
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const item = () => ({id: "paid-message", channel_id: CHANNEL, content: "Please translate this short sentence.", embeds: [], attachments: [], author: {id: "synthetic-author"}});
const TEXT = "请翻译这个简短句子。";

// The public translateMessage, display owner, cache owner, signatures, guards and
// forceUpdateAll are real bundle methods. HTTP, disk, Discord Store and host timers
// are synthetic boundaries. No real network or Discord DOM is involved.
function harness() {
 const disk = {}, timers = new Map(), messages = new Map(), requests = [], cacheLoads = [], cacheSaves = [];
 let timerId = 0, failCacheSave = false;
 const fetch = async (_url, options) => {
  const body = JSON.parse(options.body), wire = body.messages.at(-1).content; requests.push(wire);
  assert.equal(wire.startsWith("{"), true, "the default remains typed JSON, not compact canary");
  const answer = JSON.stringify({segments: JSON.parse(wire).segments.map(row => ({id: row.id, translation: TEXT}))});
  return {status: 200, headers: {get: () => "application/json"}, text: async () => JSON.stringify({choices: [{message: {content: answer}, finish_reason: "stop"}]})};
 };
 const request = (url, options, callback) => {let cancelled = false; fetch(url, options).then(async response => {if (!cancelled) callback(null, {statusCode: response.status, headers: {}}, await response.text());}, error => {if (!cancelled) callback(error);}); return {abort() {cancelled = true;}};};
 const plugin = createPluginInstance({callSetLanguages: false, bdfdb: {
  LibraryRequires: {request}, dotCN: new Proxy({}, {get: (_t, key) => "." + String(key)}), dotCNS: new Proxy({}, {get: (_t, key) => "." + String(key) + " "}),
  LibraryStores: {MessageStore: {getMessage: (channelId, id) => messages.get(channelId + ":" + id) || null}},
  TimeUtils: {timeout: (callback, delay) => {timers.set(++timerId, {callback, delay}); return timerId;}, interval: callback => {timers.set(++timerId, {callback, interval: true}); return timerId;}, clear: id => timers.delete(id)},
  DataUtils: {load: (_plugin, key) => {if (key === "translationCache") cacheLoads.push(clone(disk[key])); return clone(disk[key]);}, save: (value, _plugin, key) => {if (key === "translationCache") {cacheSaves.push(clone(value)); if (failCacheSave) throw new Error("synthetic disk failure");} disk[key] = clone(value);}}
 }, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Cache reload fixture"}]}, performance: {liveStreaming: false}, filters: {skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
 global.BdApi.Net = {fetch};
 plugin.onLoad(); plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Cache reload fixture"}]; plugin.setLanguages();
 disk.authKeys = {[ENGINE]: {key: "synthetic", endpoint: "https://cache-reload.invalid/v1/chat/completions", model: "synthetic-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}};
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

test("public paid typed translation survives forceUpdateAll inside 300 ms and does not request again", async () => {
 const h = harness(), message = item();
 try {
  h.capture(message); assert.equal(await run(h, message), true); assert.equal(h.requests.length, 1);
  assert.ok(h.plugin.getPersistedTranslationCacheEntry(message.id)); assert.equal(h.disk.translationCache, undefined, "the debounce timer has not fired");
  assert.equal(await run(h, message), false, "the second manual click is restore, not a cache-hit claim");
  h.plugin.forceUpdateAll();
  const fresh = item(); h.capture(fresh);
  assert.equal(await run(h, fresh), true);
  assert.equal(h.requests.length, 1, "reload must not cause a second paid provider request");
  const hit = h.plugin.getCachedReceivedTranslation(fresh, CHANNEL, h.plugin.extractOriginalContentData(fresh));
  assert.ok(hit); assert.equal(hit.translatedContent, TEXT);
  assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).cacheRead, "translation-hit");
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(fresh.id).translation.translatedContent, TEXT);
  assert.equal(h.plugin.ensureTranslationPipeline().getWholeMarkerSingleCanarySnapshot().enabled, false);
 } finally {await h.close();}
});

test("public forceUpdateAll persists a pending clear instead of reviving guarded paid cache", async () => {
 const h = harness();
 try {
  const message = h.seed(); assert.equal(h.plugin.ensureTranslationCacheStore().flushPendingSave(), true);
  assert.ok(h.plugin.getCachedReceivedTranslation(message, CHANNEL));
  assert.equal(h.plugin.ensureTranslationCacheStore().clearAll(), 1); h.plugin.forceUpdateAll();
  assert.equal(h.plugin.getCachedReceivedTranslation(message, CHANNEL), null);
  assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false); assert.deepEqual(h.disk.translationCache, {}); assert.equal(h.requests.length, 0);
 } finally {await h.close();}
});

test("public forceUpdateAll keeps a guarded paid cache through save failure and later retries", async () => {
 const h = harness();
 try {
  const message = h.seed(), readsBefore = h.cacheLoads.length; h.failCacheSave(true);
  assert.doesNotThrow(() => h.plugin.forceUpdateAll());
  assert.equal(h.cacheLoads.length, readsBefore, "failed dirty flush does not read the stale disk snapshot");
  const hit = h.plugin.getCachedReceivedTranslation(message, CHANNEL); assert.ok(hit); assert.equal(hit.translatedContent, TEXT);
  h.failCacheSave(false); h.plugin.forceUpdateAll();
  assert.equal(h.disk.translationCache[message.id].translation.translatedContent, TEXT);
  assert.ok(h.plugin.getCachedReceivedTranslation(message, CHANNEL)); assert.equal(h.requests.length, 0);
 } finally {await h.close();}
});