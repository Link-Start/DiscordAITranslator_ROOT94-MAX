const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

function message(id, content) {
	return {id: String(id), channel_id: "history-h1", content, embeds: [], attachments: [], author: {id: "fixture-user"}};
}

test("H1 real history wiring records source through DOM with one unchanged provider body", async () => {
	const requests = [];
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {
			engines: {translator: "openai", backup: "----"},
			filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false},
			choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}
		},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {
			DataUtils: {
				load: (_plugin, key) => key === "authKeys" ? {openai: {key: "fixture-secret", endpoint: "https://api.openai.com/v1/responses", model: "fixture-model"}} : {},
				save: () => {}
			},
			LibraryRequires: {
				request(url, options, callback) {
					requests.push({url, options});
					const sent = JSON.parse(options.body);
					const ids = [...sent.input.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
					const output = ids.map(id => ({id, translation: `译文-${id}`}));
					setImmediate(() => callback(null, {statusCode: 200}, JSON.stringify({status: "completed", usage: {input_tokens: 30, output_tokens: 8}, output_text: JSON.stringify(output)})));
				}
			}
		}
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

	for (const item of [message("101", "hello one"), message("102", "hello two")]) {
		assert.equal(plugin.queueAutoTranslateMessage(item, {id: "history-h1"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true, historicalCacheLookup: {hadEntry: false, invalidated: false}}), true);
	}
	await plugin.startCollectedHistoricalTranslationJobs("history-h1");
	await plugin.waitForHistoricalTranslationJobs("history-h1");

	assert.equal(requests.length, 1, JSON.stringify(plugin.getHistoricalBatchPerformanceSnapshot()));
	assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
	assert.equal(JSON.parse(requests[0].options.body).store, false);
	const performance = plugin.getHistoricalBatchPerformanceSnapshot();
	const run = performance.latestRun;
	assert.equal(run.atomicCommitCount, 1);
	assert.equal(run.h1.conservation.passed, true);
	assert.equal(run.h1.conservation.logicalCount, 1);
	assert.equal(run.h1.conservation.attemptCount, 1);
	assert.equal(run.h1.cache.miss, 2);
	assert.equal(run.h1.parseCount, 2);
	assert.equal(run.h1.validCount, 2);
	assert.equal(run.h1.domConfirmedCount, 2);
	assert.equal(run.h1.bodyBytes, Buffer.byteLength(requests[0].options.body, "utf8"));
	assert.equal(run.h1.attempts[0].engineKey, "openai");
	assert.equal(run.h1.attempts[0].usage.reasoningTokens, null);
	assert.equal(run.h1.attempts[0].finishReason, "completed");
	assert.equal(run.h1.attempts[0].physicalAbort, null, "unmigrated official callback protocol stays unknown");
	assert.deepEqual(run.h1.attempts[0].headers, null);
	assert.equal(performance.providerBudget.grantedAttemptCount, 1);
	assert.equal(performance.providerBudget.settledAttemptCount, 1);
	assert.equal(performance.providerBudget.logicalOnlyBeforeS4, true);
	assert.deepEqual(performance.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	const serialized = JSON.stringify(run.h1);
	assert.doesNotMatch(serialized, /fixture-secret|api\.openai\.com|fixture-model|hello one|hello two/);
});
