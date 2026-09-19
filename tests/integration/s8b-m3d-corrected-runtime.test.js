const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createHash} = require("node:crypto");
const legacyWireGolden = require("../fixtures/m1c-legacy-wire-golden.json");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown, targetBodyForeignTitle} = require("../fixtures/s8b-m0a-mixed-language-fixtures");
const {planReceivedMarkdown} = require("../../src/planner/received-markdown-lossless-planner");

const CURRENT = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const ENGINE = "custom-m3dcorrected";
const response = content => ({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(JSON.stringify({choices: [{message: {content}, finish_reason: "stop"}]}))});

function createFixture(pluginPath = CURRENT, {engine = ENGINE, fetch = null, bdfdb = {}} = {}) {
	const applied = [], commits = [], cacheWrites = [], skipWrites = [];
	const request = (url, options, callback) => {let cancelled = false; Promise.resolve(fetch && fetch(url, options)).then(async result => {if (cancelled) return; const body = result && typeof result.text === "function" ? await result.text() : ""; callback(null, {statusCode: result && result.status || 200, headers: {}}, body);}, error => {if (!cancelled) callback(error);}); return {abort: () => {cancelled = true;}};};
	const plugin = createPluginInstance({pluginPath, callSetLanguages: false, bdfdb: Object.assign({LibraryRequires: {request}}, bdfdb), settings: {engines: {translator: engine, backup: "----", customProviders: engine.startsWith("custom-") ? [{id: engine, name: "Fixture"}] : []}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}, exceptions: {wrapperPairs: ['"|"', '“|”', '`|`'], protectedTerms: []}}, defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}});
	if (fetch) global.BdApi.Net = {fetch}; try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = engine; plugin.settings.engines.backup = "----"; if (engine.startsWith("custom-")) plugin.settings.engines.customProviders = [{id: engine, name: "Fixture"}]; try {plugin.setLanguages();} catch {}
	if (engine === ENGINE || engine === "oaicompat") plugin.ensureSettingsStore().replaceAuthKeys({[engine]: {key: "fixture-key", endpoint: "https://m3d.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type]; plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false; plugin.shouldAutoTranslateReceivedMessage = () => true; plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null; plugin.isTranslationLikelyInTargetLanguage = value => /译|[㐀-鿿]/.test(String(value || "")); plugin.getTextSimilarityScore = (a, b) => String(a) === String(b) ? 1 : 0; plugin.getAutoTranslatedResultRejectReason = () => null; plugin.isTranslationResultTooSimilar = () => false; plugin.shouldKeepAutoTranslatedResult = () => true; plugin.persistReceivedSkipDecision = () => {}; plugin.persistTranslationCacheEntry = (id, _signature, translation) => cacheWrites.push({id: String(id), translation}); plugin.applyStoredTranslationToMessage = (_message, translation) => applied.push(translation); plugin.scheduleReceivedDisplayFlush = () => {}; plugin.commitReceivedDisplayResult = result => {commits.push(result); return Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [String(result.messageId)], deferredIds: []});}; plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve(); plugin.getHistoricalAiBatchEngineKey = () => engine;
	return {plugin, applied, commits, cacheWrites, skipWrites};
}

// P2 merged ranges carry ⟦...⟧ protocol tokens inside the segment text; a valid translation echoes them.
function translatedRows(plan, prefix = "译") {return plan.segments.map((segment, index) => ({id: segment.id, translation: `${prefix}${index}${(String(segment.text).match(/⟦(?:DTA)?\d+⟧|⟦C\d+⟧/g) || []).join("")}`}));}
function received(id, content = original14Markdown, embeds = []) {return {id: String(id), channel_id: "m3d-corrected", content, embeds, attachments: [], author: {id: "other-user"}};}

test("corrected M3d manual and auto use real typed wire then reassemble original CST into display/cache", async () => {
	const captures = [], fetch = async (_url, options) => {const outer = JSON.parse(options.body), user = String(outer.messages.at(-1).content), plan = JSON.parse(user); captures.push({outer, plan}); assert.equal(plan.schemaVersion, "segment-json-v2"); assert.equal(Object.prototype.hasOwnProperty.call(plan, "semanticRevision"), false, "client identities stay off the wire"); assert.equal(Object.prototype.hasOwnProperty.call(plan, "document"), false); assert.ok(plan.segments.length > 7); assert.equal(plan.segments.every(segment => /^s\d+$/.test(segment.id)), true, "segments travel under short labels"); assert.equal(plan.contexts.every(context => /^c\d+$/.test(context.id) && typeof context.type === "string" && !Object.prototype.hasOwnProperty.call(context, "text") && !Object.prototype.hasOwnProperty.call(context, "dataOnly")), true); return response(JSON.stringify({segments: translatedRows(plan)}));}; const fixture = createFixture(CURRENT, {fetch});
	try {for (const [id, options] of [["manual", {manual: true, silent: true, trackBusy: false}], ["auto", {auto: true, silent: true, trackBusy: false}]]) {const result = await fixture.plugin.translateMessage(received(id), {id: "m3d-corrected"}, options); assert.equal(result, true, JSON.stringify({id, captures: captures.length, ledger: fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.slice(-3)}));} assert.equal(captures.length, 2); for (const capture of captures) {const body = JSON.stringify(capture.outer); assert.equal(body.includes("Spouse/Dependent"), true); assert.equal(body.includes("Self-Pay"), true); assert.equal(body.includes("```text"), false); assert.equal(body.includes("“4-3”"), false);} assert.equal(fixture.applied.length, 1); assert.equal(fixture.commits.length, 1); for (const stored of fixture.applied.concat(fixture.commits.map(item => item.translation))) {assert.equal(stored.translatedContent.includes("```text"), true); assert.equal(stored.translatedContent.includes("“4-3”"), true); assert.equal(stored.semanticRevision, "s8b-p2-v1"); assert.match(stored.semanticWorkloadKey, /^swk1:/);} }
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("corrected M3d real single response repairs only an invalid segment after parent settle", async () => {
	const segmentOrders = [], events = []; let call = 0, fetch = async (_url, options) => {call++; const outer = JSON.parse(options.body), plan = JSON.parse(outer.messages.at(-1).content), rows = translatedRows(plan); segmentOrders.push(plan.segments.map(item => item.id)); events.push(`request${call}`); if (call === 1) rows.splice(0, 1); return response(JSON.stringify({segments: rows}));}; const fixture = createFixture(CURRENT, {fetch});
	try {const result = await fixture.plugin.translateMessage(received("repair", "Hello world. Financial Aid requirements."), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}); assert.equal(result, true, JSON.stringify({call, segmentOrders, ledger: fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.slice(-3)})); assert.equal(call, 2); assert.equal(segmentOrders[1].length, 1); assert.equal(segmentOrders[0].includes(segmentOrders[1][0]), true); assert.equal(segmentOrders[0].filter(id => !segmentOrders[1].includes(id)).length, segmentOrders[0].length - 1); assert.deepEqual(events, ["request1", "request2"]);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

// P3: wrong-language and too-similar are soft failures. Short or capitalised segments are kept as
// source text without a repair, so this repair test uses long lowercase sentences for those modes;
// the duplicate mode stays hard and keeps its short source.
test("corrected M3d real validator repairs duplicate ID, wrong-language and similarity without replaying valid siblings", async () => {
	for (const mode of ["duplicate", "wrong-language", "similarity"]) {let call = 0; const orders = [], fetch = async (_url, options) => {call++; const plan = JSON.parse(JSON.parse(options.body).messages.at(-1).content), rows = translatedRows(plan); orders.push(plan.segments.map(item => item.id)); if (call === 1 && mode === "duplicate") rows.push({id: rows[0].id, translation: "重复"}); if (call === 1 && mode === "wrong-language") rows[0].translation = "English"; return response(JSON.stringify({segments: rows}));}, fixture = createFixture(CURRENT, {fetch}); if (mode === "similarity") fixture.plugin.getTextSimilarityScore = () => call === 1 ? 1 : 0; try {const result = await fixture.plugin.translateMessage(received(`invalid-${mode}`, mode === "duplicate" ? "Hello你好World" : "please review the updated schedule before the meeting你好and confirm your attendance by friday afternoon"), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}); assert.equal(result, true, mode); assert.equal(call, 2, mode); assert.ok(mode === "similarity" ? orders[1].length <= orders[0].length : orders[1].length < orders[0].length, mode); assert.equal(orders[1].every(id => orders[0].includes(id)), true, mode);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}}
});

// P2: a placeholder-shaped span inside a sentence travels as a bare protocol token inside the
// merged range (M3d omitted it from the wire and sent the two fragments around it), and the
// reassembled text still carries the original span exactly once.
test("corrected M3d protected placeholder travels as a protocol token inside the merged range and is replayed from the original span", async () => {const captures = [], fetch = async (_url, options) => {const plan = JSON.parse(JSON.parse(options.body).messages.at(-1).content); captures.push(plan); return response(JSON.stringify({segments: translatedRows(plan)}));}, fixture = createFixture(CURRENT, {fetch}); try {assert.equal(await fixture.plugin.translateMessage(received("placeholder", "Hello ⟦0⟧ world"), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}), true); assert.equal(captures.length, 1); assert.equal(captures[0].segments.length, 1); assert.match(captures[0].segments[0].text, /^Hello ⟦\d+⟧ world$/, "the source lookalike is masked by P1 and its placeholder rides inside the one merged range"); assert.equal(fixture.applied[0].translatedContent.split("⟦0⟧").length - 1, 1); assert.equal(fixture.applied[0].translatedContent.includes("译0"), true);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

test("corrected M3d Embed and forward-aware received bodies traverse the same real semantic wire", async () => {const sourceTexts = [], fetch = async (_url, options) => {const plan = JSON.parse(JSON.parse(options.body).messages.at(-1).content); sourceTexts.push(plan.segments.map(item => item.text).join("")); return response(JSON.stringify({segments: translatedRows(plan)}));}, fixture = createFixture(CURRENT, {fetch}), embedData = {content: "Financial Aid body", embeds: [{title: "Application Title", description: "Application Description", fields: [{name: "Requirement", value: "Dependent status"}], footerText: "Deadline"}]}, embedMessage = received("embed", embedData.content, [{id: "embed-1", title: "Application Title", description: "Application Description", fields: [{name: "Requirement", value: "Dependent status"}], footer: {text: "Deadline"}}]), forwardData = {content: "Forwarded Financial Aid requirements", embeds: []}; try {assert.equal(await fixture.plugin.translateMessage(embedMessage, {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false, originalContentData: embedData}), true); assert.equal(await fixture.plugin.translateMessage(received("forward", forwardData.content), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false, originalContentData: forwardData}), true); assert.equal(sourceTexts.some(text => text.includes("Application Title") && text.includes("Dependent status")), true); assert.equal(sourceTexts.some(text => text.includes("Forwarded Financial Aid")), true); assert.ok(Object.keys(fixture.applied[0].embeds).length > 0);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

test("corrected M3d historical primary and batch repair use semantic batch wire and one atomic commit", async () => {
	const calls = [], views = new Map(); let call = 0;
	const fetch = async (_url, options) => {call++; const outer = JSON.parse(options.body), payload = JSON.parse(outer.messages.at(-1).content); assert.equal(payload.schemaVersion, "semantic-batch-v1"); const answer = {messages: payload.messages.map(message => ({id: message.id, segments: translatedRows(message.plan)}))}; if (call === 1) for (const message of answer.messages) message.segments.splice(0, 1); calls.push(payload.messages.map(message => ({id: message.id, segmentIds: message.plan.segments.map(segment => segment.id), texts: message.plan.segments.map(segment => segment.text)}))); return response(JSON.stringify(answer));}; const fixture = createFixture(CURRENT, {fetch});
	fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null; fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});}; fixture.plugin.setHistoricalBatchExperimentConcurrency(4);
	try {for (const id of ["h1", "h2"]) {const message = received(id, `Financial Aid requirements for ${id}.`); fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});} await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); const diagnostic = () => JSON.stringify({calls, commits: fixture.commits, cacheWrites: fixture.cacheWrites, views: [...views]}); assert.equal(call, 3, diagnostic()); assert.equal(calls[0].length, 2, diagnostic()); assert.equal(calls.slice(1).every(batch => batch.length === 1 && batch[0].segmentIds.length === 1), true, diagnostic()); assert.equal(new Set(calls.slice(1).flatMap(batch => batch.flatMap(item => item.texts))).size, 2, diagnostic()); assert.equal(fixture.commits.length, 1, diagnostic()); assert.equal(fixture.cacheWrites.length, 2, diagnostic()); assert.equal([...views.values()].every(view => view.translated), true, diagnostic()); const resources = fixture.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(resources.providerBudget.resources.active, 0); assert.equal(resources.physical.active, 0); assert.equal(resources.historicalAbortControllerCount, 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("corrected M3d exact historical received message reaches item repair and one atomic commit", async () => {const calls = [], views = new Map(); let call = 0, fetch = async (_url, options) => {call++; const outer = JSON.parse(options.body), payload = JSON.parse(outer.messages.at(-1).content); if (payload.schemaVersion === "semantic-batch-v1") {const answer = {messages: payload.messages.map(message => ({id: message.id, segments: translatedRows(message.plan)}))}; if (call === 1) answer.messages[0].segments.splice(0, 1); calls.push({schema: payload.schemaVersion, count: payload.messages[0].plan.segments.length}); return response(JSON.stringify(answer));} calls.push({schema: payload.schemaVersion, count: payload.segments.length}); return response(JSON.stringify({segments: translatedRows(payload)}));}, fixture = createFixture(CURRENT, {fetch}), message = received("exact-history", original14Markdown); fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null; fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated"})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});}; try {fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}); await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); assert.equal(call, 2, JSON.stringify(calls)); assert.equal(calls[0].schema, "semantic-batch-v1"); assert.equal(calls[1].schema, "segment-json-v2"); assert.equal(calls[1].count, 1); assert.equal(fixture.commits.length, 1); assert.equal(fixture.cacheWrites.length, 1); assert.equal(views.get("exact-history").translated, true);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

test("M3f one-message historical batch accepts the provider single-plan typed root without legacy fallback", async () => {
	const views = new Map(); let calls = 0;
	const fetch = async (_url, options) => {calls++; const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content); assert.equal(payload.schemaVersion, "semantic-batch-v1"); assert.equal(payload.messages.length, 1); return response(JSON.stringify({segments: translatedRows(payload.messages[0].plan)}));};
	const fixture = createFixture(CURRENT, {fetch}), message = received("single-root-history", original14Markdown);
	fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null;
	fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated"})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	try {fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}); await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); assert.equal(calls, 1); assert.equal(fixture.commits.length, 1); assert.equal(views.get("single-root-history").translated, true); const route = fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1); assert.equal(route.providerDispatchCount, 1); assert.equal(route.requestFamily, "batch-json");}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3f exact history route owns eligibility through confirmed atomic display with anonymous identity", async () => {
	const views = new Map();
	const fetch = async (_url, options) => {const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content); return response(JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: translatedRows(message.plan)}))}));};
	const fixture = createFixture(CURRENT, {fetch}), message = received("field-exact-history", original14Markdown), source = {content: message.content, embeds: []};
	fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null;
	fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated"})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	try {const observed = fixture.plugin.observeHistoricalAutoEligibility(message, {id: "m3d-corrected"}, source, {origin: "history-render", ignoreQueued: true}); assert.equal(observed.eligible, true); assert.equal(fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, source, {historicalLoad: true, deferHistoricalSnapshotStart: true, terminalRouteId: observed.routeId}), true); await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); const route = fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.find(item => item.messageIdentity === observed.messageIdentity); assert.ok(route); assert.equal(route.sourceIdentity, observed.sourceIdentity); assert.deepEqual(route.historyPath, ["eligibility:plan_translate", "collector:accepted", "seal:sealed", "primary:dispatch", "primary:settled", "atomic-commit:committed", "display-currentness:confirmed"]); assert.equal(route.outcome, "translated"); assert.equal(route.providerDispatchCount, 1); assert.equal(route.displayCommit, "atomic"); assert.deepEqual(fixture.plugin.getHistoryAutoTerminalResources(), {active: 0, indexedRoutes: 0, filteredDedup: 0});}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3f manual auto and history use one body Plan for target-language prose with a foreign title", async () => {
	const orders = [], views = new Map();
	const fetch = async (_url, options) => {const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content); if (payload.schemaVersion === "semantic-batch-v1") {orders.push(payload.messages[0].plan.segments.map(segment => segment.id)); return response(JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: translatedRows(message.plan)}))}));} orders.push(payload.segments.map(segment => segment.id)); return response(JSON.stringify({segments: translatedRows(payload)}));};
	const fixture = createFixture(CURRENT, {fetch}); fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null; fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated"})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	try {for (const [id, options] of [["plan-manual", {manual: true, silent: true, trackBusy: false}], ["plan-auto", {auto: true, silent: true, trackBusy: false}]]) assert.equal(await fixture.plugin.translateMessage(received(id, targetBodyForeignTitle), {id: "m3d-corrected"}, options), true); const message = received("plan-history", targetBodyForeignTitle), source = {content: message.content, embeds: []}, observed = fixture.plugin.observeHistoricalAutoEligibility(message, {id: "m3d-corrected"}, source, {origin: "history-render", ignoreQueued: true}); assert.equal(observed.reason, "plan_translate"); assert.equal(fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, source, {historicalLoad: true, deferHistoricalSnapshotStart: true, terminalRouteId: observed.routeId}), true); await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); assert.equal(orders.length, 3); assert.deepEqual(orders[1], orders[0]); assert.deepEqual(orders[2], orders[0]); assert.ok(orders[0].length > 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("corrected M3d live burst reaches the same real semantic batch provider wire", async () => {const schemas = [], fetch = async (_url, options) => {const outer = JSON.parse(options.body), payload = JSON.parse(outer.messages.at(-1).content); schemas.push(payload.schemaVersion); if (payload.schemaVersion === "semantic-batch-v1") return response(JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: translatedRows(message.plan)}))})); return response(JSON.stringify({segments: translatedRows(payload)}));}, fixture = createFixture(CURRENT, {fetch}), channel = {id: "m3d-live"}; fixture.plugin.settings.filters.receivedAutoTranslateScope = "new_only"; try {for (let index = 0; index < 5; index++) {const message = received(`live-${index}`, `Financial Aid live message ${index}.`), source = {content: message.content, embeds: []}; fixture.plugin.captureReceivedMessageSource({messageId: message.id, channelId: channel.id, generation: fixture.plugin.getReceivedDisplayCommitGeneration(channel.id), sourceSignature: fixture.plugin.createReceivedTranslationSignature(message, channel.id, source), source}); fixture.plugin.queueAutoTranslateMessage(message, channel, source);} const deadline = Date.now() + 3000; while (Date.now() < deadline && fixture.commits.length < 5) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(fixture.commits.length, 5); assert.equal(schemas.includes("semantic-batch-v1"), true, JSON.stringify(schemas)); assert.equal(schemas.every(schema => schema === "semantic-batch-v1" || schema === "segment-json-v2"), true);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

