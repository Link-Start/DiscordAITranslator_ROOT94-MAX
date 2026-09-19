const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const CHANNEL = "w4-single-fixture", ENGINE = "custom-w4fixture";
const message = (id = "one", content = "Please translate this short sentence.", extra = {}) => Object.assign({id, channel_id: CHANNEL, content, embeds: [], attachments: [], author: {id: "other-user"}}, extra);
const response = content => ({status: 200, headers: {get: () => "application/json"}, text: async () => JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}]})});
function answer(wire) {
 if (wire.startsWith("{")) return JSON.stringify({segments: JSON.parse(wire).segments.map(row => ({id: row.id, translation: "请翻译这个简短句子。" + (row.text.match(/⟦[^⟧]+⟧/g) || []).join("").replace(/⟦F\d+⟧/g, "$&格式文字")}))});
 return [...wire.matchAll(/⟪(\d+)⟫([^⟪\n]*)/g)].map(row => `⟪${row[1]}⟫请翻译这个简短句子。${(row[2].match(/⟦[^⟧]+⟧/g) || []).join("")}`).join("\n");
}
function fixture({respond = answer, pluginPath, bdfdb = {}, nativeFetch = true} = {}) {
 const captures = [], applied = [], commits = [], cacheWrites = [], skipWrites = [], metas = [];
 const fetch = async (_url, options) => {const outer = JSON.parse(options.body), wire = outer.messages.at(-1).content; captures.push({outer, wire, body: String(options.body)}); const output = await respond(wire, captures.length, options); return output && typeof output.text === "function" ? output : response(output);};
 const request = (url, options, callback) => {let cancelled = false; fetch(url, options).then(async value => {if (!cancelled) callback(null, {statusCode: value.status, headers: {}}, await value.text());}, error => {if (!cancelled) callback(error);}); return {abort() {cancelled = true;}};};
 const plugin = createPluginInstance({pluginPath, callSetLanguages: false, bdfdb: Object.assign({LibraryRequires: {request}}, bdfdb), settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "W4 fixture"}]}, performance: {liveStreaming: false}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wrapperPairs: [], protectedTerms: []}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
 if (nativeFetch) global.BdApi.Net = {fetch}; try {plugin.onLoad();} catch {} plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "W4 fixture"}]; try {plugin.setLanguages();} catch {}
 plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture", endpoint: "https://w4.fixture/v1/chat/completions", model: "gemini-fixture", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
 plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place][type]; plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true; plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null;
 plugin.persistTranslationCacheEntry = (...args) => cacheWrites.push(args); plugin.persistReceivedSkipDecision = (...args) => skipWrites.push(args); plugin.applyStoredTranslationToMessage = (_item, stored) => applied.push(stored); plugin.scheduleReceivedDisplayFlush = () => {}; plugin.commitReceivedDisplayResult = result => {commits.push(result); return Promise.resolve({committedIds: [result.messageId], deferredIds: []});};
 const translateText = plugin.translateText.bind(plugin); plugin.translateText = (text, place, callback, forced, options) => translateText(text, place, (...args) => {metas.push(args[3]); callback(...args);}, forced, options);
 return {plugin, captures, applied, commits, cacheWrites, skipWrites, metas, pipeline: plugin.ensureTranslationPipeline(), async close() {delete global.BdApi.Net; await plugin.onStop();}};
}
const run = (h, item = message(), options = {}) => h.plugin.translateMessage(item, {id: CHANNEL}, Object.assign({manual: true, silent: true, trackBusy: false}, options));
const grant = (h, ids = ["one"]) => h.pipeline.enableWholeMarkerSingleCanary({channelId: CHANNEL, messageIds: ids, maxMessages: ids.length, ttlMs: 60000});

test("W4 real received manual clean canary dispatches D once, restores display, never labels or writes v2 cache", async () => {
 const h = fixture();
 try {
  assert.equal(typeof h.pipeline.enableWholeMarkerSingleCanary, "function");
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().enabled, false);
  grant(h);
  assert.equal(await run(h), true);
  assert.equal(h.captures.length, 1);
  assert.match(h.captures[0].wire, /^⟪1⟫Please translate this short sentence\./);
  assert.equal(h.applied[0].translatedContent, "请翻译这个简短句子。");
  assert.equal(h.applied[0].semanticWorkloadKey, undefined);
  assert.equal(h.cacheWrites.length, 0);
  assert.equal(h.skipWrites.length, 0);
  assert.equal(h.metas[0].wholeMarkerCanary, true);
  assert.equal(h.metas[0].cacheWrite, false);
  assert.equal(h.metas[0].validatorVersion, "w2c-whole-marker-validator-v2");
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);
 } finally {await h.close();}
});



test("W4 repairable D failure gets one merged repair only after parent settles", async () => {
 const h = fixture({respond: (wire, call) => call === 1 ? "⟪1⟫English answer" : answer(wire)});
 try {
  grant(h); assert.equal(await run(h), true); assert.equal(h.captures.length, 2);
  assert.equal(h.captures.every(row => !row.wire.startsWith("{")), true);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().repairs, 1);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 0);
  assert.equal(h.cacheWrites.length, 0);
 } finally {await h.close();}
});

test("W4 malformed D gets exactly one original typed first-answer validation and no legacy fallback", async () => {
 for (const typedValid of [true, false]) {
  const h = fixture({respond: (wire, call) => call === 1 ? "not a marked response" : typedValid ? answer(wire) : "not typed json"});
  let validations = 0; const validate = h.plugin.validateAtomicSemanticResponse.bind(h.plugin);
  h.plugin.validateAtomicSemanticResponse = (request, raw, options) => {validations++; assert.equal(request.attempt, 1); return validate(request, raw, options);};
  try {
   grant(h); assert.equal(await run(h), typedValid); assert.equal(h.captures.length, 2);
   assert.match(h.captures[0].wire, /^⟪1⟫/); assert.equal(JSON.parse(h.captures[1].wire).schemaVersion, "segment-json-v2");
   assert.equal(validations, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().repairs, 0);
   assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 1); assert.equal(h.cacheWrites.length, 0);
  } finally {await h.close();}
 }
});

test("W4 D compile collision preflight sends zero D and validates typed once without its retry chain", async () => {
 const h = fixture({respond: () => "not typed json"}); let validations = 0;
 const validate = h.plugin.validateAtomicSemanticResponse.bind(h.plugin); h.plugin.validateAtomicSemanticResponse = (...args) => {validations++; return validate(...args);};
 try {grant(h); assert.equal(await run(h, message("one", "Please translate ⟪1⟫ this short sentence.")), false); assert.equal(h.captures.length, 1); assert.equal(h.captures[0].wire.startsWith("{"), true); assert.equal(validations, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().dDispatches, 0); assert.equal(h.cacheWrites.length, 0);} finally {await h.close();}
});

test("W4 settings-close and stop revoke memory grant and suppress late valid display or repair", async () => {
 for (const operation of ["onSettingsClosed", "onStop"]) {
  let release; const h = fixture({respond: () => new Promise(resolve => {release = resolve;})});
  try {grant(h); const pending = run(h); await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, "function"); await h.plugin[operation](); release("⟪1⟫请翻译这个简短句子。"); assert.equal(await pending, false); assert.equal(h.applied.length, 0); assert.equal(h.cacheWrites.length, 0); assert.equal(h.captures.length, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().enabled, false); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);} finally {await h.close();}
 }
});

test("W4 settled provider callbacks cannot dispatch a second branch while display commit is pending", async () => {
 const h = fixture(); let providerDone, resolveCommit, applications = 0;
 h.plugin.openAiCompatibleTranslate = (_data, done) => {applications++; providerDone = done;};
 h.plugin.commitReceivedDisplayResult = () => new Promise(resolve => {resolveCommit = resolve;});
 try {grant(h); const pending = run(h, message(), {manual: false, auto: true, liveSingleSource: "direct-single"}); providerDone("⟪1⟫请翻译这个简短句子。"); assert.equal(typeof resolveCommit, "function"); providerDone("⟪1⟫English answer"); assert.equal(applications, 1); resolveCommit({deferredIds: []}); assert.equal(await pending, true); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);} finally {if(resolveCommit) resolveCommit({deferredIds: []}); await h.close();}
});

test("W4 whole-marker anonymous diagnostics survives producer store and existing copy sanitizer", () => {
 const {createWireObservation} = require("../../src/diagnostics/wire-observation-producer");
 const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
 const {createAiLatencyDiagnosticsPayload} = require("../../src/ui/settings-panel");
 const wireObservation = createWireObservation({wireFamily: "whole-marker", wireVersion: "whole-marker-v2", source: "private-source", wire: "⟪1⟫source", translateSegments: ["source"], itemCount: 1});
 const store = createProviderLatencyStore(), token = store.beginLatencyRequest({kind: "manual", messageCount: 1});
 store.recordLatencyEvent({token, role: "primary", engineKey: "fixture", status: "ok", transportMs: 1, wireObservation});
 const snapshot = store.getLatencySnapshot(), copied = createAiLatencyDiagnosticsPayload(snapshot);
 assert.equal(wireObservation.wireFamily, "whole-marker");
 assert.equal(snapshot.latestTranslation.wireFamily, "whole-marker");
 assert.equal(copied.latestTranslation.wireFamily, "whole-marker");
 assert.equal(copied.latestTranslation.wireVersion, "whole-marker-v2");
 assert.doesNotMatch(JSON.stringify(copied), /private-source|⟪1⟫source/);
});

