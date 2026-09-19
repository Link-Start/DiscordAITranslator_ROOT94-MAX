const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const response = body => ({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(body)});
const message = id => ({id: String(id), channel_id: "s8a-history", content: `Historical S8a fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}});

function createObservedPlugin(persisted) {
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {DataUtils: {load: (_plugin, key) => persisted[key] || {}, save: (value, _plugin, key) => {persisted[key] = JSON.parse(JSON.stringify(value));}}}
	});
	try {plugin.onLoad();} catch (error) {}
	plugin.shouldUseAtomicSemanticRevision = () => false;
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s8a.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.settings.engines.translator = "oaicompat";
	plugin.settings.engines.backup = "----";
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	const views = new Map(), originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);
	return plugin;
}

test("S8a production wiring persists five clean anonymous blocks and every validation reason", async () => {
	const persisted = {};
	const expectedIds = new Set(Array.from({length: 50}, (_, index) => String(1000 + index)));
	const plugin = createObservedPlugin(persisted);
	global.BdApi.Net = {fetch: async (_url, options) => {
		const prompt = JSON.parse(options.body).messages[1].content;
		const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]).filter(id => expectedIds.has(id));
		return response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]}));
	}};
	try {
		for (let index = 0; index < 50; index++) {const item = message(1000 + index); plugin.queueAutoTranslateMessage(item, {id: "s8a-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
		await plugin.startCollectedHistoricalTranslationJobs("s8a-history");
		let snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		assert.equal(snapshot.primarySamples.sampleCount, 5);
		assert.equal(snapshot.primarySamples.trainingSampleCount, 5);
		assert.equal(snapshot.primarySamples.finalOutcomes.translated, 50);
		assert.equal(snapshot.s8Gate.sampleCount, 5);
		assert.equal(snapshot.s8Gate.ready, false);
		assert.equal(snapshot.s8Gate.blockedReason, "insufficient_clean_samples");

		const job = {id: "classification", channelId: "s8a-history"};
		const prepared = id => ({message: {id}, originalContentData: {content: "same", embeds: []}, signature: `sig-${id}`, input: {id: "en"}, output: {id: "zh-CN"}, exceptions: []});
		plugin.validateHistoricalTranslationJobResult(prepared("missing"), null, job);
		plugin.validateHistoricalTranslationJobResult(prepared("empty"), "", job);
		plugin.hasAllProtectionPlaceholders = () => false;
		plugin.validateHistoricalTranslationJobResult(prepared("placeholder"), "translated", job);
		plugin.hasAllProtectionPlaceholders = () => true;
		plugin.addExceptions = value => value;
		plugin.isTranslationLikelyInTargetLanguage = () => false;
		plugin.validateHistoricalTranslationJobResult(prepared("language"), "translated", job);
		plugin.isTranslationLikelyInTargetLanguage = () => true;
		plugin.createStoredReceivedTranslationData = () => ({originalContent: "same", translatedContent: "same"});
		plugin.shouldKeepAutoTranslatedResult = () => true;
		plugin.isTranslationResultTooSimilar = () => true;
		plugin.validateHistoricalTranslationJobResult(prepared("same"), "same", job);
		plugin.createStoredReceivedTranslationData = () => ({originalContent: "source", translatedContent: "different"});
		plugin.validateHistoricalTranslationJobResult(prepared("similar"), "different", job);
		plugin.isTranslationResultTooSimilar = () => false;
		plugin.shouldKeepAutoTranslatedResult = () => false;
		plugin.validateHistoricalTranslationJobResult(prepared("policy"), "different", job);
		plugin.shouldKeepAutoTranslatedResult = () => true;
		plugin.createStoredReceivedTranslationData = () => null;
		plugin.validateHistoricalTranslationJobResult(prepared("unknown"), "different", job);

		plugin.flushHistoricalPrimarySamples();
		snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		for (const reason of ["missing_id", "empty", "placeholder_missing", "wrong_language", "same_as_source", "too_similar", "policy_rejected", "unknown"]) assert.equal(snapshot.primarySamples.validationReasons[reason], 1, reason);
		assert.equal(persisted.historicalPrimarySamples.samples.length, 5);
		assert.equal(persisted.historicalPrimarySamples.samples.every(sample => sample.final.translated === 10 && sample.usage.promptTokens === null && sample.usage.completionTokens === null && sample.usage.reasoningTokens === null), true);
		const serialized = JSON.stringify(persisted.historicalPrimarySamples);
		assert.doesNotMatch(serialized, /fixture-secret|s8a\.fixture|fixture-model|Historical S8a fixture|translatedContent|Authorization/i);
		assert.ok(Buffer.byteLength(serialized, "utf8") < 1024 * 1024);
	}
	finally {delete global.BdApi.Net;}

	const reloaded = createObservedPlugin(persisted);
	try {reloaded.onStart();} catch (error) {}
	const restored = reloaded.getHistoricalBatchPerformanceSnapshot();
	assert.equal(restored.primarySamples.sampleCount, 5);
	assert.equal(restored.primarySamples.validationReasons.missing_id, 1);
	await Promise.resolve(reloaded.onStop && reloaded.onStop());
});
