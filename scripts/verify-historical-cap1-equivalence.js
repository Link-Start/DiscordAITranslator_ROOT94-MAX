"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");

function createMessage(id) {
	return {id: String(id), channel_id: "synthetic-history", content: `This is synthetic historical message number ${id} and it needs translation.`, embeds: [], attachments: [], author: {id: "fixture-user"}};
}

function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

async function capture(bundlePath, count = 50) {
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		settings: {choices: {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "auto", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "deepseek";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.isHistoricalTranslationJobCurrent = () => true;
	plugin.getReceivedAutoTranslateLoadedLimit = () => count;
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	const committedViews = new Map();
	const getReceivedDisplayRuntimeView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = messageId => committedViews.get(String(messageId)) || getReceivedDisplayRuntimeView(messageId);
	const requests = [];
	const progress = [];
	const commits = [];
	let active = 0;
	let maxActive = 0;
	plugin.updateLoadedAutoTranslationStatus = update => progress.push({
		active: update.active == null ? null : !!update.active,
		collecting: update.collecting == null ? null : !!update.collecting,
		done: update.done == null ? null : !!update.done,
		total: update.total == null ? null : Number(update.total),
		processed: update.processed == null ? null : Number(update.processed),
		displayed: update.displayed == null ? null : Number(update.displayed),
		skipped: update.skipped == null ? null : Number(update.skipped),
		failed: update.failed == null ? null : Number(update.failed)
	});
	plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => {
		active++;
		maxActive = Math.max(maxActive, active);
		const request = {
			ids: preparedItems.map(item => String(item.message.id)),
			wireProjection: JSON.stringify(preparedItems.map(item => ({id: String(item.message.id), text: String(item.protectedText || "").replace(/\n/g, " [NEWLINE] ").replace(/\s+/g, " ")})))
		};
		requests.push(request);
		return new Promise(resolve => setImmediate(() => {
			active--;
			resolve(Object.fromEntries(request.ids.map(id => [id, `translated-${id}`])));
		}));
	};
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		commits.push(results.map(result => ({messageId: String(result.messageId), status: result.status, origin: result.origin})));
		const committedIds = results.map(result => String(result.messageId));
		for (const result of results) committedViews.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds, confirmedIds: committedIds, deferredIds: [], missingIds: [], rejectedIds: [], staleIds: [], fallbackUsed: false});
	};

	for (let index = 0; index < count; index++) {
		const message = createMessage(1000 + index);
		assert.equal(plugin.queueAutoTranslateMessage(message, {id: "synthetic-history"}, {content: message.content}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true);
	}
	await plugin.startCollectedHistoricalTranslationJobs("synthetic-history");
	await plugin.waitForHistoricalTranslationJobs("synthetic-history");
	await settle();
	return {requests, progress, commits, maxActive, pending: plugin.isHistoricalMessagePending("1000", "synthetic-history")};
}

(async () => {
	const baselinePath = path.resolve(process.argv[2]);
	const modifiedPath = path.resolve(process.argv[3]);
	const baseline = await capture(baselinePath);
	const modified = await capture(modifiedPath);
	assert.deepEqual(modified, baseline);
	process.stdout.write(`${JSON.stringify({equivalent: true, baseline, modified}, null, 2)}\n`);
})().catch(error => {
	console.error(error && error.stack || error);
	process.exitCode = 1;
});
