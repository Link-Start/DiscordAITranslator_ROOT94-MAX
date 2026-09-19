const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

const CHANNEL = "1000000000000000001";
const CUSTOM = "custom-m3i-global";
const clone = value => JSON.parse(JSON.stringify(value));
const received = id => ({id: String(id), channel_id: CHANNEL, content: original14Markdown, embeds: [], attachments: [], author: {id: "other-user"}});

function translateMarkedWire(wire, {dropLast = false} = {}) {
	const markers = [...String(wire || "").matchAll(/⟦(\d+)⟧/g)];
	assert.ok(markers.length >= 2, "the classic plan carries stable segment markers");
	let output = "";
	for (let index = 0; index < markers.length - 1; index++) output += `${markers[index][0]}译文${index}`;
	if (!dropLast) output += markers.at(-1)[0];
	return output;
}

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
	plugin.getTextSimilarityScore = () => 0; plugin.getAutoTranslatedResultRejectReason = () => null; plugin.isTranslationResultTooSimilar = () => false; plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.scheduleHistoricalTranslationJobStart = () => {}; plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || null;
	plugin.persistTranslationCacheEntry = (id, _signature, translation) => cacheWrites.push({id: String(id), translation});
	plugin.commitHistoricalReceivedDisplayBatch = results => {commits.push(results); for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false})); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	plugin.googleApiTranslate = (data, callback) => {calls.push({text: String(data.text || ""), semanticRequest: data.semanticRequest || null, silent: data.silent === true}); responder({data, callback, call: calls.length});};
	return {plugin, persisted, views, commits, cacheWrites, calls};
}

function enqueue(plugin, message) {
	const source = {content: message.content, embeds: []}, observed = plugin.observeHistoricalAutoEligibility(message, {id: CHANNEL}, source, {origin: "history-render", ignoreQueued: true});
	assert.equal(observed.eligible, true); assert.equal(observed.reason, "plan_translate");
	assert.equal(plugin.queueAutoTranslateMessage(message, {id: CHANNEL}, source, {historicalLoad: true, deferHistoricalSnapshotStart: true, terminalRouteId: observed.routeId}), true);
	return observed;
}

test("M3i exact Google history primary consumes only TranslationPlan translate segments and atomically reassembles", async () => {
	const f = fixture(({data, callback}) => callback(translateMarkedWire(data.text), {id: "en"}, {id: "zh-CN"}, {}));
	try {
		const observed = enqueue(f.plugin, received("exact-plan-primary"));
		const summary = await f.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);
		const diagnostic=JSON.stringify({calls:f.calls.map(row=>({length:row.text.length,adapter:row.semanticRequest&&row.semanticRequest.adapter,markers:(row.text.match(/⟦\d+⟧/g)||[]).length})),summary:{translated:summary.translated.length,skipped:summary.skipped.length,failed:summary.failed.length},ledger:f.plugin.getTranslationTerminalLedgerSnapshot().recent}); assert.equal(f.calls.length, 1,diagnostic); assert.equal(summary.translated.length, 1,diagnostic); assert.equal(summary.failed.length, 0,diagnostic); assert.equal(f.cacheWrites.length, 1); assert.equal(f.commits.length, 1);
		const call = f.calls[0]; assert.equal(call.semanticRequest.adapter, "classic-marked"); assert.equal(call.silent, true); assert.doesNotMatch(call.text, /可以。|身份\/位置|```text|4-3/); for (const term of ["Spouse/Dependent", "GED", "Non-Degree", "In-state", "Out-of-state", "Self-Pay"]) assert.match(call.text, new RegExp(term.replace(/[/-]/g, "\\$&")));
		const stored = summary.translated[0].translation; assert.match(stored.content, /译文/); assert.match(stored.content, /```text[\s\S]*1:[\s\S]*```/); assert.match(stored.content, /4-3/);
		const route = f.plugin.getTranslationTerminalLedgerSnapshot().recent.find(row => row.messageIdentity === observed.messageIdentity); assert.equal(route.outcome, "translated"); assert.equal(route.providerRoles.primary, 1); assert.equal(route.providerRoles.repair || 0, 0); assert.equal(route.validatorFamily, "segment-validator-v3");
	}
	finally {try {await f.plugin.onStop();} catch {}}
});

test("M3i missing classic segment marker repairs only the failed segment after primary settle", async () => {
	const f = fixture(({data, callback, call}) => callback(translateMarkedWire(data.text, {dropLast: call === 1}), {id: "en"}, {id: "zh-CN"}, {}));
	try {
		const observed = enqueue(f.plugin, received("exact-plan-repair"));
		const summary = await f.plugin.startCollectedHistoricalTranslationJobs(CHANNEL);
		const diagnostic=JSON.stringify({calls:f.calls.map(row=>({length:row.text.length,adapter:row.semanticRequest&&row.semanticRequest.adapter,markers:(row.text.match(/⟦\d+⟧/g)||[]).length,text:row.text.slice(0,120)})),summary:{translated:summary.translated.length,skipped:summary.skipped.length,failed:summary.failed.length},ledger:f.plugin.getTranslationTerminalLedgerSnapshot().recent}); assert.equal(f.calls.length, 2,diagnostic); assert.equal(summary.translated.length, 1,diagnostic); assert.equal(summary.failed.length, 0,diagnostic); assert.ok(f.calls[1].text.length < f.calls[0].text.length / 4, "successful siblings are absent from precise repair"); assert.equal((f.calls[1].text.match(/⟦\d+⟧/g) || []).length, 2);
		const route = f.plugin.getTranslationTerminalLedgerSnapshot().recent.find(row => row.messageIdentity === observed.messageIdentity); assert.deepEqual(route.providerRoles, {primary: 1, repair: 1}); assert.ok(route.historyPath.indexOf("primary:settled") < route.historyPath.indexOf("item-repair:dispatch")); assert.equal(route.outcome, "translated");
	}
	finally {try {await f.plugin.onStop();} catch {}}
});
