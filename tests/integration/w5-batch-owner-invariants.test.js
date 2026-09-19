const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("../helpers/createPluginInstance");

// Real History/Live queue, provider, planner, validators and commit owners. Only transport,
// target-language judgment and final display acknowledgment are fixture boundaries.
const CURRENT = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const ENGINE = "custom-w5owners", CHANNEL = "w5-owner-channel";
const names = {Alpha: "阿尔法", Beta: "贝塔", Gamma: "伽马"};
const sources = Object.keys(names).map(name => ({id: `owner-${name.toLowerCase()}`, content: `Please review the ${name} release with \`${name.toUpperCase()}_TOKEN\`.`}));
const expected = {
 "owner-alpha": "请审核带有 `ALPHA_TOKEN` 的阿尔法版本。",
 "owner-beta": "请审核带有 `BETA_TOKEN` 的贝塔版本。",
 "owner-gamma": "请审核带有 `GAMMA_TOKEN` 的伽马版本。"
};
const tokens = text => (String(text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧/g) || []).join("");
function translated(text) {
 const name = Object.keys(names).find(name => String(text).includes(name));
 assert.ok(name, `unknown fixture range: ${text}`);
 return String(text).includes("Please review") ? `请审核带有 ${tokens(text)} 的${names[name]}版本。` : `请确认${names[name]}明天的截止日期。`;
}
const isRangeObject = value => value && !Array.isArray(value) && Object.keys(value).every(key => /^[1-9]\d*\.[1-9]\d*$/.test(key));
function goodReply(payload) {
 if (isRangeObject(payload)) return JSON.stringify(Object.fromEntries(Object.entries(payload).map(([key, text]) => [key, translated(text)])));
 assert.equal(payload.schemaVersion, "semantic-batch-v1", "no single or legacy fallback dispatch");
 return JSON.stringify({messages: payload.messages.map(row => ({id: row.id, segments: row.plan.segments.map(segment => ({id: segment.id, translation: translated(segment.text)}))}))});
}
const message = row => ({id: row.id, channel_id: CHANNEL, content: row.content, embeds: [], attachments: [], author: {id: "other-user"}});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
async function until(predicate, label) {const deadline = Date.now() + 3000; while (Date.now() < deadline) {if (predicate()) return; await new Promise(r => setTimeout(r, 5));} assert.ok(predicate(), label);}

function harness(script = ({payload}) => goodReply(payload), historicalConcurrency = "1") {
 const requests = [], commits = [], cacheWrites = [], skipWrites = [], singles = [], errors = [], views = new Map(), messages = new Map();
 const dispatch = async (url, options, transport) => {
  assert.match(url, /^https:\/\/w5-owner\.fixture\//, "only in-memory fixture requests");
  const outer = JSON.parse(options.body), payload = JSON.parse(outer.messages.at(-1).content);
  const call = {payload, body: String(options.body), signal: options.signal, transport, family: isRangeObject(payload) ? "D-batch" : payload.schemaVersion}; requests.push(call);
  const content = await script({payload, call, index: requests.length, requests});
  if (content instanceof Response) return content;
  return new Response(JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}], usage: {prompt_tokens: 12, completion_tokens: 7}}), {status: 200, headers: {"content-type": "application/json"}});
 };
 const request = (url, options, callback) => {dispatch(url, options, "callback").then(async result => callback(null, {statusCode: result.status, headers: {}}, await result.text())).catch(error => {errors.push(String(error)); callback(error);}); return {abort() {}};};
 const plugin = createPluginInstance({pluginPath: CURRENT, callSetLanguages: false, bdfdb: {LibraryRequires: {request}}, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]}, performance: {historicalConcurrency, historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: false, compactWireShadow: "off"}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wordStart: ["!"], protectedTerms: [], wrapperPairs: [], protectedTermsForReceived: true, wrapperPairsForReceived: true}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
 global.BdApi.Net = {fetch: (url, options) => dispatch(url, options, "native")};
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
function grant(h, rows = sources) {const provider = h.plugin.ensureProviderClient(); assert.equal(typeof provider.enableWholeMarkerBatchCanary, "function", "W5 session grant public API"); assert.equal(provider.enableWholeMarkerBatchCanary({engineKey: ENGINE, channelId: CHANNEL, messageIds: rows.map(row => row.id), maxMessages: 20, ttlMs: 300000}), true); return provider;}
function runHistory(h, rows = sources) {for (const row of rows) assert.equal(h.plugin.queueAutoTranslateMessage((h.messages.set(row.id, message(row)), h.messages.get(row.id)), {id: CHANNEL}, {content: row.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true); return h.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);}
async function runLive(h, rows = sources) {const queue = h.plugin.ensureLiveTranslationQueue(); h.plugin.translateMessage = item => {h.singles.push(String(item.id)); return Promise.resolve(false);}; queue.setBusyTranslating(true); for (const row of rows) assert.equal(h.plugin.queueAutoTranslateMessage((h.messages.set(row.id, message(row)), h.messages.get(row.id)), {id: CHANNEL}, {content: row.content, embeds: []}), true); queue.setBusyTranslating(false); queue.processQueue(); await until(() => queue.getQueueLength() === 0 && !queue.isLiveAutoTranslating(), "all live items settle");}
function assertNoW5Cache(h) {assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.skipWrites, []); const store = h.plugin.ensureProviderClient().getWholeMarkerBatchCanarySnapshot(); assert.equal(store.activeRequests, 0);}
function assertResources(h) {const provider = h.plugin.ensureProviderClient(); assert.equal(provider.getProviderAttemptSnapshot().active, 0); const s = h.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(s.physical.active, 0); assert.equal(s.historicalAbortControllerCount, 0); assert.deepEqual(s.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0}); assert.deepEqual(h.errors, []);}
async function close(h) {try {await h.plugin.onStop();} finally {delete global.BdApi.Net;}}