test("W4 manual canary uses existing abortable owner without changing payload and drains on disable", async () => {
 let release, physicalSignal;
 const h = fixture({respond: (_wire, _call, options) => {physicalSignal = options.signal; return new Promise(resolve => {release = resolve;});}});
 try {
  grant(h); const pending = run(h); await new Promise(resolve => setImmediate(resolve));
  assert.ok(physicalSignal instanceof AbortSignal); assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 1);
  assert.equal(Object.hasOwn(h.captures[0].outer, "stream"), false);
  h.pipeline.disableWholeMarkerSingleCanary(); assert.equal(await pending, false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(physicalSignal.aborted, true); assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
  release("⟪1⟫请翻译这个简短句子。"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.applied.length, 0); assert.equal(h.captures.length, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);
 } finally {if(release) release(""); await h.close();}
});

test("W4 unsupported native protocol keeps existing route without consuming the canary grant", async () => {
 const h = fixture(); const sent = [];
 h.plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture", endpoint: "https://native.fixture", model: "gemini-fixture", interfaceFormat: "gemini_native"}});
 h.plugin.openAiCompatibleTranslate = (data, done) => {sent.push(data); done(answer(data.text));};
 try {grant(h); await run(h); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0); assert.equal(sent.length, 1); assert.equal(sent[0].semanticRequest.adapter, "typed-json");} finally {await h.close();}
});


test("W4 watchdog settles the logical message and aborts its still-owned physical request before stop", async () => {
 let watchdog, release, signal;
 const h = fixture({bdfdb: {TimeUtils: {interval: callback => {watchdog = callback; return null;}}}, respond: (_wire, _call, options) => {signal = options.signal; return new Promise(resolve => {release = resolve;});}});
 try {grant(h); const pending = run(h); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 1); watchdog(null, 64); assert.equal(await pending, false); await new Promise(resolve => setImmediate(resolve)); assert.equal(signal.aborted, true); assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0); await h.plugin.onStop(); release("⟪1⟫请翻译这个简短句子。"); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.applied.length, 0); assert.equal(h.captures.length, 1);} finally {if(release)release(""); await h.close();}
});

test("W4 protocol auto uses resolved capability: openai admitted, native excluded", async () => {
 for (const [endpoint, admitted] of [["https://relay.fixture/v1/chat/completions", 1], ["https://generativelanguage.googleapis.com/v1beta/models", 0]]) {
  const h = fixture(); h.plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture", endpoint, model: "gemini-fixture", interfaceFormat: "auto"}});
  h.plugin.openAiCompatibleTranslate = (data, done) => done(answer(data.text));
  try {grant(h); await run(h); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, admitted);} finally {await h.close();}
 }
});

test("W4 canary cleanup failure remains isolated inside stop and later cleanup still runs", async () => {
 let failClear = false, invalidated = 0;
 const h = fixture({bdfdb: {TimeUtils: {timeout: () => ({fixtureTimer: true}), clear: () => {if (failClear) throw new Error("fixture clear failure");}}}});
 try {
  // The stop composition owns module-scoped UI cleanup functions; inject their
  // existing ports into the actual onStop body to observe all three independently.
  const runtime = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../../src/legacy/runtime.js"), "utf8");
  const body = runtime.match(/\n\t\t\tonStop \(\) \{([\s\S]*?)\n\t\t\t\}/)[1], cleanup = [];
  const invokeStop = new Function("runIsolatedCleanupSteps", "cancelW2SettingsBenchmark", "flushDeferredSettingsWrites", "BDFDB", body);
  const noop = () => {}, ports = new Proxy({translationPipelineInstance: {disableWholeMarkerSingleCanary() {throw new Error("fixture clear failure");}}, ensureProviderClient: () => ({cancelSyntheticBenchmark: () => cleanup.push("synthetic"), abortProviderAttempts: noop})}, {get: (target, key) => key in target ? target[key] : noop});
  invokeStop.call(ports, require("../../src/lifecycle/stop-cleanup").runIsolatedCleanupSteps, () => cleanup.push("w2"), () => cleanup.push("settings"), {MessageUtils: {rerenderAll: noop}});
  assert.deepEqual(cleanup, ["w2", "synthetic", "settings"], "canary failure must not skip any original grouped cleanup");
  grant(h); h.plugin.invalidateLiveTranslationRequests = () => {invalidated++;}; failClear = true; assert.doesNotThrow(() => h.plugin.onStop()); assert.equal(invalidated, 1);
 } finally {failClear = false; await h.close();}
});

test("W4 selected canary with unavailable typed plan terminates without entering unbounded legacy dispatch", async () => {
 const h = fixture({respond: () => "not a valid translation"}), source = `Header\n${"Hello你好".repeat(4000)}`;
 try {assert.equal(h.plugin.createAtomicSemanticRevisionContract(source, {place: "received", channelId: CHANNEL, engineKey: ENGINE, targetLanguageId: "zh-CN"}).enabled, false); grant(h); assert.equal(await run(h, message("one", source)), false); assert.equal(h.captures.length, 0); assert.equal(h.cacheWrites.length, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);} finally {await h.close();}
});

test("W4 second application resets the existing watchdog instead of inheriting the first 29-second wait", async () => {
 const ticks = [], cleared = [], replies = [];
 const h = fixture({bdfdb: {TimeUtils: {interval: callback => {ticks.push(callback); return callback;}, clear: handle => {if (typeof handle === "function") cleared.push(handle); else if (handle) clearTimeout(handle);}}}});
 h.plugin.openAiCompatibleTranslate = (_data, done) => replies.push(done);
 try {grant(h); const pending = run(h); assert.equal(ticks.length, 1); ticks[0](null, 58); replies[0]("⟪1⟫English answer"); assert.equal(ticks.length, 2); assert.ok(cleared.includes(ticks[0])); ticks[1](null, 58); replies[1]("⟪1⟫请翻译这个简短句子。"); assert.equal(await pending, true); assert.equal(replies.length, 2);} finally {await h.close();}
});

test("W4 terminal diagnostics distinguish strict D from P3 typed fallback and record the first D failure", async () => {
 for (const fallback of [false, true]) {
  const h = fixture({respond: (wire, call) => fallback && call === 1 ? "not a marked response" : answer(wire)}), stages = [];
  const record = h.plugin.recordTranslationTerminalStage.bind(h.plugin); h.plugin.recordTranslationTerminalStage = (...args) => {stages.push(args); return record(...args);};
  try {grant(h); assert.equal(await run(h), true); const route = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1); assert.equal(route.validatorFamily, fallback ? "segment-validator-v3" : "w2c-whole-marker-validator-v2"); assert.equal(route.semanticRevision, fallback ? "s8b-p2-v1" : "whole-marker-v2"); assert.equal(h.metas[0].validatorVersion, fallback ? "segment-validator-v2" : "w2c-whole-marker-validator-v2"); if(fallback) assert.ok(stages.some(row => row[2] === "marker-schema" && row[3].validatorFamily === "w2c-whole-marker-validator-v2")); assert.equal(h.cacheWrites.length, 0);} finally {await h.close();}
 }
});


test("W4 off and W3 shadow preserve ordinary typed payload bytes without canary activation", async () => {
 const bodies = [];
 for (const shadow of ["off", "shadow"]) {const h = fixture(); try {h.plugin.settings.performance.compactWireShadow = shadow; assert.equal(await run(h), true); bodies.push(JSON.stringify(h.captures[0].outer)); assert.equal(h.captures.length, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0); assert.equal(h.cacheWrites.length, 1);} finally {await h.close();}}
 assert.equal(bodies[0], bodies[1]);
});

test("W4 paid typed cache is used before acquiring a canary lease", async () => {
 const h = fixture();
 try {grant(h); h.plugin.getCachedReceivedTranslation = () => ({content: "已付费译文", translatedContent: "已付费译文", originalContent: message().content, semanticRevision: "s8b-p2-v1"}); assert.equal(await run(h), true); assert.equal(h.captures.length, 0); assert.equal(h.applied[0].content, "已付费译文"); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().remainingMessages, 1);} finally {await h.close();}
});

test("W4 P1 URL is hidden on D wire and restored exactly once without D cache writes", async () => {
 const h = fixture(), url = "https://example.invalid/w4-guide";
 try {grant(h); assert.equal(await run(h, message("one", `Please open ${url} before Friday.`)), true); assert.equal(h.captures.length, 1); assert.equal(h.captures[0].wire.includes(url), false); assert.equal(h.applied[0].translatedContent.split(url).length - 1, 1); assert.equal(h.cacheWrites.length, 0);} finally {await h.close();}
});

