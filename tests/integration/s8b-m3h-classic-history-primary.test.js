const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

const CHANNEL = "1000000000000000001";
const CUSTOM = "custom-m3h-global";
const clone = value => JSON.parse(JSON.stringify(value));
const received = id => ({id: String(id), channel_id: CHANNEL, content: original14Markdown, embeds: [], attachments: [], author: {id: "other-user"}});
function translatedWire(data) {const markers=[...String(data.text||"").matchAll(/⟦(\d+)⟧/g)]; if(data.semanticRequest&&data.semanticRequest.adapter==="classic-marked"&&markers.length>=2){let output="";for(let index=0;index<markers.length-1;index++)output+=`${markers[index][0]}译文${index}`;return output+markers.at(-1)[0];}const placeholders=[...new Set(String(data.text||"").match(/⟦(?:DTA)?\d+⟧/g)||[])];return `译文 ${placeholders.join(" ")}`;}

function fixture(responder) {
	const persisted = {channelPrimaryEngineOverrides: {[CHANNEL]: "googleapi"}};
	const plugin = createPluginInstance({pluginPath: process.env.DTA_PLUGIN_PATH || undefined, callSetLanguages: false, settings: {
		engines: {translator: CUSTOM, backup: "----", customProviders: [{id: CUSTOM, name: "Global fixture"}]},
		performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1"},
		filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1},
		choices: {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}},
		defaults: {choices: {received: {value: {input: "auto", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	}, bdfdb: {DataUtils: {load: (_plugin, key) => persisted[key] == null ? {} : clone(persisted[key]), save: (value, _plugin, key) => {persisted[key] = clone(value);}}}});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = CUSTOM; plugin.settings.engines.customProviders = [{id: CUSTOM, name: "Global fixture"}];
	try {plugin.setLanguages(); plugin.ensureSettingsStore().reload();} catch {}
	const views = new Map(), commits = [], cacheWrites = [], calls = [];
	plugin.isTranslationEnabled = () => true; plugin.isOwnMessage = () => false; plugin.isMessageWithinLoadedRange = () => true;
	plugin.isTranslationLikelyInTargetLanguage = value => String(value || "").trim().startsWith("译文");
	plugin.getAutoTranslatedResultRejectReason = () => null; plugin.isTranslationResultTooSimilar = () => false; plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null;
	plugin.persistTranslationCacheEntry = (id, _signature, translation) => cacheWrites.push({id: String(id), translation});
	plugin.commitHistoricalReceivedDisplayBatch = results => {commits.push(results); for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false})); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	plugin.googleApiTranslate = (data, callback) => {calls.push({text: String(data.text || ""), engine: data.engine && data.engine.name || null}); responder({data, callback, call: calls.length});};
	return {plugin, persisted, views, commits, cacheWrites, calls};
}

function enqueue(plugin, message) {
	const source = {content: message.content, embeds: []}, observed = plugin.observeHistoricalAutoEligibility(message, {id: CHANNEL}, source, {origin: "history-render", ignoreQueued: true});
	assert.equal(observed.eligible, true); assert.equal(observed.reason, "plan_translate");
	assert.equal(plugin.queueAutoTranslateMessage(message, {id: CHANNEL}, source, {historicalLoad: true, deferHistoricalSnapshotStart: true, terminalRouteId: observed.routeId}), true);
	return observed;
}