test("W5 History completed blocks display before a slower block without replay or cache writes", async () => {
 const pending = deferred(), rows = Array.from({length: 20}, (_, index) => ({...sources[index % sources.length], id: `progress-${index}`}));
 const h = harness(async ({payload, index}) => {assert.ok(isRangeObject(payload)); if (index === 2) await pending.promise; return goodReply(payload);}, "2");
 let running;
 try {
  grant(h, rows); running = runHistory(h, rows);
  await until(() => h.requests.length === 2, "both original W5 blocks are dispatched");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.commits.length, 1, "the completed W5 block must display while its sibling HTTP request is pending");
  assert.deepEqual([...h.views.keys()], rows.slice(0, 10).map(row => row.id));
  for (let index = 0; index < 10; index++) assert.equal(h.views.get(rows[index].id).translation.translatedContent, expected[sources[index % sources.length].id]);
  pending.resolve(); await running;
  assertDOnly(h, 2); assert.equal(h.commits.length, 2, "final completion must not replay either acknowledged block");
  assert.equal(h.views.size, 20); assert.equal(new Set(h.commits.flat().map(row => row.messageId)).size, 20);
  for (let index = 0; index < rows.length; index++) assert.equal(h.views.get(rows[index].id).translation.translatedContent, expected[sources[index % sources.length].id]);
  assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if (running) await running; await close(h);}
});

for (const ending of ["cancel", "revoke", "source-edit", "auth", "malformed"]) test(`W5 History keeps acknowledged blocks after a pending sibling ${ending}`, async () => {
 const pending = deferred(), rows = Array.from({length: 20}, (_, index) => ({...sources[index % sources.length], id: `ending-${index}`}));
 const h = harness(async ({payload, index}) => {
  assert.ok(isRangeObject(payload));
  if (index === 2) {
   await pending.promise;
   if (ending === "auth") return new Response('{"error":"fixture unauthorized"}', {status: 401});
   if (ending === "malformed") return JSON.stringify({...JSON.parse(goodReply(payload)), extra: 2});
  }
  return goodReply(payload);
 }, "2");
 let running;
 try {
  const provider = grant(h, rows); running = runHistory(h, rows);
  await until(() => h.commits.length === 1 && h.requests.length === 2, "first block accepted while its sibling is pending");
  const firstIds = rows.slice(0, 10).map(row => row.id);
  assert.deepEqual(h.commits[0].map(row => row.messageId), firstIds);
  if (ending === "cancel") h.plugin.clearAutoTranslationQueue(CHANNEL);
  if (ending === "revoke") provider.disableWholeMarkerBatchCanary();
  if (ending === "source-edit") h.messages.get(rows[10].id).content += " Updated source.";
  pending.resolve(); await running;
  assertDOnly(h, 2);
  const translated = h.commits.flat().filter(row => row.status === "translated");
  assert.deepEqual(translated.map(row => row.messageId), firstIds, "paid successes remain unique; no late sibling output is displayed");
  assert.equal(h.commits.length, ["auth", "malformed"].includes(ending) ? 2 : 1);
  if (["auth", "malformed"].includes(ending)) assert.ok(h.commits[1].every(row => row.status === "failed"));
  for (const id of firstIds) assert.equal(h.views.get(id).status, "translated");
  assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if (running) await running; await close(h);}
});