test("W4 merged repair preserves valid ranges and never escalates to typed after a failed repair", async () => {
 for (const succeed of [true, false]) {
  const h = fixture({respond: (wire, call) => call === 1 ? "⟪1⟫你好" : succeed ? "⟪2⟫世界" : "bad repair"});
  try {grant(h); assert.equal(await run(h, message("one", "Hello你好World")), succeed); assert.equal(h.captures.length, 2); assert.equal(h.captures[1].wire.includes("⟪1⟫"), false); assert.match(h.captures[1].wire, /⟪2⟫/); if(succeed) assert.equal(h.applied[0].translatedContent, "你好你好世界"); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 0); assert.equal(h.cacheWrites.length, 0);} finally {await h.close();}
 }
});

test("W4 typed fallback retains P3 first-answer name keep but does not give a long echo a second typed attempt", async () => {
 for (const [source, kept] of [["Higgsfield Community", true], ["please review the updated schedule before the meeting and confirm your attendance by friday afternoon", false]]) {
  const h = fixture({respond: (wire, call) => call === 1 ? "malformed D" : JSON.stringify({segments: JSON.parse(wire).segments.map(row => ({id: row.id, translation: row.text}))})});
  try {grant(h); assert.equal(await run(h, message("one", source)), kept); assert.equal(h.captures.length, 2); assert.equal(h.applied.length, 0, "unchanged names settle as skipped rather than displayed translations"); assert.equal(h.cacheWrites.length, 0);} finally {await h.close();}
 }
});

test("W4 sent reply historical item-repair embed forward and burst-origin paths never acquire D", async () => {
 const cases = [
  {item: message("one", undefined, {embeds: [{title: "Title", description: "Description"}]})},
  {item: message("one", undefined, {type: 19, message_reference: {message_id: "reply"}})},
  {item: message("one", undefined, {message_snapshots: [{message: {content: "Forwarded"}}]})},
  {options: {historicalLoad: true}}, {options: {historicalTraceContext: {}}},
  {options: {manual: false, auto: true, liveSingleSource: "burst-requeue"}},
  {options: {manual: false, auto: true, liveSingleSource: "historical"}},
  {direct: "received", options: {terminalLane: "manual", messageCount: 1}},
  {direct: "received", options: {terminalLane: "item-repair", historicalTraceContext: {}}},
  {direct: "sent"}
 ];
 for(const scenario of cases) {
  const h = fixture(); try {grant(h); if(scenario.direct) await new Promise(resolve => h.plugin.translateText(message().content, scenario.direct, resolve, null, Object.assign({channelId: CHANNEL, trackBusy: false, showToast: false, showFailureToast: false}, scenario.options))); else await run(h, scenario.item || message(), scenario.options); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().dDispatches, 0); assert.equal(h.captures.every(row => !row.wire.includes("⟪1⟫")), true);} finally {await h.close();}
 }
});

test("W4 source edit, deletion and live cancellation discard late D and never repair or write cache", async () => {
 for (const reason of ["edit", "delete", "live-cancel"]) {
  let release; const h = fixture({respond: () => new Promise(resolve => {release = resolve;})}), item = message();
  try {grant(h); const pending = run(h, item, reason === "live-cancel" ? {manual: false, auto: true, liveSingleSource: "direct-single"} : {}); await new Promise(resolve => setImmediate(resolve)); if(reason === "edit") item.content = "Updated source after dispatch."; else if(reason === "delete") h.plugin.ensureSentTranslationStore().cancelManualRequest(`${CHANNEL}:one`); else h.plugin.invalidateLiveTranslationRequests(CHANNEL); release("⟪1⟫English answer"); assert.equal(await pending, false); assert.equal(h.captures.length, 1); assert.equal(h.applied.length, 0); assert.equal(h.commits.length, 0); assert.equal(h.cacheWrites.length, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0); assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);} finally {if(release)release(""); await h.close();}
 }
});

test("W4 missing abortable host transport stays ordinary typed and consumes no canary lease", async () => {
 const h = fixture({nativeFetch: false});
 try {grant(h); assert.equal(await run(h), true); assert.equal(h.captures.length, 1); assert.equal(h.captures[0].wire.startsWith("{"), true); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0);} finally {await h.close();}
});

test("W4 two applications share exactly one stream compatibility retry and at most three physical requests", async () => {
 const h = fixture({respond: (wire, call) => call === 1 ? {status: 400, headers: {get: () => "application/json"}, text: async () => JSON.stringify({error: {message: "stream unsupported"}})} : call === 2 ? "malformed D" : answer(wire)}), contexts = [];
 h.plugin.settings.performance.liveStreaming = true;
 const send = h.plugin.openAiCompatibleTranslate.bind(h.plugin); h.plugin.openAiCompatibleTranslate = (data, done) => {contexts.push(data.requestContext); assert.equal(data.timingContext.requestContext, data.requestContext); return send(data, done);};
 try {grant(h); assert.equal(await run(h, message(), {manual: false, auto: true, liveSingleSource: "direct-single"}), true); assert.equal(h.captures.length, 3); assert.equal(contexts.length, 2); assert.equal(contexts[0].compatibilityBudget, contexts[1].compatibilityBudget); assert.equal(contexts[0].compatibilityBudget.getSnapshot().used, 1); assert.equal(contexts[0].compatibilityBudget.consume("stream_to_nonstream"), false); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().applicationDispatches, 2); assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0); assert.deepEqual(h.captures.map(row => row.outer.stream === true), [true, false, false]); assert.equal(h.cacheWrites.length, 0);} finally {await h.close();}
});

test("W4 grant bounds channel IDs message IDs uses and TTL with no persistence", async () => {
 const {createWholeMarkerSingleCanary} = require("../../src/orchestrator/whole-marker-single-canary");
 let now = 0, timer, cleared = 0;
 const owner = createWholeMarkerSingleCanary({now: () => now, setTimeout: callback => (timer = callback, 1), clearTimeout: () => {cleared++;}});
 assert.equal(owner.enable({channelId: "c", messageIds: ["m"], maxMessages: 21, ttlMs: 100}), false);
 assert.equal(owner.enable({channelId: "c", messageIds: ["m"], maxMessages: 1, ttlMs: 300001}), false);
 assert.equal(owner.enable({channelId: "c", messageIds: ["m"], maxMessages: 1, ttlMs: 100}), true);
 assert.equal(owner.claim({channelId: "other", messageId: "m"}), null); assert.equal(owner.claim({channelId: "c", messageId: "other"}), null);
 const lease = owner.claim({channelId: "c", messageId: "m"}); assert.ok(lease); assert.equal(owner.claim({channelId: "c", messageId: "m"}), null);
 assert.equal(lease.dispatch("primary"), true); assert.equal(lease.dispatch("repair"), true); assert.equal(lease.dispatch("typed"), false);
 now = 100; timer(); assert.equal(lease.signal.aborted, true); assert.equal(lease.isCurrent(), false); lease.finish(); assert.equal(owner.snapshot().activeRequests, 0); assert.equal(owner.snapshot().enabled, false); assert.equal(cleared, 1); assert.doesNotMatch(JSON.stringify(owner.snapshot()), /"c"|"m"/);
});