test("corrected M3d semantic 429 opens the captured-key window without repair storm", async () => {let fetches = 0; const fetch = async () => {fetches++; return {status: 429, headers: {get: name => String(name).toLowerCase() === "retry-after" ? "2" : "application/json"}, text: () => Promise.resolve("{}")};}, fixture = createFixture(CURRENT, {fetch}); try {for (const id of ["r1", "r2"]) {const message = received(id, `Financial Aid ${id}.`); fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});} await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); const snapshot = fixture.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(fetches, 1); assert.equal(snapshot.providerBudget.rateLimitCount, 1); assert.equal(snapshot.latestRun.repairBatchRequests, 0); assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

test("corrected M3d semantic timeout physically aborts before bounded block split", async () => {const timers = [], calls = []; let firstSignal = null; const timeUtils = {timeout(callback, delay) {const timer = {callback, delay, cleared: false}; timers.push(timer); return timer;}, clear(timer) {if (timer) timer.cleared = true;}, interval: (callback, delay) => setInterval(callback, delay)}, fetch = (_url, options) => {const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content), ids = payload.messages.map(message => message.id); calls.push({ids, parentAborted: firstSignal ? firstSignal.aborted : null}); if (!firstSignal) {firstSignal = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")), {once: true}));} return Promise.resolve(response(JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: translatedRows(message.plan)}))})));}, fixture = createFixture(CURRENT, {fetch, bdfdb: {TimeUtils: timeUtils}}); try {for (const id of ["t1", "t2", "t3", "t4"]) {const message = received(id, `Financial Aid timeout ${id}.`); fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});} const running = fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); while (!firstSignal) await new Promise(resolve => setImmediate(resolve)); const timer = timers.find(value => value.delay === 30000 && !value.cleared); assert.ok(timer); timer.callback(); await running; assert.equal(firstSignal.aborted, true); assert.deepEqual(calls.map(call => call.ids.length), [4, 2, 2]); assert.equal(calls.slice(1).every(call => call.parentAborted === true), true); const snapshot = fixture.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(snapshot.latestRun.translatedCount, 4); assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0}); assert.equal(fixture.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

test("corrected M3d semantic channel cancellation aborts physical work and late body writes zero", async () => {let signal = null, release; const fetch = (_url, options) => {signal = options.signal; return new Promise(resolve => {release = () => resolve(response(JSON.stringify({messages: []})));});}, fixture = createFixture(CURRENT, {fetch}), message = received("cancel", "Financial Aid cancellation message."); try {fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}); const running = fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); while (!signal) await new Promise(resolve => setImmediate(resolve)); fixture.plugin.clearAutoTranslationQueue("m3d-corrected"); assert.equal(signal.aborted, true); release(); await running; assert.equal(fixture.commits.length, 0); assert.equal(fixture.cacheWrites.length, 0); const snapshot = fixture.plugin.getHistoricalBatchPerformanceSnapshot(); assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0}); assert.equal(snapshot.physical.active, 0); assert.equal(snapshot.historicalAbortControllerCount, 0);} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}});

