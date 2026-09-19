"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {capture: captureClean} = require("./verify-historical-s7-equivalence");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");

const message = id => ({id: String(id), channel_id: "s8a-repair", content: `repair fixture ${id}`, embeds: [], attachments: [], author: {id: "fixture-user"}});

async function captureRepair(bundlePath) {
	const calls = [], commits = [];
	let batchCall = 0;
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	try {plugin.onLoad();} catch (error) {}
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
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
	plugin.requestAiBatchTranslationDetailed = (_engine, preparedItems, timingContext) => {
		const ids = preparedItems.map(item => String(item.message.id));
		calls.push({mode: timingContext && timingContext.role === "retry" ? "batch_repair" : "primary", ids});
		batchCall++;
		if (batchCall === 1) return Promise.resolve({translations: {[ids[0]]: `译文-${ids[0]}`, [ids[1]]: ""}, failureKind: null, statusCode: 200});
		if (batchCall >= 3) return Promise.resolve({translations: {}, failureKind: null, statusCode: 200});
		return Promise.resolve({translations: {[ids[0]]: `修复-${ids[0]}`}, failureKind: null, statusCode: 200});
	};
	plugin.repairHistoricalTranslationJobItem = (prepared, job) => {
		calls.push({mode: "item_repair", ids: [String(prepared.message.id)]});
		return Promise.resolve({status: "translated", translation: {channelId: job.channelId, auto: true, content: `单修-${prepared.message.id}`, translatedContent: `单修-${prepared.message.id}`, originalContent: prepared.originalContentData.content, signature: prepared.signature, input: prepared.input, output: prepared.output}});
	};
	const views = new Map(), originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		commits.push(results.map(result => ({messageId: String(result.messageId), status: result.status, origin: result.origin})));
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	for (const id of ["1", "2", "3"]) {const item = message(id); plugin.queueAutoTranslateMessage(item, {id: "s8a-repair"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
	await plugin.startCollectedHistoricalTranslationJobs("s8a-repair");
	const latest = plugin.getHistoricalBatchPerformanceSnapshot().latestRun;
	return {calls, commits, translatedCount: latest.translatedCount, failedCount: latest.failedCount, repairBatchRequests: latest.repairBatchRequests, repairBatchMessages: latest.repairBatchMessages, repairItemRequests: latest.repairItemRequests};
}

async function verify(baselinePath, modifiedPath) {
	const baselineClean = await captureClean(baselinePath);
	const modifiedClean = await captureClean(modifiedPath);
	for (const field of ["wire", "cacheWrites", "commits", "domViews", "pending", "translatedCount"]) assert.deepEqual(modifiedClean[field], baselineClean[field], field);
	assert.equal(baselineClean.initialDispatchCount, 4);
	assert.equal(modifiedClean.initialDispatchCount, 4);
	assert.equal(baselineClean.probeBarrierCount, 0);
	assert.equal(modifiedClean.probeBarrierCount, 0);
	const baselineRepair = await captureRepair(baselinePath);
	const modifiedRepair = await captureRepair(modifiedPath);
	assert.deepEqual(modifiedRepair, baselineRepair);
	return {equivalent: true, clean: {requestCount: modifiedClean.wire.length, initialDispatchCount: modifiedClean.initialDispatchCount, bodyBytes: modifiedClean.wire.map(request => request.bodyBytes), bodySha256: modifiedClean.wire.map(request => request.bodySha256), cacheWrites: modifiedClean.cacheWrites.length, commits: modifiedClean.commits.length, domViews: modifiedClean.domViews.length, probeBarrierCount: modifiedClean.probeBarrierCount}, repair: modifiedRepair};
}

if (require.main === module) verify(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), error => {console.error(error && error.stack || error); process.exitCode = 1;});
module.exports = {captureRepair, verify};