test("W4 actual queue dispatches ordinary single D but sticky failed-burst reorder remains typed", async () => {
 const {createPluginLiveTranslationQueue} = require("../../src/orchestrator/live-translation-queue-wiring");
 for (const burst of [false, true]) {
  const h = fixture(); let burstCalls = 0;
  h.plugin.getHistoricalAiBatchEngineKey = () => burst ? ENGINE : null;
  h.plugin.requestAiBatchTranslationDetailed = async () => {burstCalls++; return {translations: null};};
  const queue = createPluginLiveTranslationQueue({plugin: h.plugin, BDFDB: {TimeUtils: {timeout: setTimeout, clear: clearTimeout}}, loadedTranslationStatusStore: {resetSeen() {}}, getRuntimeActive: () => true, languageTypes: {INPUT: "input", OUTPUT: "output"}, messageTypes: {RECEIVED: "received"}});
  h.plugin.ensureLiveTranslationQueue = () => queue;
  try {grant(h, burst ? ["one", "two"] : ["one"]); queue.setBusyTranslating(true); assert.equal(queue.queueMessage(message(), {id: CHANNEL}), true); if(burst) assert.equal(queue.queueMessage(message("two"), {id: CHANNEL}), true); queue.setBusyTranslating(false); queue.processQueue(); for(let count=0;count<100 && (queue.getQueueLength() || queue.getLiveSlotActiveCount());count++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(queue.getQueueLength(), 0); assert.equal(queue.getLiveSlotActiveCount(), 0); assert.equal(burstCalls, burst ? 1 : 0); assert.equal(h.captures.length, burst ? 2 : 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().dDispatches, burst ? 0 : 1); assert.equal(h.captures.every(row => row.wire.startsWith("{")), burst);} finally {queue.clearQueue(); await h.close();}
 }
});

// Capture only anonymous observer fields; raw fixture bodies remain inside the test.
function observeRequestIdentities(h) {
 const events = [], update = h.plugin.updateTranslationTerminalRoute.bind(h.plugin);
 h.plugin.updateTranslationTerminalRoute = (id, fields) => {
  if (fields && Object.hasOwn(fields, "requestBodyBytes")) events.push({bodyBytes: fields.requestBodyBytes, bodyIdentity: fields.requestBodyIdentity});
  return update(id, fields);
 };
 return events;
}
function sentBodyIdentity(body) {
 return "bi1:" + require("node:crypto").createHash("md5").update("discord-ai-translator:h1:body:v1\u0000" + JSON.stringify(body)).digest("hex").slice(0, 20);
}
test("W4 diagnostics real manual D terminal records actual sent bytes identity and custom engine", async () => {
 const h = fixture(), events = observeRequestIdentities(h);
 try {
  grant(h); assert.equal(await run(h), true); assert.equal(h.captures.length, 1);
  const body = h.captures[0].body, route = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
  assert.deepEqual({engineFamily: route.engineFamily, requestBodyBytes: route.requestBodyBytes, requestBodyIdentity: route.requestBodyIdentity}, {engineFamily: "custom", requestBodyBytes: Buffer.byteLength(body), requestBodyIdentity: sentBodyIdentity(body)});
  assert.deepEqual(events, [{bodyBytes: Buffer.byteLength(body), bodyIdentity: sentBodyIdentity(body)}]);
  assert.equal(route.providerDispatchCount, 1);
  assert.doesNotMatch(JSON.stringify(route), /Please translate|w4\.fixture|gemini-fixture|Bearer|⟪1⟫/);
 } finally {await h.close();}
});

test("W4 diagnostics repair fallback ordinary live and stream compatibility each observe exactly the sent physical bodies", async t => {
 for (const scenario of [
  {name: "merged D repair", respond: (wire, call) => call === 1 ? "⟪1⟫English answer" : answer(wire), count: 2, apps: 2},
  {name: "typed fallback", respond: (wire, call) => call === 1 ? "malformed D" : answer(wire), count: 2, apps: 2},
  {name: "ordinary nonstream live typed", enabled: false, live: true, count: 1, apps: 1},
  {name: "stream compatibility then typed fallback", live: true, streaming: true, respond: (wire, call) => call === 1 ? {status: 400, headers: {get: () => "application/json"}, text: async () => JSON.stringify({error: {message: "stream unsupported"}})} : call === 2 ? "malformed D" : answer(wire), count: 3, apps: 2}
 ]) await t.test(scenario.name, async () => {
  const h=fixture({respond: scenario.respond}), events=observeRequestIdentities(h);
  try {
   h.plugin.settings.performance.liveStreaming = !!scenario.streaming;
   if (scenario.enabled !== false) grant(h);
   assert.equal(await run(h, message(), scenario.live ? {manual: false, auto: true, liveSingleSource: "direct-single"} : {}), true);
   assert.equal(h.captures.length, scenario.count);
   assert.deepEqual(events, h.captures.map(({body}) => ({bodyBytes: Buffer.byteLength(body), bodyIdentity: sentBodyIdentity(body)})), "one anonymous event per actual sent body, after stream mutation");
   const route=h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1), last=h.captures.at(-1).body;
   assert.equal(route.engineFamily, "custom"); assert.equal(route.providerDispatchCount, scenario.apps);
   assert.equal(route.requestBodyBytes, Buffer.byteLength(last)); assert.equal(route.requestBodyIdentity, sentBodyIdentity(last));
   if (scenario.streaming) {assert.deepEqual(h.captures.map(row => row.outer.stream === true), [true,false,false]); assert.notEqual(events[0].bodyIdentity, events[1].bodyIdentity);}
   assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
  } finally {await h.close();}
 });
});

test("W4 diagnostics each physical attempt reports one anonymous settle before application callback", async t => {
 for (const streaming of [false, true]) await t.test(streaming ? "compatibility stream text fallback" : "manual canary", async () => {
  const h=fixture({respond: (wire, call) => streaming && call === 1 ? {status: 400, headers: {get: () => "application/json"}, text: async () => JSON.stringify({error: {message: "stream unsupported"}})} : streaming && call === 2 ? "malformed D" : answer(wire)}), settles=[], send=h.plugin.openAiCompatibleTranslate.bind(h.plugin);
  h.plugin.openAiCompatibleTranslate=(data, done) => {
   const observe=data.timingContext.diagnosticStageObserver;
   data.timingContext.diagnosticStageObserver=event => {settles.push(event); return observe(event);};
   return send(data, done);
  };
  try {
   h.plugin.settings.performance.liveStreaming=streaming; grant(h);
   assert.equal(await run(h, message(), streaming ? {manual:false,auto:true,liveSingleSource:"direct-single"} : {}),true);
   assert.equal(settles.length,h.captures.length);
   assert.deepEqual(settles.map(event=>event.httpStatus),streaming?[400,200,200]:[200]);
   assert.deepEqual(settles.map(event=>event.status),streaming?["http_400","ok","ok"]:["ok"]);
   assert.equal(settles.every(event => event.headers === null && Number.isFinite(event.durationMs)), true);
   assert.doesNotMatch(JSON.stringify(settles), /Please translate|w4\.fixture|gemini-fixture|Bearer|⟪1⟫/);
   assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).providerDispatchCount,streaming?2:1);
  } finally {await h.close();}
 });
});

// Integration through the actual display/cache owners. Only HTTP, Discord stores,
// persistence and host timers are fixtures; a captured row is not a DOM paint.
function realDisplayOwnerFixture(options = {}) {
 const disk = options.disk || {}, messages = new Map(), timers = new Map(), cacheLoads = [], cacheSaves = []; let timerId = 0;
 const h = fixture({...options, bdfdb: {
  LibraryStores: {MessageStore: {getMessage: (channelId, messageId) => messages.get(channelId + ":" + messageId) || null}},
  DataUtils: {load: (_plugin, key) => {cacheLoads.push(key); return disk[key] || {};}, save: (value, _plugin, key) => {cacheSaves.push(key); disk[key] = JSON.parse(JSON.stringify(value));}},
  TimeUtils: {interval: fn => {timers.set(++timerId, fn); return timerId;}, timeout: fn => {timers.set(++timerId, fn); return timerId;}, clear: id => timers.delete(id)}
 }});
 // Remove only the older harness's instance substitutions, exposing the genuine
 // plugin prototype methods. Keep the existing entry eligibility fixture.
 for (const name of ["commitReceivedDisplayResult", "applyStoredTranslationToMessage", "scheduleReceivedDisplayFlush", "persistTranslationCacheEntry", "persistReceivedSkipDecision", "getCachedReceivedTranslation", "getCachedReceivedSkipDecision"]) {
  assert.equal(Object.hasOwn(h.plugin, name), true, name + " is a fixture override");
  delete h.plugin[name]; assert.equal(typeof h.plugin[name], "function", name + " resolves to the production implementation");
 }
 h.capture = item => {
  messages.set(item.channel_id + ":" + item.id, item);
  const source = h.plugin.extractOriginalContentData(item), signature = h.plugin.createReceivedTranslationSignature(item, item.channel_id, source);
  h.plugin.ensureReceivedDisplayRuntime().captureSource({messageId: item.id, channelId: item.channel_id, generation: h.plugin.getReceivedDisplayCommitGeneration(item.channel_id), sourceSignature: signature, source});
  return signature;
 };
 h.messages = messages; h.disk = disk; h.cacheLoads = cacheLoads; h.cacheSaves = cacheSaves;
 const close = h.close; h.close = async () => {await close(); assert.equal(timers.size, 0, "all host timer handles retire");};
 return h;
}

for (const mode of ["manual", "auto"]) test("W4 real display owner: " + mode + " D commits once without persistent translation or skip cache", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {
  h.capture(item); grant(h);
  assert.equal(await run(h, item, mode === "auto" ? {manual: false, auto: true, liveSingleSource: "direct-single"} : {}), true);
  const view = h.plugin.getReceivedDisplayRuntimeView(item.id), route = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
  assert.equal(view.translation.translatedContent, "请翻译这个简短句子。");
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
  assert.equal(h.plugin.getCachedReceivedSkipDecision(item, CHANNEL, h.plugin.extractOriginalContentData(item)), null);
  assert.equal(h.captures.length, 1); assert.equal(route.outcome, "translated"); assert.equal(route.displayCommit, "applied"); assert.equal(route.cacheWrite, "none");
  assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().activeRouteCount, 0);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);
 } finally {await h.close();}
});

for (const mutation of ["edit", "delete", "revoke"]) test("W4 real display owner: late auto D after " + mutation + " never commits stale display or cache", async () => {
 let release; const h = realDisplayOwnerFixture({respond: () => new Promise(resolve => {release = resolve;})}), item = message();
 try {
  h.capture(item); grant(h);
  const pending = run(h, item, {manual: false, auto: true, liveSingleSource: "direct-single"});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, "function");
  if (mutation === "edit") {
   const edited = message("one", "Please send the revised notes tomorrow.");
   h.plugin.invalidateLiveTranslationMessage(item.id, CHANNEL, h.capture(edited));
  } else if (mutation === "delete") {
   h.messages.delete(CHANNEL + ":" + item.id);
   await h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: item.id});
  } else h.pipeline.disableWholeMarkerSingleCanary();
  release("⟪1⟫请翻译这个简短句子。");
  assert.equal(await pending, false);
  const view = h.plugin.getReceivedDisplayRuntimeView(item.id), ledger = h.plugin.getTranslationTerminalLedgerSnapshot();
  if (mutation === "delete") assert.equal(view, null); else assert.equal(view.translated, false);
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
  assert.equal(ledger.recent.filter(row => row.outcome === "translated").length, 0);
  assert.equal(ledger.activeRouteCount, 0); assert.equal(h.captures.length, 1);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
 } finally {if (release) release(""); await h.close();}
});