async function captureBudgetFallback(pluginPath) {const bodies = [], source = `Header\n${"Hello浣犲ソ".repeat(4000)}`, fetch = async (_url, options) => {bodies.push(String(options.body)); return response("璇戞枃");}, fixture = createFixture(pluginPath, {fetch}); try {await fixture.plugin.translateMessage(received("budget", source), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}); return bodies;} finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}}

// Frozen original M1c transport bytes, not an oracle recomputed from the current runtime.
// Keep the raw body intact: parsing/re-serializing JSON would hide wire-format regressions.
function assertLegacyWireBody(body, expected) {
	assert.equal(typeof body, "string");
	// The message carries the actual digest so a deliberate re-freeze can copy it from the failure.
	assert.equal(Buffer.byteLength(body, "utf8"), expected.bodyUtf8Bytes, `legacy request UTF-8 byte length (actual sha256 ${createHash("sha256").update(body, "utf8").digest("hex")})`);
	assert.equal(createHash("sha256").update(body, "utf8").digest("hex"), expected.bodySha256, "legacy request bytes match the frozen M1c oracle");
}

test("corrected M3d serializer budget failure falls back to the complete M1c legacy body byte-for-byte", async () => {
	const corrected = await captureBudgetFallback(CURRENT);
	assert.equal(corrected.length, 1, "budget fallback dispatches one complete legacy request");
	assertLegacyWireBody(corrected[0], legacyWireGolden.requests.serializerBudgetFallback);
	assert.equal(corrected[0].includes("segment-json-v1"), false);
});