test("W5 History source currentness rejects a completed block during asynchronous validation", async () => {
 const validationGate = deferred(), pending = deferred(), rows = Array.from({length: 20}, (_, index) => ({...sources[index % sources.length], id: `validate-${index}`}));
 const h = harness(async ({payload, index}) => {if (index === 2) await pending.promise; return goodReply(payload);}, "2");
 const validate = h.plugin.validateHistoricalTranslationJobResult.bind(h.plugin);
 let validationStarted = false, running;
 h.plugin.validateHistoricalTranslationJobResult = async (...args) => {const result = validate(...args); if (args[0].message.id === rows[0].id) {validationStarted = true; await validationGate.promise;} return result;};
 try {
  grant(h, rows); running = runHistory(h, rows);
  await until(() => validationStarted && h.requests.length === 2, "real W5 validator result is pending at the async boundary");
  h.messages.get(rows[0].id).content += " Updated source.";
  validationGate.resolve(); pending.resolve(); await running;
  assertDOnly(h, 2);
  assert.deepEqual(h.commits.flat().map(row => row.messageId), rows.slice(10).map(row => row.id), "stale first-block validation never crosses the display seam");
  assertNoW5Cache(h); assertResources(h);
 } finally {validationGate.resolve(); pending.resolve(); if (running) await running; await close(h);}
});

for (const accepted of [false, true]) test(`W5 History deferred display ACK after revoke preserves only ${accepted ? "already accepted" : "unaccepted"} store results`, async () => {
 const ackGate = deferred(), pending = deferred(), rows = Array.from({length: 20}, (_, index) => ({...sources[index % sources.length], id: `ack-${index}`}));
 const h = harness(async ({payload, index}) => {if (index === 2) await pending.promise; return goodReply(payload);}, "2");
 let waiting = false, running;
 if (accepted) {
  const display = h.plugin.commitHistoricalReceivedDisplayBatch.bind(h.plugin);
  h.plugin.commitHistoricalReceivedDisplayBatch = async results => {const ack = await display(results); waiting = true; await ackGate.promise; return ack;};
 } else {
  const commit = h.plugin.commitHistoricalTranslationJob.bind(h.plugin);
  h.plugin.commitHistoricalTranslationJob = async (summary, job, options) => {if (options && options.partial) {waiting = true; await ackGate.promise;} return commit(summary, job, options);};
 }
 try {
  const provider = grant(h, rows); running = runHistory(h, rows);
  await until(() => waiting && h.requests.length === 2, "first display proposal or accepted ACK is deferred");
  const job = h.plugin.getHistoricalTranslationJobQueue(CHANNEL, false).jobs[0];
  assert.equal(h.views.size, accepted ? 10 : 0);
  provider.disableWholeMarkerBatchCanary(); ackGate.resolve(); pending.resolve(); await running;
  const expectedIds = accepted ? rows.slice(0, 10).map(row => row.id) : [];
  assert.deepEqual([...h.views.keys()], expectedIds);
  assert.deepEqual([...job.progressCommittedIds], expectedIds, "grant revoke does not override an already accepted store ACK");
  assert.deepEqual(job.createSummary().translated.map(item => item.message.id), expectedIds, "summary agrees with accepted display results");
  const perf = h.plugin.getHistoricalBatchPerformanceSnapshot().latestRun;
  assert.equal(perf.translatedCount, expectedIds.length); assert.equal(perf.committedCount, expectedIds.length);
  assert.equal(h.commits.length, accepted ? 1 : 0); assertDOnly(h, 2); assertNoW5Cache(h); assertResources(h);
 } finally {ackGate.resolve(); pending.resolve(); if (running) await running; await close(h);}
});