for (const branch of ["repair", "typed-fallback"]) test("W4 real display owner: auto " + branch + " preserves no-write canary policy", async () => {
 const h = realDisplayOwnerFixture({respond: (wire, attempt) => attempt === 1 ? branch === "repair" ? "⟪1⟫English answer" : "broken marked answer" : answer(wire)}), item = message();
 try {
  h.capture(item); grant(h);
  assert.equal(await run(h, item, {manual: false, auto: true, liveSingleSource: "direct-single"}), true);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, "请翻译这个简短句子。");
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
  const counter = h.pipeline.getWholeMarkerSingleCanarySnapshot();
  assert.equal(counter.applicationDispatches, 2); assert.equal(counter.repairs, branch === "repair" ? 1 : 0); assert.equal(counter.typedFallbacks, branch === "typed-fallback" ? 1 : 0);
  assert.equal(h.captures.length, 2); assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).cacheWrite, "none");
 } finally {await h.close();}
});

test("W4 real display owner: valid paid typed cache wins before a canary grant is consumed", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {
  h.capture(item);
  assert.equal(await run(h, item), true);
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].wire.startsWith("{"), true);
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), true);
  assert.equal(await run(h, item), false, "second manual click restores the original by product contract");
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), true, "restoring display retains paid cache");
  grant(h);
  assert.equal(await run(h, item), true);
  assert.equal(h.captures.length, 1, "cache reuse does not dispatch another paid request");
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0);
  assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).cacheRead, "translation-hit");
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, "请翻译这个简短句子。");
 } finally {await h.close();}
});

const grantCached = (h, ids = ["one"]) => h.pipeline.enableWholeMarkerSingleCanary({channelId: CHANNEL, messageIds: ids, maxMessages: ids.length, ttlMs: 60000, cache: true});
test("W4 opt-in D cache: real manual restore then translate uses one request total", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item), true);
  assert.equal(await run(h, item), false, "restore is not a cache hit");
  grantCached(h); assert.equal(await run(h, item), true);
  assert.equal(h.captures.length, 1, "the second translation must reuse the D result");
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 1);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().applicationDispatches, 0);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, "请翻译这个简短句子。");
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
 } finally {await h.close();}
 assert.equal(h.disk.translationCacheWholeMarker.version, 1);
});
test("W4 opt-in D cache: provider configuration change before reply prevents stale display and write", async () => {
 let release; const h = realDisplayOwnerFixture({respond: () => new Promise(resolve => {release = resolve;})}), item = message();
 try {
  h.capture(item); grantCached(h); const pending = run(h, item); await new Promise(resolve => setImmediate(resolve));
  const keys = h.plugin.ensureSettingsStore().getAuthKeys(); h.plugin.ensureSettingsStore().replaceAuthKeys({...keys, [ENGINE]: {...keys[ENGINE], model: "changed-gemini-fixture"}});
  release("⟪1⟫请翻译这个简短句子。"); assert.equal(await pending, false);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translated, false);
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0);
 } finally {if (release) release(""); await h.close();}
});
const autoSingle = {manual: false, auto: true, liveSingleSource: "direct-single"};
test("W4 opt-in D cache: real automatic deferred commit writes and warm request dispatches zero", async () => {
 const h = realDisplayOwnerFixture(), item = message(), outcomes = []; const commit = h.plugin.commitReceivedDisplayResult.bind(h.plugin);
 h.plugin.commitReceivedDisplayResult = (...args) => commit(...args).then(outcome => {outcomes.push(outcome); return outcome;});
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), true);
  assert.deepEqual(outcomes[0].deferredIds, [item.id]); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 1);
  assert.equal(await run(h, item), false); grantCached(h); assert.equal(await run(h, item, autoSingle), true);
  assert.equal(h.captures.length, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().applicationDispatches, 0);
 } finally {await h.close();}
});

test("W4 opt-in D cache: valid paid typed cache wins without opening D or consuming grant", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {
  h.capture(item); assert.equal(await run(h, item), true); assert.equal(await run(h, item), false);
  grantCached(h); assert.equal(await run(h, item), true); assert.equal(h.captures.length, 1);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0);
  assert.equal(h.cacheLoads.includes("translationCacheWholeMarker"), false);
 } finally {await h.close();}
});

async function savedDPartition() {
 const h = realDisplayOwnerFixture(), item = message(); h.capture(item); grantCached(h);
 try {assert.equal(await run(h, item), true);} finally {await h.close();}
 return JSON.parse(JSON.stringify(h.disk));
}
test("W4 opt-in D cache: restart reuses D, but off shadow and original canary do not read it", async () => {
 const disk = await savedDPartition(), bodies = [];
 for (const mode of ["cached", "off", "shadow", "original-canary"]) {
  const h = realDisplayOwnerFixture({disk: JSON.parse(JSON.stringify(disk))}), item = message();
  try {
   h.capture(item); if (mode === "cached") grantCached(h); else if (mode === "original-canary") grant(h); else h.plugin.settings.performance.compactWireShadow = mode;
   assert.equal(await run(h, item), true); assert.equal(h.captures.length, mode === "cached" ? 0 : 1);
   assert.equal(h.cacheLoads.includes("translationCacheWholeMarker"), mode === "cached");
   if (["off", "shadow"].includes(mode)) bodies.push(h.captures[0].body);
  } finally {await h.close();}
 }
 assert.equal(bodies[0], bodies[1]);
});

for (const change of ["source", "model", "endpoint-query", "reasoning", "language", "protection", "policy", "version"]) test("W4 opt-in D cache: " + change + " invalidates a warm identity without clearing old data", async () => {
 const disk = await savedDPartition();
 if (change === "version") {const value = Object.values(disk.translationCacheWholeMarker.entries)[0].translation; const key = JSON.parse(value.cacheIdentity); key[11] = "future-wire-v99"; value.cacheIdentity = JSON.stringify(key);}
 const h = realDisplayOwnerFixture({disk}), item = message("one", change === "source" ? "Please translate this revised sentence." : message().content);
 try {
  h.capture(item);
  if (["model", "endpoint-query", "reasoning"].includes(change)) {
   const keys = h.plugin.ensureSettingsStore().getAuthKeys(), patch = change === "model" ? {model: "gemini-second-fixture"} : change === "endpoint-query" ? {endpoint: keys[ENGINE].endpoint + "?deployment=second"} : {reasoningMode: "follow"};
   h.plugin.ensureSettingsStore().replaceAuthKeys({...keys, [ENGINE]: {...keys[ENGINE], ...patch}});
  }
  if (change === "language") h.plugin.settings.choices.received.input = "auto";
  if (change === "protection") h.plugin.settings.exceptions.protectedTerms = ["sentence"];
  if (change === "policy") h.plugin.settings.filters.languageDetectionStrategy = "local_only";
  const before = JSON.stringify(disk.translationCacheWholeMarker); grantCached(h); await run(h, item);
  assert.ok(h.captures.length > 0, change + " must miss");
  assert.equal(JSON.stringify(disk.translationCacheWholeMarker), before, "a miss itself does not erase paid disk data");
 } finally {await h.close();}
});

for (const operation of ["reject", "edit-after-commit", "delete-after-commit", "revoke-after-commit"]) test("W4 opt-in D cache: automatic " + operation + " writes nothing", async () => {
 const h = realDisplayOwnerFixture(), item = message(), originalCommit = h.plugin.commitReceivedDisplayResult.bind(h.plugin);
 h.plugin.commitReceivedDisplayResult = result => {
  if (operation === "reject") return originalCommit({...result, generation: result.generation + 1}, {refresh: false});
  const pending = originalCommit(result, {refresh: false});
  if (operation === "edit-after-commit") h.capture(message("one", "Changed after the display commit."));
  else if (operation === "delete-after-commit") {h.messages.delete(CHANNEL + ":one"); h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: "one"});}
  else h.pipeline.disableWholeMarkerSingleCanary();
  return pending;
 };
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), false);
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0);
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
 } finally {await h.close();}
});

for (const branch of ["repair", "typed-fallback", "failed-repair"]) test("W4 opt-in D cache: " + branch + " only final valid D is persisted", async () => {
 const h = realDisplayOwnerFixture({respond: (wire, attempt) => attempt === 1 ? branch === "typed-fallback" ? "broken marked answer" : "⟪1⟫English answer" : branch === "failed-repair" ? "broken repair" : answer(wire)}), item = message();
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item), branch !== "failed-repair");
  assert.equal(h.captures.length, 2); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), branch === "repair" ? 1 : 0);
  assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
 } finally {await h.close();}
});

test("W4 opt-in D cache: deleting a cached message clears its entry and flushes removal", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {
  h.capture(item); grantCached(h); await run(h, item); h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().flushPendingSave();
  h.messages.delete(CHANNEL + ":one"); await h.plugin.handleMessageDeletionAction({type: "MESSAGE_DELETE", channelId: CHANNEL, id: "one"});
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0);
 } finally {await h.close();}
 assert.deepEqual(h.disk.translationCacheWholeMarker.entries, {});
});
test("W4 opt-in D cache: uncaptured manual source can commit without an automatic source signature", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {grantCached(h); assert.equal(await run(h, item), true); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 1);} finally {await h.close();}
});

