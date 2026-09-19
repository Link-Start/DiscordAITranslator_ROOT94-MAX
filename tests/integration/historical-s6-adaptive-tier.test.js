const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const message = (id, channelId) => ({id: String(id), channel_id: channelId, content: `Historical S6 fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}});
const response = (body, status = 200, retryAfter = null) => ({status, headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "retry-after" ? retryAfter : null}, text: () => Promise.resolve(body)});

function createPlugin({mode = "auto", safety = true, fetch}) {
	const views = new Map();
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: mode, historicalSafetyDownshift: safety, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	try {plugin.onLoad();} catch (error) {}
	plugin.shouldUseAtomicSemanticRevision = () => false;
	global.BdApi.Net = {fetch};
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s6-a.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
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
	plugin.validateHistoricalTranslationJobResult = (prepared, rawTranslation, job) => rawTranslation == null ? {ok: false} : {ok: true, translation: {channelId: job.channelId, auto: true, content: String(rawTranslation), translatedContent: String(rawTranslation), originalContent: prepared.originalContentData && prepared.originalContentData.content || "", signature: prepared.signature, input: prepared.input, output: prepared.output}};
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(mode);
	return plugin;
}

async function runHistory(plugin, channelId, count, offset = 0) {
	for (let index = 0; index < count; index++) {
		const item = message(`${offset + index}`, channelId);
		plugin.queueAutoTranslateMessage(item, {id: channelId}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
	}
	await plugin.startCollectedHistoricalTranslationJobs(channelId);
}

function successFetch(counter) {
	return async (_url, options) => {
		counter.count++;
		const prompt = JSON.parse(options.body).messages[1].content;
		const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]).filter(id => /^\d+$/.test(id));
		return response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]}));
	};
}

test("S6 production history learns only from its captured Transport Key and restores prior-key evidence", async () => {
	const counter = {count: 0};
	const plugin = createPlugin({mode: "auto", fetch: successFetch(counter)});
	try {
		await runHistory(plugin, "s6-a-1", 30, 1000);
		assert.deepEqual({learned: plugin.getHistoricalBatchPerformanceSnapshot().learnedTier, evidence: plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence}, {learned: 2, evidence: 1});
		await runHistory(plugin, "s6-a-2", 30, 2000);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().learnedTier, 3);

		plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s6-b.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
		await runHistory(plugin, "s6-b-1", 30, 3000);
		assert.deepEqual({learned: plugin.getHistoricalBatchPerformanceSnapshot().learnedTier, evidence: plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence}, {learned: 2, evidence: 1});

		plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s6-a.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
		await runHistory(plugin, "s6-a-3", 20, 4000);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().learnedTier, 3, "returning to the exact key restores its learned tier");
		assert.ok(counter.count >= 11);
		assert.deepEqual(plugin.getHistoricalBatchPerformanceSnapshot().adaptiveResources, {keys: 2, observations: 0});
	}
	finally {delete global.BdApi.Net;}
});

test("S6 Retry-After limits only its captured key while a healthy key remains dispatchable", async () => {
	let first = true;
	const counter = {count: 0};
	const success = successFetch({count: 0});
	const plugin = createPlugin({mode: "auto", safety: true, fetch: async (url, options) => {
		counter.count++;
		if (first) {first = false; return response("{}", 429, "5");}
		return success(url, options);
	}});
	try {
		await runHistory(plugin, "s6-rate", 2, 5000);
		let snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		assert.equal(snapshot.effectiveCap, 1);
		assert.equal(snapshot.effectiveReason, "rate_limit");
		assert.ok(snapshot.cooldownRemainingMs > 4000);
		plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s6-healthy.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
		await runHistory(plugin, "s6-healthy", 30, 6000);
		snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		assert.equal(snapshot.effectiveCap, 2);
		assert.equal(snapshot.effectiveReason, null);
		assert.equal(snapshot.promotionEvidence, 1);
		assert.ok(counter.count >= 4);
	}
	finally {delete global.BdApi.Net;}
});