test("W5 owners history: D repair sends only the failed single-range message and never replays its successful siblings", async () => {
 const h = harness(({payload,index}) => {assert.ok(isRangeObject(payload)); if (index === 1) return JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "2.1").map(([key, text]) => [key, translated(text)]))); assert.equal(index, 2); assert.deepEqual(Object.keys(payload), ["2.1"]); return goodReply(payload);});
 try {grant(h); await runHistory(h); assert.deepEqual(h.requests.map(row => row.family), ["D-batch", "D-batch"], JSON.stringify({perf: h.plugin.getHistoricalBatchPerformanceSnapshot(), ledger: h.plugin.getTranslationTerminalLedgerSnapshot(), errors: h.errors})); assert.equal(h.commits.length, 1, JSON.stringify({latest: h.plugin.getHistoricalBatchPerformanceSnapshot().latestRun, ledger: h.plugin.getTranslationTerminalLedgerSnapshot().recent, errors: h.errors})); for (const row of sources) assert.equal(h.views.get(row.id).translation.translatedContent, expected[row.id]); assertNoW5Cache(h); assertResources(h);} finally {await close(h);}
});

const partialReply = payload => JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "2.1").map(([key, text]) => [key, translated(text)])));
function assertTranslations(h, rows = sources) {for (const row of rows) {const view = h.views.get(row.id); assert.ok(view, `missing display acknowledgment ${row.id}`); assert.equal(view.status, "translated"); assert.equal(view.translation.translatedContent, expected[row.id]);}}
function assertDOnly(h, count) {assert.equal(h.requests.length, count); assert.ok(h.requests.every(row => row.family === "D-batch" && row.transport === "native"));}

test("W5 owners history: unresolved repair is terminal, successful siblings commit once, no History second repair", async () => {
 const h = harness(({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 2) assert.deepEqual(Object.keys(payload), ["2.1"]); assert.ok(index <= 2); return partialReply(payload);});
 try {grant(h); await runHistory(h); assertDOnly(h, 2); assert.equal(h.commits.length, 2, "accepted successes are displayed before the final failed status"); assert.deepEqual(h.commits[0].map(row => row.messageId), [sources[0].id, sources[2].id]); assert.deepEqual(h.commits[1].map(row => row.messageId), [sources[1].id]); assertTranslations(h, [sources[0],sources[2]]); assert.equal(h.views.get(sources[1].id).status, "failed"); const p = h.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(p.latestRun.repairBatchRequests, 0); assert.equal(p.latestRun.repairItemRequests, 0); assert.equal(p.latestRun.translatedCount, 2); assert.equal(p.latestRun.failedCount, 1); assertNoW5Cache(h); assertResources(h);} finally {await close(h);}
});

for (const phase of ["primary", "repair"]) for(const action of ["cancel", "revoke"]) test(`W5 owners history: ${action} during ${phase} aborts native work and ignores late valid body`, async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if (phase === "repair" && index === 1) return partialReply(payload); await pending.promise; return goodReply(payload);});
 try {const provider = grant(h), running = runHistory(h), count = phase === "repair" ? 2 : 1; await until(() => h.requests.length === count, "pending native request admitted"); const signal = h.requests.at(-1).signal; assert.ok(signal); if(action === "cancel") h.plugin.clearAutoTranslationQueue(CHANNEL); else provider.disableWholeMarkerBatchCanary(); assert.equal(signal.aborted, true); pending.resolve(); await running; assertDOnly(h, count); assert.equal(h.commits.length, 0, "late body neither commits successes nor status placeholders"); assertNoW5Cache(h); assertResources(h);} finally {pending.resolve(); await close(h);}
});

test("W5 owners live: partial repair maps out-of-order siblings and never requeues a single", async () => {
 const h = harness(({payload,index}) => {assert.ok(isRangeObject(payload)); if (index === 1) return partialReply(Object.fromEntries(Object.entries(payload).reverse())); assert.equal(index, 2); assert.deepEqual(Object.keys(payload), ["2.1"]); return goodReply(payload);});
 try {grant(h); await runLive(h); assertDOnly(h, 2); assertTranslations(h); assert.equal(h.commits.length, 3); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);} finally {await close(h);}
});