test("corrected M3d planner preserves high-confidence technical tokens without blanket-protecting admissions prose", () => {const source = "Windows 11 returned HTTP 429 from the API. Spouse/Dependent GED Non-Degree In-state Out-of-state Self-Pay. URL https://fixture.test and `code` ID.", plan = planReceivedMarkdown(source, {targetLanguageId: "zh-CN"}), protectedText = plan.nodes.filter(node => node.classification === "protected").map(node => node.raw).join("|"), translatedText = plan.nodes.filter(node => node.classification === "translate").map(node => node.raw).join("|"); for (const token of ["Windows 11", "HTTP 429", "API", "https://fixture.test", "`code`", "ID"]) assert.equal(protectedText.includes(token), true, token); for (const token of ["Spouse/Dependent", "GED", "Non-Degree", "In-state", "Out-of-state", "Self-Pay"]) assert.equal(translatedText.includes(token), true, token);});

async function captureManualCompatibility(pluginPath, malformedTyped) {
	const bodies = [];
	const fetch = async (_url, options) => {
		bodies.push(String(options.body));
		const prompt = String(JSON.parse(options.body).messages.at(-1).content);
		if (malformedTyped && /"schemaVersion":"segment-json-v\d+"/.test(prompt)) return response("legacy whole text");
		const placeholders = [...new Set(prompt.match(/\u27e6(?:DTA)?\d+\u27e7/g) || [])];
		return response(`鍏煎璇戞枃 ${placeholders.join(" ")}`);
	};
	const fixture = createFixture(pluginPath, {fetch});
	try {
		const result = await fixture.plugin.translateMessage(received(`compat-${malformedTyped ? "current" : "baseline"}`), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false});
		return {result, bodies, applied: fixture.applied.slice(), cacheWrites: fixture.cacheWrites.slice(), ledger: fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1)};
	}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
}