test("W4 opt-in D cache: stop cancels pending manual result before flush", async () => {
 let release; const h = realDisplayOwnerFixture({respond: () => new Promise(resolve => {release = resolve;})}), item = message();
 try {h.capture(item); grantCached(h); const pending = run(h, item); await new Promise(resolve => setImmediate(resolve)); await h.plugin.onStop(); release("⟪1⟫请翻译这个简短句子。"); assert.equal(await pending, false); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);} finally {if (release) release(""); await h.close();}
});

test("W4 opt-in D cache: settings reload flushes a pending D entry before adopting disk", async () => {
 const h = realDisplayOwnerFixture(), item = message();
 try {h.capture(item); grantCached(h); await run(h, item); assert.equal(h.disk.translationCacheWholeMarker, undefined); h.plugin.forceUpdateAll(); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 1); assert.equal(Object.keys(h.disk.translationCacheWholeMarker.entries).length, 1);} finally {await h.close();}
});

test("W4 opt-in D cache: channel ownership changes miss without reading another channel result", async () => {
 const h = realDisplayOwnerFixture({disk: await savedDPartition()}), item = message("one", message().content, {channel_id: "other-channel"});
 try {h.capture(item); h.pipeline.enableWholeMarkerSingleCanary({channelId: item.channel_id, messageIds: [item.id], maxMessages: 1, ttlMs: 60000, cache: true}); assert.equal(await h.plugin.translateMessage(item, {id: item.channel_id}, {manual: true, silent: true, trackBusy: false}), true); assert.equal(h.captures.length, 1); assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).channelId, item.channel_id);} finally {await h.close();}
});

test("W4 opt-in D cache: raw source whitespace is part of identity while display stays trimmed", async () => {
 const h = realDisplayOwnerFixture({disk: await savedDPartition()}), item = message("one", "  " + message().content + "  ");
 try {h.capture(item); grantCached(h); assert.equal(await run(h, item), true); assert.equal(h.captures.length, 1); assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.originalContent, item.content.trim());} finally {await h.close();}
});

test("W4 opt-in D cache: duplicate provider callbacks cannot persist twice", async () => {
 const h = realDisplayOwnerFixture(), item = message(); let writes = 0;
 h.plugin.openAiCompatibleTranslate = (_data, done) => {done("⟪1⟫请翻译这个简短句子。"); done("⟪1⟫重复译文。");};
 const ensure = h.plugin.ensureTranslationCacheStore.bind(h.plugin);
 h.plugin.ensureTranslationCacheStore = () => {const owner = ensure(); return {...owner, getWholeMarkerStore() {const store = owner.getWholeMarkerStore(); return {...store, persistTranslation(...args) {writes++; return store.persistTranslation(...args);}};}};};
 try {h.capture(item); grantCached(h); assert.equal(await run(h, item), true); assert.equal(writes, 1); assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, "请翻译这个简短句子。");} finally {await h.close();}
});
for (const mode of ["manual", "auto"]) test("W4 D cache-hit terminal diagnostics: " + mode + " warm and restart retain D classification without provider dispatch", async () => {
 const item = message(), options = mode === "auto" ? autoSingle : {}, h = realDisplayOwnerFixture(); let disk;
 const assertHit = (instance, requests) => {
  const terminal = instance.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1), counter = instance.pipeline.getWholeMarkerSingleCanarySnapshot(), owner = instance.plugin.ensureTranslationCacheStore();
  assert.equal(terminal.cacheRead, "translation-hit");
  assert.equal(terminal.requestFamily, "whole-marker");
  assert.equal(terminal.validatorFamily, "w2c-whole-marker-validator-v2");
  assert.equal(terminal.semanticRevision, "whole-marker-v2");
  assert.equal(terminal.engineFamily, "custom");
  assert.equal(terminal.providerDispatchCount, 0); assert.deepEqual(terminal.providerRoles, {});
  assert.equal(terminal.requestBodyBytes, null); assert.equal(terminal.requestBodyIdentity, null); assert.equal(terminal.cacheWrite, "none");
  assert.equal(counter.admittedMessages, 1); assert.equal(counter.applicationDispatches, 0); assert.equal(counter.dDispatches, 0); assert.equal(counter.activeRequests, 0);
  assert.equal(instance.captures.length, requests); assert.equal(owner.getEntryCount(), 0); assert.equal(owner.getWholeMarkerStore().getEntryCount(), 1);
  assert.equal(instance.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, "请翻译这个简短句子。");
 };
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, options), true); h.plugin.ensureTranslationCacheStore().flushPendingSave();
  assert.equal(h.captures.length, 1); assert.deepEqual(h.cacheSaves.filter(key => key === "translationCacheWholeMarker"), ["translationCacheWholeMarker"]);
  assert.equal(await run(h, item), false, "restoring the original is not a cache hit"); grantCached(h); assert.equal(await run(h, item, options), true); assertHit(h, 1);
  h.plugin.ensureTranslationCacheStore().flushPendingSave(); assert.deepEqual(h.cacheSaves.filter(key => key === "translationCacheWholeMarker"), ["translationCacheWholeMarker"]);
 } finally {await h.close();}
 assert.deepEqual(h.cacheSaves.filter(key => key === "translationCacheWholeMarker"), ["translationCacheWholeMarker"]); disk = JSON.parse(JSON.stringify(h.disk));
 const restarted = realDisplayOwnerFixture({disk});
 try {restarted.capture(item); grantCached(restarted); assert.equal(await run(restarted, item, options), true); assertHit(restarted, 0); restarted.plugin.ensureTranslationCacheStore().flushPendingSave(); assert.deepEqual(restarted.cacheSaves.filter(key => key === "translationCacheWholeMarker"), []);} finally {await restarted.close();}
 assert.deepEqual(restarted.cacheSaves.filter(key => key === "translationCacheWholeMarker"), []);
});
test("W4 auth denial: primary 401 manual is terminal without typed reissue", async () => {
 const h = fixture({respond: () => ({status: 401, headers: {get: () => "application/json"}, text: async () => JSON.stringify({error: {message: "fixture authentication denied"}})})});
 try {
  grant(h); assert.equal(await run(h), false);
  assert.equal(h.captures.length, 1, "a deterministic auth refusal must not reissue the same credentials as typed");
  assert.equal(h.metas.at(-1).reason, "auth");
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 0);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
  assert.equal(h.cacheWrites.length, 0); assert.equal(h.skipWrites.length, 0);
 } finally {await h.close();}
});

for (const branch of ["primary", "repair"]) test("W4 auth currentness: stale " + branch + " auth callback keeps stale priority and settles once", () => {
 const {runWholeMarkerSingle} = require("../../src/orchestrator/whole-marker-single-canary");
 const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");
 const {buildWholeMarkerRequest} = require("../../src/planner/translation-whole-marker-wire");
 const request = buildWholeMarkerRequest(planReceivedMarkdown(message().content, {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"}), {}, {targetLanguageId: "zh-CN"});
 assert.equal(request.ok, true);
 let current = true, typed = 0; const callbacks = [], outcomes = [];
 runWholeMarkerSingle({plugin: {addSemanticExceptions: value => value}, request, lease: {isCurrent: () => current, dispatch: () => current}, dispatch: (_request, _role, done) => callbacks.push(done), dispatchTyped: () => typed++, finish: (text, outcome) => outcomes.push({text, ...outcome}), validation: {likelyTarget: () => false}});
 if (branch === "repair") callbacks[0]("⟪1⟫English answer");
 assert.equal(callbacks.length, branch === "primary" ? 1 : 2);
 current = false;
 callbacks.at(-1)("", {terminalFailure: "auth", httpStatus: 401});
 callbacks.at(-1)("", {terminalFailure: "auth", httpStatus: 403});
 assert.deepEqual(outcomes, [{text: "", reason: "stale"}]); assert.equal(typed, 0);
});

const authDeniedResponse = status => ({status, headers: {get: () => "application/json"}, text: async () => JSON.stringify({error: {message: "fixture authentication denied"}})});
for (const status of [401, 403]) for (const mode of ["manual", "auto"]) for (const branch of ["primary", "repair", "typed-fallback"]) test(`W4 auth matrix: ${status} ${mode} ${branch} terminates before semantic validation and leaves no cache`, async () => {
 const h = realDisplayOwnerFixture({respond: (_wire, call) => call === 1 && branch !== "primary" ? branch === "repair" ? "⟪1⟫English answer" : "not a marked response" : authDeniedResponse(status)}), item = message(), callbacks = [], contexts = [];
 let validations = 0; const validate = h.plugin.validateAtomicSemanticResponse.bind(h.plugin), send = h.plugin.openAiCompatibleTranslate.bind(h.plugin);
 h.plugin.validateAtomicSemanticResponse = (...args) => {validations++; return validate(...args);};
 h.plugin.openAiCompatibleTranslate = (data, done) => {contexts.push(data.requestContext); return send(data, (...args) => {callbacks.push(args); done(...args);});};
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, mode === "auto" ? autoSingle : {}), false);
  const expectedRequests = branch === "primary" ? 1 : 2, counter = h.pipeline.getWholeMarkerSingleCanarySnapshot(), terminal = h.plugin.getTranslationTerminalLedgerSnapshot();
  assert.equal(h.captures.length, expectedRequests, "only a primary auth rejection saves a request; second-stage auth still uses two total");
  assert.deepEqual(callbacks.at(-1), ["", {terminalFailure: "auth", httpStatus: status}]);
  assert.equal(validations, 0, "no typed validator is asked to interpret an auth failure as output");
  assert.equal(h.metas.length, 1); assert.equal(h.metas[0].reason, "auth");
  assert.equal(counter.applicationDispatches, expectedRequests); assert.equal(counter.repairs, branch === "repair" ? 1 : 0); assert.equal(counter.typedFallbacks, branch === "typed-fallback" ? 1 : 0); assert.equal(counter.activeRequests, 0);
  assert.equal(contexts.every(context => context.compatibilityBudget === contexts[0].compatibilityBudget), true); assert.equal(contexts[0].compatibilityBudget.getSnapshot().used, 0);
  assert.equal(terminal.activeRouteCount, 0); assert.equal(terminal.recent.length, 1); assert.equal(terminal.recent[0].reason, "auth");
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translated, false);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
  const owner = h.plugin.ensureTranslationCacheStore(); assert.equal(owner.getEntryCount(), 0); assert.equal(owner.getWholeMarkerStore().getEntryCount(), 0);
 } finally {await h.close();}
 assert.equal(h.disk.translationCacheWholeMarker, undefined); assert.equal(h.disk.translationCache, undefined);
});