test("W5 owners live: unresolved item has failed terminal route with no status commit or single requeue", async () => {
 const h = harness(({payload,index}) => {assert.ok(isRangeObject(payload)); assert.ok(index <= 2); return partialReply(payload);});
 try {grant(h); await runLive(h); assertDOnly(h, 2); assertTranslations(h, [sources[0],sources[2]]); assert.equal(h.commits.length, 2); assert.equal(h.views.has(sources[1].id), false); assert.deepEqual(h.singles, []); const ledger = h.plugin.getTranslationTerminalLedgerSnapshot(); assert.equal(ledger.reasons.requeue_single || 0, 0); const routes = ledger.recent.filter(row => row.lane === "live-burst"); assert.equal(routes.length, 3); assert.equal(routes.filter(row => row.outcome === "translated").length, 2); assert.equal(routes.filter(row => row.outcome === "failed").length, 1); assertNoW5Cache(h); assertResources(h);} finally {await close(h);}
});

for(const action of ["cancel", "revoke"]) test(`W5 owners live: ${action} ignores late native success without cache or requeue`, async () => {
 const pending = deferred(), h = harness(async ({payload}) => {assert.ok(isRangeObject(payload)); await pending.promise; return goodReply(payload);});
 try {const provider = grant(h), running = runLive(h); await until(() => h.requests.length === 1, "native live request"); const signal = h.requests[0].signal; if(action === "cancel") h.plugin.clearAutoTranslationQueue(CHANNEL); else provider.disableWholeMarkerBatchCanary(); assert.equal(signal.aborted, true); pending.resolve(); await running; assertDOnly(h, 1); assert.equal(h.commits.length, 0); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);} finally {pending.resolve(); await close(h);}
});

test("W5 owners default-off: original typed batch body and cache behavior match grant-then-disable", async () => {
 const captures = [];
 for(const enableThenDisable of [false,true]) {const h = harness(); try {if(enableThenDisable) grant(h).disableWholeMarkerBatchCanary(); await runHistory(h); assert.deepEqual(h.requests.map(row => row.family), ["semantic-batch-v1"]); assertTranslations(h); assert.equal(h.cacheWrites.length, 3, "original typed cache remains enabled"); assert.equal(h.skipWrites.length, 0); assertResources(h); captures.push(h.requests[0].body);} finally {await close(h);}}
 assert.equal(captures[1], captures[0], "default-off request bytes are unchanged by a revoked W5 grant");
});

for(const lane of ["history", "live"]) test(`W5 owners ${lane}: one source edit while pending prevents every old batch commit`, async () => {
 const pending = deferred(), h = harness(async ({payload}) => {await pending.promise; return goodReply(payload);});
 try {grant(h); const running = lane === "history" ? runHistory(h) : runLive(h); await until(() => h.requests.length === 1, "native request pending before source edit"); h.messages.get(sources[1].id).content += " The source has changed."; pending.resolve(); await running; assertDOnly(h, 1); assert.equal(h.commits.length, 0); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);} finally {pending.resolve(); await close(h);}
});

for(const lane of ["history", "live"]) for(const mode of ["duplicate", "unknown"]) test(`W5 owners ${lane}: ${mode} outer ID is terminal without typed, legacy or per-item replay`, async () => {
 const h = harness(({payload,index}) => {assert.equal(index, 1); assert.ok(isRangeObject(payload)); const reply = goodReply(payload); return reply.slice(0, -1) + `,"${mode === "duplicate" ? "1.1" : "999.1"}":"额外译文"}`;});
 try {grant(h); if(lane === "history") await runHistory(h); else await runLive(h); assertDOnly(h, 1); assert.ok([...h.views.values()].every(view => view.status !== "translated")); if(lane === "history") {const s = h.plugin.getHistoricalBatchPerformanceSnapshot().latestRun; assert.equal(s.failedCount, 3); assert.equal(s.repairBatchRequests, 0); assert.equal(s.repairItemRequests, 0);} else {assert.equal(h.commits.length, 0); assert.deepEqual(h.singles, []);} assertNoW5Cache(h); assertResources(h);} finally {await close(h);}
});