test("M3e root malformed uses exactly one byte-identical legacy request for display without cache pollution", async () => {
	const current = await captureManualCompatibility(CURRENT, true);
	assert.equal(current.result, true, JSON.stringify(current));
	assert.equal(current.bodies.length, 2);
	assertLegacyWireBody(current.bodies[1], legacyWireGolden.requests.manualCompatibilityFallback);
	assert.equal(current.applied.length, 1);
	assert.equal(current.cacheWrites.length, 0);
	assert.equal(current.applied[0].semanticRevision, undefined);
	assert.equal(current.ledger.providerDispatchCount, 2);
	assert.deepEqual(current.ledger.providerRoles, {primary: 1, fallback: 1});
	assert.equal(current.ledger.requestFamily, "legacy-single-fallback");
	assert.equal(current.ledger.cacheWrite, "none");
	assert.equal(current.ledger.outcome, "translated");
	assert.equal(current.ledger.semanticRevision, "s8b-p2-v1");
});

test("M3e root malformed fallback is bounded to two requests when legacy response also fails", async () => {
	let calls = 0;
	const fetch = async () => {calls++; return response(calls === 1 ? "legacy whole text" : "English fallback echo");};
	const fixture = createFixture(CURRENT, {fetch});
	try {
		assert.equal(await fixture.plugin.translateMessage(received("compat-fail"), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}), false);
		assert.equal(calls, 2);
		assert.equal(fixture.applied.length, 0);
		assert.equal(fixture.cacheWrites.length, 0);
		const terminal = fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.at(-1);
		assert.equal(terminal.reason, "legacy_fallback_failed");
		assert.equal(terminal.stage, "repair");
	}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e a valid empty root response repairs every failed batch without replaying successes", async () => {
	const orders = [];
	const source = Array.from({length: 25}, (_, index) => `English sentence number ${index}.`).join("\n");
	let call = 0;
	const fetch = async (_url, options) => {call++; const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content); orders.push(payload.segments.map(segment => segment.text)); return response(JSON.stringify({segments: call === 1 ? [] : translatedRows(payload)}));};
	const fixture = createFixture(CURRENT, {fetch});
	try {
		assert.equal(await fixture.plugin.translateMessage(received("repair-all", source), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}), true, JSON.stringify({call, orders}));
		assert.equal(orders[0].length, 25);
		assert.deepEqual(orders.slice(1).map(order => order.length), [10, 10, 5]);
		assert.equal(new Set(orders.slice(1).flat()).size, 25);
		assert.equal(fixture.applied.length, 1);
	}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e semantic segment validation is final and bypasses the legacy whole-message similarity guard", async () => {
	const fetch = async (_url, options) => {const plan = JSON.parse(JSON.parse(options.body).messages.at(-1).content); return response(JSON.stringify({segments: translatedRows(plan)}));};
	const fixture = createFixture(CURRENT, {fetch});
	fixture.plugin.getAutoTranslatedResultRejectReason = () => "too_similar";
	fixture.plugin.isTranslationResultTooSimilar = () => true;
	try {
		assert.equal(await fixture.plugin.translateMessage(received("semantic-final"), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}), true);
		assert.equal(fixture.applied.length, 1);
		assert.equal(fixture.cacheWrites.length, 1);
	}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e zero usable ids is a root schema incompatibility and falls back once", async () => {
	const families = [];
	const fetch = async (_url, options) => {const prompt = String(JSON.parse(options.body).messages.at(-1).content), typed = /"schemaVersion":"segment-json-v\d+"/.test(prompt); families.push(typed ? "typed" : "legacy"); if (typed) return response(JSON.stringify({translations: [{text: "whole translation"}]})); const placeholders = [...new Set(prompt.match(/\u27e6(?:DTA)?\d+\u27e7/g) || [])]; return response(`\u517c\u5bb9\u8bd1\u6587 ${placeholders.join(" ")}`);};
	const fixture = createFixture(CURRENT, {fetch});
	try {assert.equal(await fixture.plugin.translateMessage(received("zero-id"), {id: "m3d-corrected"}, {manual: true, silent: true, trackBusy: false}), true); assert.deepEqual(families, ["typed", "legacy"]); assert.equal(fixture.cacheWrites.length, 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e auto root fallback skip is terminal and cannot reopen the legacy safety-net retry", async () => {
	let calls = 0;
	const fetch = async () => {calls++; return response(calls === 1 ? "legacy whole text" : "__SKIP_TRANSLATION__");};
	const fixture = createFixture(CURRENT, {fetch});
	try {await fixture.plugin.translateMessage(received("auto-fallback-skip"), {id: "m3d-corrected"}, {auto: true, silent: true, trackBusy: false}); assert.equal(calls, 2); assert.equal(fixture.cacheWrites.length, 0); assert.equal(fixture.skipWrites.length, 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

function parseLegacyBatchItems(prompt) {
	const marker = "Messages JSON:\n", index = String(prompt).lastIndexOf(marker);
	return index < 0 ? null : JSON.parse(String(prompt).slice(index + marker.length));
}

test("M3e historical root malformed performs one intact legacy batch fallback and writes no semantic cache", async () => {
	const families = [], views = new Map();
	const fetch = async (_url, options) => {const prompt = String(JSON.parse(options.body).messages.at(-1).content); let payload = null; try {payload = JSON.parse(prompt);} catch {} if (payload && payload.schemaVersion === "semantic-batch-v1") {families.push("semantic-batch"); return response("legacy whole batch");} families.push("legacy-batch"); const items = parseLegacyBatchItems(prompt); return response(JSON.stringify(items.map(item => {const placeholders = [...new Set(String(item.text).match(/\u27e6(?:DTA)?\d+\u27e7/g) || [])]; return {id: item.id, translation: `\u8bd1\u6587 ${placeholders.join(" ")}`};})));};
	const fixture = createFixture(CURRENT, {fetch});
	fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null; fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated"})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	try {for (const id of ["compat-h1", "compat-h2", "compat-h3", "compat-h4"]) {const message = received(id, `Financial Aid requirements for ${id}.`); fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});} const summary = await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); assert.deepEqual(families, ["semantic-batch", "legacy-batch"]); assert.equal(summary.translated.length, 4); assert.equal(summary.failed.length, 0); assert.equal(fixture.commits.length, 1); assert.equal(fixture.cacheWrites.length, 0); assert.equal([...views.values()].every(view => view.translated), true);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e historical root malformed is terminal after one failed legacy batch and never fans out", async () => {
	let calls = 0;
	const fixture = createFixture(CURRENT, {fetch: async () => {calls++; return response("legacy whole batch");}});
	try {for (const id of ["compat-f1", "compat-f2", "compat-f3", "compat-f4"]) {const message = received(id, `Financial Aid requirements for ${id}.`); fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});} const summary = await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); assert.equal(calls, 2); assert.equal(summary.translated.length, 0); assert.equal(summary.failed.length, 4); assert.equal(fixture.cacheWrites.length, 0); assert.equal(fixture.skipWrites.length, 0); const routes = fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => route.entry === "historical-load").slice(-4); assert.equal(routes.length, 4); assert.equal(routes.every(route => route.providerDispatchCount === 2 && route.providerRoles.primary === 1 && route.providerRoles.fallback === 1 && route.requestFamily === "legacy-batch-fallback" && route.semanticRevision === "s8b-p2-v1" && route.outcome === "failed"), true, JSON.stringify(routes)); const resources = fixture.plugin.getHistoricalBatchPerformanceSnapshot(); assert.equal(resources.physical.active, 0); assert.equal(resources.providerBudget.resources.active, 0); assert.equal(resources.historicalAbortControllerCount, 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e historical semantic repair keeps more than ten failed segments in one bounded request", async () => {
	const sizes = [], views = new Map(), source = Array.from({length: 25}, (_, index) => `English sentence number ${index}.`).join("\n"); let call = 0;
	const fetch = async (_url, options) => {call++; const payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content); assert.equal(payload.schemaVersion, "semantic-batch-v1"); sizes.push(payload.messages.map(message => message.plan.segments.length)); return response(JSON.stringify({messages: payload.messages.map(message => ({id: message.id, segments: call === 1 ? [] : translatedRows(message.plan)}))}));};
	const fixture = createFixture(CURRENT, {fetch}); fixture.plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null; fixture.plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated"})); fixture.commits.push(results); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	try {for (const id of ["many-h1", "many-h2"]) {const message = received(id, source); fixture.plugin.queueAutoTranslateMessage(message, {id: "m3d-corrected"}, {content: message.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});} const summary = await fixture.plugin.startCollectedHistoricalTranslationJobs("m3d-corrected"); assert.equal(call, 3, JSON.stringify(sizes)); assert.deepEqual(sizes, [[25, 25], [25], [25]]); assert.equal(summary.translated.length, 2); assert.equal(summary.failed.length, 0); assert.equal(fixture.commits.length, 1);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e live root malformed uses one legacy fallback per physical block instead of per-item fanout", async () => {
	const families = [];
	const fetch = async (_url, options) => {const prompt = String(JSON.parse(options.body).messages.at(-1).content); let payload = null; try {payload = JSON.parse(prompt);} catch {} if (payload && payload.schemaVersion === "segment-json-v2") {families.push("segment-json-v2"); return response("legacy whole text");} if (payload && payload.schemaVersion === "semantic-batch-v1") {families.push("semantic-batch-v1"); return response("legacy whole batch");} const items = parseLegacyBatchItems(prompt); if (items) {families.push("legacy-batch"); return response(JSON.stringify(items.map(item => ({id: item.id, translation: "\u8bd1\u6587"}))));} families.push("legacy-single"); const placeholders = [...new Set(prompt.match(/\u27e6(?:DTA)?\d+\u27e7/g) || [])]; return response(`\u8bd1\u6587 ${placeholders.join(" ")}`);};
	const fixture = createFixture(CURRENT, {fetch}); fixture.plugin.settings.filters.receivedAutoTranslateScope = "new_only";
	try {const channel = {id: "m3d-live"}; for (let index = 0; index < 5; index++) {const message = received(`compat-live-${index}`, `Financial Aid live message ${index}.`), source = {content: message.content, embeds: []}; fixture.plugin.captureReceivedMessageSource({messageId: message.id, channelId: channel.id, generation: fixture.plugin.getReceivedDisplayCommitGeneration(channel.id), sourceSignature: fixture.plugin.createReceivedTranslationSignature(message, channel.id, source), source}); fixture.plugin.queueAutoTranslateMessage(message, channel, source);} const queue = fixture.plugin.ensureLiveTranslationQueue(), deadline = Date.now() + 3000; while (Date.now() < deadline && (fixture.commits.length < 5 || !queue.isQueueEmpty() || queue.isLiveAutoTranslating())) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(fixture.commits.length, 5, JSON.stringify({families, commits: fixture.commits.length})); assert.deepEqual(families, ["segment-json-v2", "legacy-single", "semantic-batch-v1", "legacy-batch"]); assert.equal(fixture.cacheWrites.length, 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e live legacy fallback skip commits once per item without persisting skip cache", async () => {
	const families = [];
	const fetch = async (_url, options) => {const prompt = String(JSON.parse(options.body).messages.at(-1).content); let payload = null; try {payload = JSON.parse(prompt);} catch {} if (payload && payload.schemaVersion === "segment-json-v2") {families.push("segment-json-v2"); return response("legacy whole text");} if (payload && payload.schemaVersion === "semantic-batch-v1") {families.push("semantic-batch-v1"); return response("legacy whole batch");} const items = parseLegacyBatchItems(prompt); if (items) {families.push("legacy-batch"); return response(JSON.stringify(items.map(item => ({id: item.id, translation: "__SKIP_TRANSLATION__"}))));} families.push("legacy-single"); return response("__SKIP_TRANSLATION__");};
	const fixture = createFixture(CURRENT, {fetch}); fixture.plugin.settings.filters.receivedAutoTranslateScope = "new_only";
	try {const channel = {id: "m3d-live"}; for (let index = 0; index < 5; index++) {const message = received(`compat-live-skip-${index}`, `Financial Aid live message ${index}.`), source = {content: message.content, embeds: []}; fixture.plugin.captureReceivedMessageSource({messageId: message.id, channelId: channel.id, generation: fixture.plugin.getReceivedDisplayCommitGeneration(channel.id), sourceSignature: fixture.plugin.createReceivedTranslationSignature(message, channel.id, source), source}); fixture.plugin.queueAutoTranslateMessage(message, channel, source);} const queue = fixture.plugin.ensureLiveTranslationQueue(), deadline = Date.now() + 3000; while (Date.now() < deadline && (fixture.commits.length < 5 || !queue.isQueueEmpty() || queue.isLiveAutoTranslating())) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(fixture.commits.length, 5, JSON.stringify({families, commits: fixture.commits.length})); assert.deepEqual(families, ["segment-json-v2", "legacy-single", "semantic-batch-v1", "legacy-batch"]); assert.equal(fixture.commits.every(commit => commit.status === "skipped"), true); assert.equal(fixture.skipWrites.length, 0); assert.equal(fixture.cacheWrites.length, 0);}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});

test("M3e live failed block fallback is terminal and never requeues per item", async () => {
	const families = [];
	const fetch = async (_url, options) => {const prompt = String(JSON.parse(options.body).messages.at(-1).content); let payload = null; try {payload = JSON.parse(prompt);} catch {} if (payload && payload.schemaVersion === "segment-json-v2") families.push("segment-json-v2"); else if (payload && payload.schemaVersion === "semantic-batch-v1") families.push("semantic-batch-v1"); else if (parseLegacyBatchItems(prompt)) families.push("legacy-batch"); else families.push("legacy-single"); return response("wrong target response");};
	const fixture = createFixture(CURRENT, {fetch}); fixture.plugin.settings.filters.receivedAutoTranslateScope = "new_only";
	try {const channel = {id: "m3d-live"}; for (let index = 0; index < 5; index++) {const message = received(`compat-live-fail-${index}`, `Financial Aid live message ${index}.`), source = {content: message.content, embeds: []}; fixture.plugin.captureReceivedMessageSource({messageId: message.id, channelId: channel.id, generation: fixture.plugin.getReceivedDisplayCommitGeneration(channel.id), sourceSignature: fixture.plugin.createReceivedTranslationSignature(message, channel.id, source), source}); fixture.plugin.queueAutoTranslateMessage(message, channel, source);} const queue = fixture.plugin.ensureLiveTranslationQueue(), deadline = Date.now() + 3000; while (Date.now() < deadline && (!queue.isQueueEmpty() || queue.isLiveAutoTranslating())) await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(families, ["segment-json-v2", "legacy-single", "semantic-batch-v1", "legacy-batch"]); assert.equal(queue.getQueueLength(), 0); assert.equal(queue.getLiveSlotActiveCount(), 0); assert.equal(fixture.cacheWrites.length, 0); assert.equal(fixture.skipWrites.length, 0); const routes = fixture.plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => route.entry === "received-auto").slice(-5); assert.equal(routes.length, 5); assert.equal(routes.every(route => route.providerDispatchCount === 2 && route.providerRoles.fallback === 1 && route.outcome === "failed" && route.reason === "legacy_fallback_failed"), true, JSON.stringify(routes));}
	finally {delete global.BdApi.Net; try {await fixture.plugin.onStop();} catch {}}
});