for (const status of [401, 403]) test(`W4 auth matrix: streaming ${status} preserves HTTP rejection even with a transport error object`, async () => {
 const h = fixture({respond: () => authDeniedResponse(status)});
 try {
  h.plugin.settings.performance.liveStreaming = true; grant(h);
  assert.equal(await run(h, message(), autoSingle), false);
  assert.equal(h.captures.length, 1); assert.equal(h.captures[0].outer.stream, true);
  assert.equal(h.metas[0].reason, "auth"); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 0);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
 } finally {await h.close();}
});

for (const status of [401, 403]) test(`W4 auth negative: default-off ${status} keeps one callback argument and the ordinary route`, async () => {
 const h = fixture({respond: () => authDeniedResponse(status)}), callbacks = [];
 const send = h.plugin.openAiCompatibleTranslate.bind(h.plugin);
 h.plugin.openAiCompatibleTranslate = (data, done) => send(data, (...args) => {callbacks.push(args); done(...args);});
 try {
  assert.equal(await run(h), false); assert.ok(callbacks.length > 0);
  assert.equal(callbacks.every(args => args.length === 1 && args[0] === ""), true);
  assert.equal(h.captures.every(row => row.wire.startsWith("{") || !row.wire.startsWith("⟪")), true);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().admittedMessages, 0);
  assert.notEqual(h.metas[0].reason, "auth");
 } finally {await h.close();}
});

for (const failure of [400, 429, 500, "network", "malformed200"]) test(`W4 auth negative: ${failure} retains existing typed fallback and callback shape`, async () => {
 const h = fixture({respond: (wire, call) => {
  if (call > 1) return answer(wire);
  if (failure === "network") throw new Error("fixture connection reset");
  if (failure === "malformed200") return "not a marked response";
  return {status: failure, headers: {get: () => "application/json"}, text: async () => JSON.stringify({error: {message: "fixture non-auth provider error"}})};
 }}), callbacks = [];
 const send = h.plugin.openAiCompatibleTranslate.bind(h.plugin);
 h.plugin.openAiCompatibleTranslate = (data, done) => send(data, (...args) => {callbacks.push(args); done(...args);});
 try {
  grant(h); assert.equal(await run(h), true); assert.equal(h.captures.length, 2);
  assert.equal(callbacks.every(args => args.length === 1), true);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().repairs, 0);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
  assert.equal(h.cacheWrites.length, 0); assert.equal(h.skipWrites.length, 0);
 } finally {await h.close();}
});

for (const branch of ["primary", "repair", "typed-fallback"]) test(`W4 auth currentness: revoked ${branch} ignores a late auth reply and keeps one terminal`, async () => {
 let release; const h = realDisplayOwnerFixture({respond: (_wire, call) => call === 1 && branch !== "primary" ? branch === "repair" ? "⟪1⟫English answer" : "not a marked response" : new Promise(resolve => {release = resolve;})}), item = message();
 try {
  h.capture(item); grantCached(h); const pending = run(h, item, autoSingle);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, "function");
  h.pipeline.disableWholeMarkerSingleCanary(); assert.equal(await pending, false);
  release(authDeniedResponse(401)); await new Promise(resolve => setImmediate(resolve));
  const terminal = h.plugin.getTranslationTerminalLedgerSnapshot(); assert.equal(terminal.recent.length, 1); assert.equal(terminal.activeRouteCount, 0);
  assert.notEqual(terminal.recent[0].reason, "auth"); assert.equal(h.metas.length, 1);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translated, false);
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);
  assert.equal(h.captures.length, branch === "primary" ? 1 : 2);
 } finally {if (release) release(authDeniedResponse(403)); await h.close();}
});

for (const branch of ["primary", "repair", "typed-fallback"]) test(`W4 auth currentness: duplicate ${branch} provider auth callbacks settle once without a later success`, async () => {
 const h = realDisplayOwnerFixture(), item = message(); let calls = 0, validations = 0;
 const validate = h.plugin.validateAtomicSemanticResponse.bind(h.plugin); h.plugin.validateAtomicSemanticResponse = (...args) => {validations++; return validate(...args);};
 h.plugin.openAiCompatibleTranslate = (data, done) => {
  calls++;
  if (calls === 1 && branch !== "primary") return done(branch === "repair" ? "⟪1⟫English answer" : "not a marked response");
  done("", {terminalFailure: "auth", httpStatus: 401}); done(answer(data.text)); done("", {terminalFailure: "auth", httpStatus: 403});
 };
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), false);
  assert.equal(calls, branch === "primary" ? 1 : 2); assert.equal(h.metas.length, 1); assert.equal(h.metas[0].reason, "auth"); assert.equal(validations, 0);
  const terminal = h.plugin.getTranslationTerminalLedgerSnapshot(); assert.equal(terminal.recent.length, 1); assert.equal(terminal.activeRouteCount, 0);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translated, false); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().activeRequests, 0);
 } finally {await h.close();}
});

test("W4 source spoiler echo public: inline source-backed wrapper is restored once", async () => {
 const h = realDisplayOwnerFixture({respond: () => "⟪1⟫请阅读\n⟪2⟫||这条秘密消息||\n⟪3⟫在星期五之前。"}), item = message("one", "Please read ||this secret message|| before Friday.");
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), true);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, "请阅读 ||这条秘密消息|| 在星期五之前。");
  assert.equal(h.captures.length, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 0);
 } finally {await h.close();}
});

