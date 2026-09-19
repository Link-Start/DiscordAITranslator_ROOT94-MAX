"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");

const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();
const settle = () => new Promise(resolve => setImmediate(resolve));
const message = id => ({id: String(id), channel_id: "s7-equivalence", content: `Historical S7 fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}});
const response = body => ({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(body)});

async function capture(bundlePath) {
	const expectedIds = new Set(Array.from({length: 50}, (_, index) => String(1000 + index)));
	const requests = [], cacheWrites = [], commits = [], views = new Map();
	let active = 0, highWater = 0;
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	try {plugin.onLoad();} catch (error) {}
	global.BdApi.Net = {fetch: (url, options) => new Promise(resolve => {
		active++;
		highWater = Math.max(highWater, active);
		requests.push({url, options, settled: false, resolve: value => {active--; resolve(value);}});
	})};
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://s7.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.settings.engines.translator = "oaicompat";
	plugin.settings.engines.backup = "----";
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = (messageId, signature, translation) => cacheWrites.push({messageId: String(messageId), signatureSha256: sha256(signature), translatedContent: translation && translation.translatedContent});
	plugin.persistReceivedSkipDecision = () => {};
	plugin.validateHistoricalTranslationJobResult = (prepared, raw, job) => raw == null ? {ok: false} : {ok: true, translation: {channelId: job.channelId, auto: true, content: String(raw), translatedContent: String(raw), originalContent: prepared.originalContentData && prepared.originalContentData.content || "", signature: prepared.signature, input: prepared.input, output: prepared.output}};
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		commits.push(results.map(result => ({messageId: String(result.messageId), status: result.status, origin: result.origin})));
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);

	const resolveRequest = request => {
		if (request.settled) return;
		request.settled = true;
		const prompt = JSON.parse(request.options.body).messages[1].content;
		const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]).filter(id => expectedIds.has(id));
		request.ids = ids;
		request.resolve(response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]})));
	};

	try {
		for (let index = 0; index < 50; index++) {const item = message(1000 + index); plugin.queueAutoTranslateMessage(item, {id: "s7-equivalence"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
		let finished = false;
		const running = plugin.startCollectedHistoricalTranslationJobs("s7-equivalence").finally(() => {finished = true;});
		await settle(); await settle();
		const initialDispatchCount = requests.length;
		while (!finished) {
			for (const request of requests.filter(request => !request.settled)) resolveRequest(request);
			await settle(); await settle();
		}
		await running;
		const snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		return {
			initialDispatchCount,
			highWater,
			wire: requests.map(request => ({provider: "oaicompat", url: request.url, method: request.options.method, headerNames: Object.keys(request.options.headers || {}).sort(), bodyBytes: Buffer.byteLength(request.options.body || "", "utf8"), bodySha256: sha256(request.options.body || ""), ids: request.ids})),
			cacheWrites,
			commits,
			domViews: [...views.entries()].map(([id, view]) => ({id, status: view.status, translated: !!view.translated})).sort((a, b) => a.id.localeCompare(b.id)),
			pending: plugin.isHistoricalMessagePending("1000", "s7-equivalence"),
			translatedCount: snapshot.latestRun.translatedCount,
			probeBarrierCount: snapshot.latestRun.h1.probeBarrierCount,
			probeBarrierSettledCount: snapshot.latestRun.h1.probeBarrierSettledCount,
			primaryWaveCount: snapshot.latestRun.h1.primaryWaveCount
		};
	}
	finally {delete global.BdApi.Net;}
}

async function verify(baselinePath, modifiedPath) {
	const baseline = await capture(baselinePath);
	const modified = await capture(modifiedPath);
	assert.deepEqual(modified.wire, baseline.wire);
	assert.deepEqual(modified.cacheWrites, baseline.cacheWrites);
	assert.deepEqual(modified.commits, baseline.commits);
	assert.deepEqual(modified.domViews, baseline.domViews);
	assert.equal(modified.pending, baseline.pending);
	assert.equal(modified.translatedCount, baseline.translatedCount);
	assert.equal(baseline.initialDispatchCount, 1);
	assert.equal(modified.initialDispatchCount, 4);
	assert.equal(baseline.probeBarrierCount, 1);
	assert.equal(modified.probeBarrierCount, 0);
	assert.equal(modified.probeBarrierSettledCount, 0);
	return {equivalent: true, baseline, modified};
}

if (require.main === module) verify(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), error => {console.error(error && error.stack || error); process.exitCode = 1;});
module.exports = {capture, verify};
