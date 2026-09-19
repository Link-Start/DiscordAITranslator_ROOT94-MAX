const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const settle = () => new Promise(resolve => setImmediate(resolve));

function message(id) {
	return {id: String(id), channel_id: "s3h-cap4", content: `Historical fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}};
}

test("S3H fixed4 production history shares one captured-key cap and zeros every owner", async () => {
	const requests = [];
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: "openai", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {LibraryRequires: {request(url, options, callback) {requests.push({url, options, callback, settled: false});}}}
	});
	plugin.ensureSettingsStore().replaceAuthKeys({openai: {key: "fixture-secret", endpoint: "https://api.openai.com/v1/responses", model: "fixture-model"}});
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "openai";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	const views = new Map();
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);
	for (let index = 0; index < 50; index++) {
		const item = message(1000 + index);
		assert.equal(plugin.queueAutoTranslateMessage(item, {id: "s3h-cap4"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true);
	}
	const respond = request => {
		request.settled = true;
		const input = JSON.parse(request.options.body).input;
		const ids = [...input.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
		request.callback(null, {statusCode: 200}, JSON.stringify({status: "completed", usage: {input_tokens: 100, output_tokens: 20}, output_text: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}));
	};
	const running = plugin.startCollectedHistoricalTranslationJobs("s3h-cap4");
	await settle(); await settle();
	assert.equal(requests.length, 4, "S7 fixed4 launches four official chunks in the first wave");
	respond(requests[0]);
	await settle(); await settle(); await settle();
	assert.equal(requests.length, 5, "settling one first-wave request refills the fifth and final official chunk");
	for (const request of requests.slice(1)) respond(request);
	await running;
	await plugin.waitForHistoricalTranslationJobs("s3h-cap4");
	const snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
	assert.equal(snapshot.latestRun.h1.conservation.passed, true);
	assert.equal(snapshot.latestRun.h1.conservation.atomicCommitCount, 5);
	assert.equal(snapshot.latestRun.commitResultCount, 50);
	assert.equal(snapshot.latestRun.committedCount, 50);
	assert.equal(snapshot.latestRun.h1.probeBarrierCount, 0);
	assert.equal(snapshot.latestRun.h1.probeBarrierSettledCount, 0);
	assert.equal(snapshot.providerBudget.grantedAttemptCount, 5);
	assert.equal(snapshot.providerBudget.settledAttemptCount, 5);
	assert.equal(snapshot.providerBudget.maxActiveByKey, 4);
	assert.equal(snapshot.providerBudget.highWater, 4);
	assert.equal(snapshot.providerBudget.deniedAttemptBudgetCount, 0);
	assert.equal(snapshot.providerBudget.deniedRequestBudgetCount, 0);
	assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	assert.equal(requests.every(request => Buffer.byteLength(request.options.body, "utf8") <= 65536), true);
});
