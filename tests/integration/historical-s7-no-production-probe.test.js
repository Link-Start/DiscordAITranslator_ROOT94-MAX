const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const settle = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(body)});
const message = id => ({id: String(id), channel_id: "s7-fixed4", content: `Historical S7 fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}});

test("S7 fixed4 sends exactly five official blocks and launches four before any settles", async () => {
	const pending = [];
	let active = 0, highWater = 0;
	const expectedIds = new Set(Array.from({length: 50}, (_, index) => String(1000 + index)));
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	try {plugin.onLoad();} catch (error) {}
	plugin.shouldUseAtomicSemanticRevision = () => false;
	global.BdApi.Net = {fetch: (url, options) => new Promise(resolve => {
		active++;
		highWater = Math.max(highWater, active);
		pending.push({url, options, resolve: value => {active--; resolve(value);}, settled: false});
	})};
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s7.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	assert.equal(pending.length, 0, "configuration change creates no automatic validation request");
	plugin.settings.engines.translator = "oaicompat";
	plugin.settings.engines.backup = "----";
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	plugin.validateHistoricalTranslationJobResult = (prepared, raw, job) => raw == null ? {ok: false} : {ok: true, translation: {channelId: job.channelId, auto: true, content: String(raw), translatedContent: String(raw), originalContent: prepared.originalContentData && prepared.originalContentData.content || "", signature: prepared.signature, input: prepared.input, output: prepared.output}};
	const views = new Map(), originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);

	const settleRequest = request => {
		if (!request || request.settled) return;
		request.settled = true;
		const prompt = JSON.parse(request.options.body).messages[1].content;
		const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]).filter(id => expectedIds.has(id));
		request.ids = ids;
		request.resolve(response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]})));
	};

	try {
		for (let index = 0; index < 50; index++) {
			const item = message(1000 + index);
			plugin.queueAutoTranslateMessage(item, {id: "s7-fixed4"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
		}
		const running = plugin.startCollectedHistoricalTranslationJobs("s7-fixed4");
		while (pending.length < 4) await settle();
		assert.equal(pending.length, 4);
		assert.equal(active, 4);
		assert.equal(highWater, 4);
		settleRequest(pending[2]);
		while (pending.length < 5) await settle();
		assert.equal(pending.length, 5);
		for (const request of pending) settleRequest(request);
		await running;

		assert.equal(pending.length, 5, "no canary or preflight request is added");
		assert.deepEqual(pending.map(request => request.ids.length), [10, 10, 10, 10, 10]);
		assert.equal(new Set(pending.flatMap(request => request.ids)).size, 50);
		assert.equal(active, 0);
		const snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		assert.equal(snapshot.latestRun.requestedChunks, 5);
		assert.equal(snapshot.latestRun.maxActiveChunks, 4);
		assert.equal(snapshot.latestRun.translatedCount, 50);
		assert.equal(snapshot.latestRun.h1.probeBarrierCount, 0);
		assert.equal(snapshot.latestRun.h1.probeBarrierSettledCount, 0);
		assert.equal(snapshot.latestRun.h1.primaryWaveCount, 2);
		assert.equal(snapshot.latestRun.h1.conservation.attemptCount, 5);
		assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	}
	finally {delete global.BdApi.Net;}
});
