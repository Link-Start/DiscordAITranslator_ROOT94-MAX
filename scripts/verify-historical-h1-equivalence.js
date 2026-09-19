"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();
const settle = () => new Promise(resolve => setImmediate(resolve));

function preparedItems() {
	const input = {id: "en", name: "English"};
	const output = {id: "zh-CN", name: "Chinese"};
	return [
		{message: {id: "100"}, channelId: "history-equivalence", protectedText: "hello [NEWLINE] there", input, output},
		{message: {id: "200"}, channelId: "history-equivalence", protectedText: "second", input, output}
	];
}

async function captureProvider(bundlePath) {
	const calls = [];
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		bdfdb: {LibraryRequires: {request(url, options, callback) {
			calls.push({url, options});
			setImmediate(() => callback(null, {statusCode: 200}, JSON.stringify({status: "completed", usage: {input_tokens: 22, output_tokens: 6}, output_text: JSON.stringify([{id: "100", translation: "第一条"}, {id: "200", translation: "第二条"}])})));
		}}}
	});
	plugin.ensureSettingsStore().replaceAuthKeys({openai: {key: "fixture-key", endpoint: "https://api.openai.com/v1/responses", model: "fixture-model"}});
	const outcome = await plugin.requestAiBatchTranslationDetailed("openai", preparedItems());
	return {
		providerSelection: "openai",
		requestCount: calls.length,
		requests: calls.map(call => ({
			url: call.url,
			method: call.options.method,
			headerNames: Object.keys(call.options.headers || {}).sort(),
			bodyBytes: Buffer.byteLength(call.options.body || "", "utf8"),
			bodySha256: digest(call.options.body || "")
		})),
		outcome
	};
}

function message(id) {
	return {id: String(id), channel_id: "history-equivalence", content: `Synthetic historical message ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}};
}

async function captureHistory(bundlePath) {
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
	const requests = [], cacheWrites = [], skipWrites = [], storeCommits = [], status = [];
	const views = new Map();
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.updateLoadedAutoTranslationStatus = update => status.push({
		active: update.active == null ? null : !!update.active,
		collecting: update.collecting == null ? null : !!update.collecting,
		done: update.done == null ? null : !!update.done,
		total: update.total == null ? null : Number(update.total),
		processed: update.processed == null ? null : Number(update.processed),
		displayed: update.displayed == null ? null : Number(update.displayed),
		skipped: update.skipped == null ? null : Number(update.skipped),
		failed: update.failed == null ? null : Number(update.failed)
	});
	plugin.persistTranslationCacheEntry = (messageId, signature, translation) => cacheWrites.push({messageId: String(messageId), signatureSha256: digest(signature), content: translation && translation.content});
	plugin.persistReceivedSkipDecision = (...args) => skipWrites.push(args.length);
	plugin.requestAiBatchTranslation = (engineKey, items) => {
		const ids = items.map(item => String(item.message.id));
		requests.push({engineKey, ids, wireProjectionSha256: digest(JSON.stringify(items.map(item => ({id: String(item.message.id), text: String(item.protectedText || "").replace(/\n/g, " [NEWLINE] ").replace(/\s+/g, " ")}))))});
		return new Promise(resolve => setImmediate(() => resolve(Object.fromEntries(ids.map(id => [id, `译文-${id}`])))));
	};
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		storeCommits.push(results.map(result => ({messageId: String(result.messageId), status: result.status, origin: result.origin})));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};

	for (let index = 0; index < 10; index++) {
		const item = message(1000 + index);
		assert.equal(plugin.queueAutoTranslateMessage(item, {id: "history-equivalence"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true);
	}
	await plugin.startCollectedHistoricalTranslationJobs("history-equivalence");
	await plugin.waitForHistoricalTranslationJobs("history-equivalence");
	await settle();
	return {
		providerSelection: requests.map(request => request.engineKey),
		requestCount: requests.length,
		requestOrder: requests,
		cacheWrites,
		skipWrites,
		storeCommits,
		domViews: [...views.entries()].map(([id, view]) => ({id, status: view.status, translated: !!view.translated})).sort((left, right) => left.id.localeCompare(right.id)),
		status,
		pending: plugin.isHistoricalMessagePending("1000", "history-equivalence")
	};
}

async function verify(baselinePath, modifiedPath) {
	const baseline = {provider: await captureProvider(baselinePath), history: await captureHistory(baselinePath)};
	const modified = {provider: await captureProvider(modifiedPath), history: await captureHistory(modifiedPath)};
	assert.deepEqual(modified.provider, baseline.provider, "request count/order/body bytes/provider selection must stay identical");
	assert.deepEqual(modified.history, baseline.history, "cache/store/DOM/history behavior must stay identical");
	return {equivalent: true, baseline, modified};
}

if (require.main === module) {
	const baselinePath = path.resolve(process.argv[2]);
	const modifiedPath = path.resolve(process.argv[3]);
	verify(baselinePath, modifiedPath).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), error => {
		console.error(error && error.stack || error);
		process.exitCode = 1;
	});
}

module.exports = {captureProvider, captureHistory, verify};