test("W5 owners live early: primary successes commit exactly once while repair is pending", async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if (index === 1) return partialReply(payload); assert.equal(index, 2); assert.deepEqual(Object.keys(payload), ["2.1"]); await pending.promise; return goodReply(payload);});
 let running;
 try {
  grant(h); running = runLive(h);
  await until(() => h.requests.length === 2, "repair request is pending");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.commits.length, 2, "primary success display commits must not wait for repair");
  const earlyIds = h.commits.map(row => row.messageId);
  assert.deepEqual(earlyIds.slice().sort(), [sources[0].id, sources[2].id]);
  assertTranslations(h, [sources[0],sources[2]]);
  assert.equal(h.views.has(sources[1].id), false, "failed primary sibling is still pending");
  assert.equal(h.plugin.ensureLiveTranslationQueue().getLiveSlotActiveCount(), 1, "repair retains its original live slot");
  pending.resolve(); await running;
  assertDOnly(h, 2); assertTranslations(h);
  assert.deepEqual(h.commits.map(row => row.messageId), [...earlyIds, sources[1].id], "final completion adds only the repaired sibling");
  assert.equal(h.plugin.ensureLiveTranslationQueue().getLiveSlotActiveCount(), 0);
  assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if(running) await running; await close(h);}
});
for(const action of ["cancel", "revoke"]) test(`W5 owners live early: ${action} during repair retains acknowledged primary siblings without late replay`, async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 1) return partialReply(payload); assert.equal(index, 2); await pending.promise; return goodReply(payload);});
 let running;
 try {
  const provider = grant(h); running = runLive(h);
  await until(() => h.requests.length === 2, "repair is admitted before cancellation");
  await new Promise(resolve => setImmediate(resolve));
  assertTranslations(h, [sources[0],sources[2]]);
  const earlyIds = h.commits.map(row => row.messageId);
  assert.deepEqual(earlyIds.slice().sort(), [sources[0].id,sources[2].id]);
  const signal = h.requests[1].signal;
  if(action === "cancel") h.plugin.clearAutoTranslationQueue(CHANNEL); else provider.disableWholeMarkerBatchCanary();
  assert.equal(signal.aborted, true, "unresolved repair aborts");
  pending.resolve(); await running;
  assert.deepEqual(h.commits.map(row => row.messageId), earlyIds, "completed siblings are neither removed nor replayed");
  assertTranslations(h, [sources[0],sources[2]]);
  assert.equal(h.views.has(sources[1].id), false);
  assertDOnly(h, 2); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if(running) await running; await close(h);}
});

test("W5 owners history early: an individual block retains its atomic repair boundary", async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 1) return partialReply(payload); assert.equal(index, 2); await pending.promise; return goodReply(payload);});
 let running;
 try {
  grant(h); running = runHistory(h);
  await until(() => h.requests.length === 2, "History repair is admitted");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.commits.length, 0, "a block is not displayed before its own repair settles");
  assert.equal(h.views.size, 0);
  pending.resolve(); await running;
  assert.equal(h.commits.length, 1); assertTranslations(h); assertDOnly(h, 2); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if(running) await running; await close(h);}
});

test("W5 owners live early: repair rejection preserves acknowledged successes without a fallback request", async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 1) return partialReply(payload); assert.equal(index, 2); await pending.promise; throw new Error("fixture repair rejection");});
 let running;
 try {
  grant(h); running = runLive(h);
  await until(() => h.requests.length === 2, "repair is admitted before rejection");
  await new Promise(resolve => setImmediate(resolve));
  assertTranslations(h, [sources[0],sources[2]]);
  const earlyIds = h.commits.map(row => row.messageId);
  assert.deepEqual(earlyIds.slice().sort(), [sources[0].id,sources[2].id]);
  pending.resolve(); await running;
  assert.deepEqual(h.commits.map(row => row.messageId), earlyIds);
  assertTranslations(h, [sources[0],sources[2]]); assert.equal(h.views.has(sources[1].id), false);
  assertDOnly(h, 2); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if(running) await running; await close(h);}
});

for(const changed of ["completed", "pending"]) test(`W5 owners live early: editing a ${changed} item during repair preserves only current unpaid commits`, async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 1) return partialReply(payload); assert.equal(index, 2); await pending.promise; return goodReply(payload);});
 let running;
 try {
  grant(h); running = runLive(h);
  await until(() => h.requests.length === 2, "repair is pending before source edit");
  await new Promise(resolve => setImmediate(resolve));
  assertTranslations(h, [sources[0],sources[2]]);
  const earlyIds = h.commits.map(row => row.messageId);
  h.messages.get(sources[changed === "completed" ? 0 : 1].id).content += " The source has changed.";
  pending.resolve(); await running;
  assert.deepEqual(h.commits.map(row => row.messageId), changed === "completed" ? [...earlyIds,sources[1].id] : earlyIds);
  if(changed === "completed") assertTranslations(h, [sources[1],sources[2]]);
  else assert.equal(h.views.has(sources[1].id), false, "edited pending sibling never receives the old repair");
  assertDOnly(h, 2); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if(running) await running; await close(h);}
});

