"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");

const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();
const message = id => ({id: String(id), channel_id: "s4-equivalence", content: `Historical fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}});

async function capture(bundlePath, {nativeFetch = false} = {}) {
	const requests = [], cacheWrites = [], commits = [], views = new Map(), status = [];
	const answer = options => {
		const input = JSON.parse(options.body).messages[1].content;
		const ids = [...input.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
		return JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}], usage: {prompt_tokens: 20, completion_tokens: 5}});
	};
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {LibraryRequires: {request(url, options, callback) {requests.push({url, options}); setImmediate(() => callback(null, {statusCode: 200}, answer(options)));}}}
	});
	if (nativeFetch) global.BdApi.Net = {fetch: async (url, options) => {requests.push({url, options}); return {status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(answer(options))};}};
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://fixture.test/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = (messageId, signature, translation) => cacheWrites.push({messageId: String(messageId), signatureSha256: sha256(signature), translatedContent: translation && translation.translatedContent});
	plugin.persistReceivedSkipDecision = () => {};
	plugin.updateLoadedAutoTranslationStatus = update => status.push({active: update.active == null ? null : !!update.active, collecting: update.collecting == null ? null : !!update.collecting, done: update.done == null ? null : !!update.done, total: update.total == null ? null : Number(update.total), processed: update.processed == null ? null : Number(update.processed), displayed: update.displayed == null ? null : Number(update.displayed), skipped: update.skipped == null ? null : Number(update.skipped), failed: update.failed == null ? null : Number(update.failed)});
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		commits.push(results.map(result => ({messageId: String(result.messageId), status: result.status, origin: result.origin})));
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);
	try {
		for (const id of ["101", "102"]) {const item = message(id); plugin.queueAutoTranslateMessage(item, {id: "s4-equivalence"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
		await plugin.startCollectedHistoricalTranslationJobs("s4-equivalence");
		return {
			requestCount: requests.length,
			requests: requests.map(request => ({provider: "oaicompat", url: request.url, method: request.options.method, headerNames: Object.keys(request.options.headers || {}).sort(), bodyBytes: Buffer.byteLength(request.options.body || "", "utf8"), bodySha256: sha256(request.options.body || "")})),
			cacheWrites,
			commits,
			domViews: [...views.entries()].map(([id, view]) => ({id, status: view.status, translated: !!view.translated})).sort((left, right) => left.id.localeCompare(right.id)),
			status,
			pending: plugin.isHistoricalMessagePending("101", "s4-equivalence")
		};
	}
	finally {if (nativeFetch) delete global.BdApi.Net;}
}

async function verify(baselinePath, modifiedPath) {
	const baseline = await capture(baselinePath, {nativeFetch: false});
	const modified = await capture(modifiedPath, {nativeFetch: true});
	assert.deepEqual(modified, baseline);
	return {equivalent: true, baseline, modified};
}

if (require.main === module) verify(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), error => {console.error(error && error.stack || error); process.exitCode = 1;});
module.exports = {capture, verify};