test("M3h channel googleapi override dispatches classic primary items and successful rows never enter repair", async () => {
	const f = fixture(({data, callback}) => {callback(translatedWire(data), {id: "auto"}, {id: "zh-CN"}, {});});
	try {
		assert.equal(f.plugin.getEffectivePrimaryEngine(CHANNEL), "googleapi"); assert.equal(f.plugin.getHistoricalAiBatchEngineKey(CHANNEL), null);
		const observed = [enqueue(f.plugin, received("classic-ok-1")), enqueue(f.plugin, received("classic-ok-2"))];
		const summary = await f.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);
		assert.equal(f.calls.length, 2); assert.equal(summary.translated.length, 2); assert.equal(summary.failed.length, 0); assert.deepEqual(f.commits.map(block => block.length), [1, 1]); assert.equal(f.cacheWrites.length, 2);
		assert.deepEqual(f.commits.flat().map(row => String(row.messageId)).sort(), ["classic-ok-1", "classic-ok-2"]);
		assert.equal(new Set(f.cacheWrites.map(row => row.id)).size, 2);
		const routes = f.plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => observed.some(item => item.messageIdentity === route.messageIdentity));
		assert.equal(routes.length, 2); for (const route of routes) {assert.equal(route.providerDispatchCount, 1); assert.deepEqual(route.providerRoles, {primary: 1}); assert.equal(route.engineFamily, "classic"); assert.equal(route.requestFamily, "classic-marked"); assert.equal(route.validatorFamily, "segment-validator-v3"); assert.equal(route.outcome, "translated"); assert.equal(route.reason, "committed"); assert.deepEqual(route.historyPath, ["eligibility:plan_translate", "collector:accepted", "seal:sealed", "primary:dispatch", "primary:settled", "atomic-commit:committed", "display-currentness:confirmed"]);}
		assert.equal(f.plugin.getTranslationTerminalLedgerSnapshot().recent.some(route => route.lane === "item-repair"), false);
		const perf = f.plugin.getHistoricalBatchPerformanceSnapshot().latestRun; assert.equal(perf.requestedChunks, 2); assert.equal(perf.providerMessageCount, 2); assert.equal(perf.repairItemRequests, 0);
	}
	finally {try {await f.plugin.onStop();} catch {}}
});

test("M3h classic primary empty and wrong-language failures repair once, retain, and cache clear retires failed snapshots", async () => {
	const f = fixture(({data, callback, call}) => {const placeholders = [...new Set(String(data.text || "").match(/⟦(?:DTA)?\d+⟧/g) || [])]; callback(call <= 3 ? "" : `English wrong target ${placeholders.join(" ")}`, {id: "auto"}, {id: "zh-CN"}, {});});
	try {
		const messages = [received("classic-fail-1"), received("classic-fail-2")], observed = messages.map(message => enqueue(f.plugin, message));
		const summary = await f.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);
		const failureDiagnostic = () => JSON.stringify({calls: f.calls.length, summary: {translated: summary.translated.length, skipped: summary.skipped.length, failed: summary.failed.length}, routes: f.plugin.getTranslationTerminalLedgerSnapshot().recent}); assert.equal(f.calls.length, 4, failureDiagnostic()); assert.equal(summary.translated.length, 0, failureDiagnostic()); assert.equal(summary.failed.length, 2, failureDiagnostic()); assert.equal(f.plugin.getFailedHistoricalTranslationCount(CHANNEL), 2, failureDiagnostic());
		const parents = f.plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => observed.some(item => item.messageIdentity === route.messageIdentity)); assert.equal(parents.length, 2); assert.equal(parents.every(route => route.providerDispatchCount === 2 && route.providerRoles.primary === 1 && route.providerRoles.repair === 1 && route.historyPath.includes("primary:settled") && !route.historyPath.includes("batch-repair:planned") && route.historyPath.includes("item-repair:dispatch") && route.outcome === "failed"), true, JSON.stringify(parents));
		const itemRoutes = f.plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => route.lane === "item-repair"); assert.equal(itemRoutes.length, 0, "semantic repair stays correlated to its history parent route"); assert.equal(parents.some(route => ["empty","malformed"].includes(route.reason)), true, JSON.stringify(parents));
		const retained = enqueue.bind(null, f.plugin); assert.equal(f.plugin.queueAutoTranslateMessage(messages[0], {id: CHANNEL}, {content: messages[0].content, embeds: []}, {historicalLoad: true}), false); f.plugin.ensureTranslationCacheStore().clearAll(); assert.equal(f.plugin.getFailedHistoricalTranslationCount(CHANNEL), 2, "translation cache alone does not own retained failures");
		assert.equal(typeof f.plugin.clearHistoricalTranslationFailures, "function"); assert.equal(f.plugin.clearHistoricalTranslationFailures(CHANNEL), 2); assert.equal(f.plugin.getFailedHistoricalTranslationCount(CHANNEL), 0); retained(messages[0]); f.plugin.cancelHistoricalTranslationJobs(CHANNEL, "test-cleanup");
	}
	finally {try {await f.plugin.onStop();} catch {}}
});