test("W5 owners live early: asynchronous display acknowledgment does not delay repair but retains the live slot", async () => {
 const pending = deferred(), acknowledgment = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 1) return partialReply(payload); assert.equal(index, 2); await pending.promise; return goodReply(payload);});
 h.plugin.commitReceivedDisplayResult = async result => {
  h.commits.push(result);
  if(String(result.messageId) === sources[0].id) await acknowledgment.promise;
  h.views.set(String(result.messageId), result);
  return {committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []};
 };
 let running;
 try {
  grant(h); running = runLive(h);
  await until(() => h.requests.length === 2, "repair starts before delayed alpha display ACK");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.commits.length, 2); assertTranslations(h, [sources[2]]);
  assert.equal(h.views.has(sources[0].id), false);
  assert.equal(h.plugin.ensureLiveTranslationQueue().getLiveSlotActiveCount(), 1);
  const earlyIds = h.commits.map(row => row.messageId);
  pending.resolve();
  await until(() => h.views.has(sources[1].id), "repaired beta commits while alpha ACK is still pending");
  assert.equal(h.plugin.ensureLiveTranslationQueue().getLiveSlotActiveCount(), 1, "slot also owns outstanding display ACK");
  assert.deepEqual(h.commits.map(row => row.messageId), [...earlyIds,sources[1].id]);
  acknowledgment.resolve(); acknowledgment.resolve(); await running;
  assertTranslations(h); assert.equal(h.commits.length, 3, "duplicate ACK resolution never replays a display commit");
  assert.equal(h.plugin.ensureLiveTranslationQueue().getLiveSlotActiveCount(), 0);
  assertDOnly(h, 2); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); acknowledgment.resolve(); if(running) await running; await close(h);}
});

for(const failure of ["throw", "reject"]) test(`W5 owners live early: display ${failure} is terminal for that item and does not replay or discard siblings`, async () => {
 const pending = deferred(), h = harness(async ({payload,index}) => {assert.ok(isRangeObject(payload)); if(index === 1) return partialReply(payload); assert.equal(index, 2); await pending.promise; return goodReply(payload);});
 const originalCommit = h.plugin.commitReceivedDisplayResult;
 h.plugin.commitReceivedDisplayResult = result => {
  if(String(result.messageId) !== sources[0].id) return originalCommit(result);
  h.commits.push(result);
  if(failure === "throw") throw new Error("fixture display throw");
  return Promise.reject(new Error("fixture display rejection"));
 };
 let running;
 try {
  grant(h); running = runLive(h);
  await until(() => h.requests.length === 2, "repair survives display failure");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.commits.length, 2); assertTranslations(h, [sources[2]]);
  assert.equal(h.views.has(sources[0].id), false);
  pending.resolve(); await running;
  assert.equal(h.commits.length, 3); assert.equal(h.commits.filter(row => row.messageId === sources[0].id).length, 1);
  assertTranslations(h, [sources[1],sources[2]]);
  assert.equal(h.views.has(sources[0].id), false);
  assertDOnly(h, 2); assert.deepEqual(h.singles, []); assertNoW5Cache(h); assertResources(h);
 } finally {pending.resolve(); if(running) await running; await close(h);}
});

test("W5 owners live early: default-off and revoked grant retain identical typed body and cache behavior", async () => {
 const captures = [];
 for(const enableThenDisable of [false,true]) {const h = harness(); try {if(enableThenDisable) grant(h).disableWholeMarkerBatchCanary(); await runLive(h); assert.deepEqual(h.requests.map(row => row.family), ["semantic-batch-v1"]); assertTranslations(h); assert.equal(h.cacheWrites.length, 3); assert.equal(h.skipWrites.length, 0); assert.deepEqual(h.singles, []); assertResources(h); captures.push(h.requests[0].body);} finally {await close(h);}}
 assert.equal(captures[1], captures[0], "no W5 progress behavior changes typed request bytes");
});
