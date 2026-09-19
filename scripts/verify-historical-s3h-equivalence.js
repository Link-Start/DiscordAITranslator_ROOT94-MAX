"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");

const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();

function message(id, content) {
	return {id: String(id), channel_id: "s3h-equivalence", content, embeds: [], attachments: [], author: {id: "fixture-user"}};
}

async function capture(bundlePath) {
	const requests = [];
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		settings: {
			engines: {translator: "openai", backup: "----"},
			filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false},
			choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}
		},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {LibraryRequires: {request(url, options, callback) {
			requests.push({url, options});
			const body = JSON.parse(options.body);
			const ids = [...body.input.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
			const output = ids.map(id => ({id, translation: `译文-${id}`}));
			setImmediate(() => callback(null, {statusCode: 200}, JSON.stringify({status: "completed", usage: {input_tokens: 40, output_tokens: 10}, output_text: JSON.stringify(output)})));
		}}}
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
	const cacheWrites = [], storeCommits = [], views = new Map(), status = [];
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.persistTranslationCacheEntry = (messageId, signature, translation) => cacheWrites.push({messageId: String(messageId), signatureSha256: sha256(signature), translatedContent: translation && translation.translatedContent});
	plugin.persistReceivedSkipDecision = () => {};
	plugin.updateLoadedAutoTranslationStatus = update => status.push({active: update.active == null ? null : !!update.active, collecting: update.collecting == null ? null : !!update.collecting, done: update.done == null ? null : !!update.done, total: update.total == null ? null : Number(update.total), processed: update.processed == null ? null : Number(update.processed), displayed: update.displayed == null ? null : Number(update.displayed), skipped: update.skipped == null ? null : Number(update.skipped), failed: update.failed == null ? null : Number(update.failed)});
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		storeCommits.push(results.map(result => ({messageId: String(result.messageId), status: result.status, origin: result.origin})));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	for (const item of [message("101", "hello one"), message("102", "hello two")]) assert.equal(plugin.queueAutoTranslateMessage(item, {id: "s3h-equivalence"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true);
	await plugin.startCollectedHistoricalTranslationJobs("s3h-equivalence");
	await plugin.waitForHistoricalTranslationJobs("s3h-equivalence");
	return {
		requestCount: requests.length,
		requests: requests.map(request => ({provider: "openai", url: request.url, method: request.options.method, headerNames: Object.keys(request.options.headers || {}).sort(), bodyBytes: Buffer.byteLength(request.options.body || "", "utf8"), bodySha256: sha256(request.options.body || "")})),
		cacheWrites,
		storeCommits,
		domViews: [...views.entries()].map(([id, view]) => ({id, status: view.status, translated: !!view.translated})).sort((left, right) => left.id.localeCompare(right.id)),
		status,
		pending: plugin.isHistoricalMessagePending("101", "s3h-equivalence")
	};
}

async function verify(baselinePath, modifiedPath) {
	const baseline = await capture(baselinePath);
	const modified = await capture(modifiedPath);
	assert.deepEqual(modified, baseline);
	return {equivalent: true, baseline, modified};
}

if (require.main === module) {
	verify(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), error => {
		console.error(error && error.stack || error);
		process.exitCode = 1;
	});
}

module.exports = {capture, verify};