const sourceSpoilerValidator = "w4-whole-marker-spoiler-validator-v1", sourceSpoilerText = "Please read ||this secret message|| before Friday.", sourceSpoilerTranslation = "请阅读 ||这条秘密消息|| 在星期五之前。";
const sourceSpoilerReplies = {canonical: "⟪1⟫请阅读\n⟪2⟫这条秘密消息\n⟪3⟫在星期五之前。", inline: "⟪1⟫请阅读\n⟪2⟫||这条秘密消息||\n⟪3⟫在星期五之前。", external: "⟪1⟫请阅读\n||⟪2⟫这条秘密消息\n||\n⟪3⟫在星期五之前。", sameLine: "⟪1⟫请阅读\n||⟪2⟫这条秘密消息||\n⟪3⟫在星期五之前。"};
function sourceSpoilerRequest(h, source = sourceSpoilerText, optIn = true) {
 const {compileWholeMarkerSingle} = require("../../src/orchestrator/whole-marker-single-canary"), {buildWholeMarkerRequest} = require("../../src/planner/translation-whole-marker-wire");
 const typed = h.plugin.createAtomicSemanticRevisionContract(source, {place: "received", channelId: CHANNEL, engineKey: ENGINE, targetLanguageId: "zh-CN", inputLanguageId: "en", attempt: 1, maxAttempts: 3});
 const request = compileWholeMarkerSingle(h.plugin, typed); assert.ok(request);
 return optIn ? request : buildWholeMarkerRequest(request.plan, request.protectedSegments, {targetLanguageId: "zh-CN"});
}
for (const mode of ["manual", "auto"]) for (const format of Object.keys(sourceSpoilerReplies)) test(`W4 source spoiler public: ${mode} ${format} preserves exactly the source wrapper with actual validator labels`, async () => {
 const h = realDisplayOwnerFixture({respond: () => sourceSpoilerReplies[format]}), item = message("one", sourceSpoilerText);
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, mode === "auto" ? autoSingle : {}), true);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, sourceSpoilerTranslation);
  assert.equal(h.captures.length, 1); assert.doesNotMatch(h.captures[0].body, /sourceSpoilerEcho|w4-whole-marker-spoiler/);
  assert.equal(h.metas[0].validatorVersion, sourceSpoilerValidator); assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).validatorFamily, sourceSpoilerValidator);
  const counter = h.pipeline.getWholeMarkerSingleCanarySnapshot(); assert.equal(counter.repairs, 0); assert.equal(counter.typedFallbacks, 0); assert.equal(counter.activeRequests, 0);
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 1); assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
  assert.equal(h.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
 } finally {await h.close();}
});
for (const mode of ["manual", "auto"]) test(`W4 source spoiler cache: ${mode} warm and restart use new identity without dispatch or duplicate wrapper`, async () => {
 const h = realDisplayOwnerFixture({respond: () => sourceSpoilerReplies.external}), item = message("one", sourceSpoilerText), options = mode === "auto" ? autoSingle : {}; let disk;
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, options), true);
  assert.equal(await run(h, item), false); grantCached(h); assert.equal(await run(h, item, options), true);
  assert.equal(h.captures.length, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().applicationDispatches, 0);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, sourceSpoilerTranslation);
  const terminal = h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1); assert.equal(terminal.cacheRead, "translation-hit"); assert.equal(terminal.validatorFamily, sourceSpoilerValidator);
  assert.equal(h.metas.at(-1).validatorVersion, sourceSpoilerValidator);
 } finally {await h.close();}
 disk = JSON.parse(JSON.stringify(h.disk)); assert.match(Object.values(disk.translationCacheWholeMarker.entries)[0].translation.cacheIdentity, /w4-whole-marker-spoiler-validator-v1/);
 const restarted = realDisplayOwnerFixture({disk, respond: () => {throw new Error("warm restart must not dispatch");}});
 try {
  restarted.capture(item); grantCached(restarted); assert.equal(await run(restarted, item, options), true);
  assert.equal(restarted.captures.length, 0); assert.equal(restarted.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, sourceSpoilerTranslation);
  assert.equal(restarted.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).validatorFamily, sourceSpoilerValidator);
  assert.equal(restarted.metas[0].validatorVersion, sourceSpoilerValidator);
 } finally {await restarted.close();}
});
test("W4 source spoiler cache: eligible old/new identities miss in both directions while ordinary identity is unchanged", async () => {
 const {createWholeMarkerCacheIdentity} = require("../../src/orchestrator/whole-marker-single-canary"), {createWholeMarkerTranslationCacheStore} = require("../../src/cache/translation-cache-store");
 const h = realDisplayOwnerFixture(), make = (source, optIn) => createWholeMarkerCacheIdentity(h.plugin, sourceSpoilerRequest(h, source, optIn), {channelId: CHANNEL, messageId: "one", source}, {id: "en"}, {id: "zh-CN"}, ENGINE);
 try {
  const oldIdentity = make(sourceSpoilerText, false), nextIdentity = make(sourceSpoilerText, true);
  const changed = Object.keys(oldIdentity).filter(key => oldIdentity[key] !== nextIdentity[key]); assert.deepEqual(changed.sort(), ["reassemblyVersion", "validatorVersion"]);
  assert.deepEqual(make(message().content, false), make(message().content, true), "no eligible spoiler keeps the exact old cache identity");
  const store = h.plugin.ensureTranslationCacheStore().getWholeMarkerStore(), value = {channelId: CHANNEL, originalContent: sourceSpoilerText, translatedContent: sourceSpoilerTranslation, wireFamily: "whole-marker"};
  assert.equal(store.persistTranslation(oldIdentity, value), true); assert.equal(store.getCachedTranslation(nextIdentity), null); assert.ok(store.getCachedTranslation(oldIdentity));
  assert.equal(store.persistTranslation(nextIdentity, value), true); assert.equal(store.getCachedTranslation(oldIdentity), null); assert.ok(store.getCachedTranslation(nextIdentity));
  store.flushPendingSave(); const disk = JSON.parse(JSON.stringify(h.disk.translationCacheWholeMarker));
  const rollbackReader = createWholeMarkerTranslationCacheStore({loadCache: () => disk, saveCache: () => {throw new Error("a version miss must not save");}});
  assert.equal(rollbackReader.loadPersisted(), true); assert.equal(rollbackReader.getCachedTranslation(oldIdentity), null); assert.ok(rollbackReader.getCachedTranslation(nextIdentity)); assert.equal(rollbackReader.getEntryCount(), 1); assert.equal(rollbackReader.flushPendingSave(), false);
 } finally {await h.close();}
});
for (const ordinal of [1, 2]) test(`W4 source spoiler repair: only range ${ordinal} keeps the parent contract and source pair permissions`, async () => {
 const stages = [], h = realDisplayOwnerFixture({respond: (_wire, call) => call === 1 ? sourceSpoilerReplies.inline.replace(ordinal === 1 ? "请阅读" : "这条秘密消息", "English answer") : ordinal === 1 ? "⟪1⟫请阅读" : "||⟪2⟫这条秘密消息||"}), item = message("one", sourceSpoilerText);
 const record = h.plugin.recordTranslationTerminalStage.bind(h.plugin); h.plugin.recordTranslationTerminalStage = (...args) => {stages.push(args); return record(...args);};
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), true); assert.equal(h.captures.length, 2);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, sourceSpoilerTranslation);
  const counter = h.pipeline.getWholeMarkerSingleCanarySnapshot(); assert.equal(counter.repairs, 1); assert.equal(counter.typedFallbacks, 0);
  assert.equal(h.metas[0].validatorVersion, sourceSpoilerValidator); assert.equal(h.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1).validatorFamily, sourceSpoilerValidator);
  assert.equal(stages.filter(args => args[1] === "provider" && args[2] === "dispatch").every(args => args[3].validatorFamily === sourceSpoilerValidator), true);
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 1);
 } finally {await h.close();}
});
test("W4 source spoiler failure: misplaced new pair still takes the unchanged one typed fallback with no D or typed cache write", async () => {
 const h = realDisplayOwnerFixture({respond: (wire, call) => call === 1 ? "⟪1⟫请阅读||\n⟪2⟫这条秘密消息\n⟪3⟫||在星期五之前。" : JSON.stringify({segments: JSON.parse(wire).segments.map(row => ({id: row.id, translation: "请阅读 ⟦F0⟧这条秘密消息⟦/F0⟧ 在星期五之前。"}))})}), item = message("one", sourceSpoilerText), stages = [];
 const record = h.plugin.recordTranslationTerminalStage.bind(h.plugin); h.plugin.recordTranslationTerminalStage = (...args) => {stages.push(args); return record(...args);};
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), true); assert.equal(h.captures.length, 2);
  assert.equal(h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent, sourceSpoilerTranslation);
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 1); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().repairs, 0);
  assert.ok(stages.some(args => args[1] === "parse" && args[2] === "unsafe-structure" && args[3].validatorFamily === sourceSpoilerValidator));
  assert.equal(h.metas[0].wireFamily, "typed-json"); assert.notEqual(h.metas[0].validatorVersion, sourceSpoilerValidator);
  assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 0); assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
 } finally {await h.close();}
});


test("W4 source spoiler captured f06: the fixed original response commits in one request with source format intact", async () => {
 const source = "## Synthetic release notes\n\n> Translate the explanation but keep the structure.\n\n- First checklist item\n- Second checklist item with ||spoiler text||\n\n| Field | Value |\n| --- | --- |\n| Status | Ready for review |\n\n[Read the synthetic guide](https://docs.example.invalid/guide)\n\n```js\nconst syntheticVersion = \"v2.4.1\";\n```\n\nThe fenced code and link destination must remain unchanged.", raw = "⟪1⟫综合发布说明\n⟪2⟫翻译说明，但保持原有结构。\n⟪3⟫第一个清单项目\n⟪4⟫第二个清单项目，包含\n ||⟪5⟫剧透文本\n||\n⟪6⟫字段\n⟪7⟫值\n⟪8⟫状态\n⟪9⟫准备评审\n⟪10⟫阅读综合指南\n⟪11⟫围栏代码和链接目标必须保持不变。";
 const h = realDisplayOwnerFixture({respond: () => raw}), item = message("one", source);
 try {
  h.capture(item); grantCached(h); assert.equal(await run(h, item, autoSingle), true); assert.equal(h.captures.length, 1);
  assert.equal(require("node:crypto").createHash("sha256").update(h.captures[0].wire).digest("hex").toUpperCase(), "A830DA9AC8CBF39B297F651E6FF70F838852CC4AC391DCE5B96A713C542C4E50");
  const translated = h.plugin.getReceivedDisplayRuntimeView(item.id).translation.translatedContent;
  assert.ok(translated.includes("||剧透文本||")); assert.equal(translated.includes("||||"), false);
  assert.ok(translated.includes('[阅读综合指南](https://docs.example.invalid/guide)')); assert.ok(translated.includes('const syntheticVersion = "v2.4.1";'));
  assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().repairs, 0); assert.equal(h.pipeline.getWholeMarkerSingleCanarySnapshot().typedFallbacks, 0);
  assert.equal(h.metas[0].validatorVersion, sourceSpoilerValidator); assert.equal(h.plugin.ensureTranslationCacheStore().getWholeMarkerStore().getEntryCount(), 1); assert.equal(h.plugin.hasCachedTranslationEntry(item.id), false);
 } finally {await h.close();}
});
