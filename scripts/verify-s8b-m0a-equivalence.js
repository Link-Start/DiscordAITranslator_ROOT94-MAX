"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");
const {original14Markdown, targetBodyForeignTitle} = require("../tests/fixtures/s8b-m0a-mixed-language-fixtures");

const sha256 = value => crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").toUpperCase();
const message = (id, content) => ({id, channel_id: "m0a-equivalence", content, embeds: [], attachments: [], author: {id: "fixture-user"}});

async function capture(bundlePath) {
	const engineKey = "custom-m0aequivalence", wire = [], cacheReads = [], cacheWrites = [], commits = [], results = [];
	const plugin = createPluginInstance({
		pluginPath: bundlePath,
		callSetLanguages: false,
		settings: {engines: {translator: engineKey, backup: "----", customProviders: [{id: engineKey, name: "Fixture"}]}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai", aiAutoTranslatePrompt: "PRIVATE USER PROMPT"}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}}
	});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = engineKey; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: engineKey, name: "Fixture"}];
	try {plugin.setLanguages();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({[engineKey]: {key: "fixture-key", endpoint: "https://m0a.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.isTranslationEnabled = () => true; plugin.isMessageWithinLoadedRange = () => true; plugin.isOwnMessage = () => false;
	plugin.getCachedReceivedTranslation = (...args) => (cacheReads.push(["translation", String(args[0] && args[0].id)]), null);
	plugin.getCachedReceivedSkipDecision = (...args) => (cacheReads.push(["skip", String(args[0] && args[0].id)]), null);
	plugin.persistReceivedSkipDecision = (id, _signature, reason) => cacheWrites.push(["skip", String(id), String(reason)]);
	plugin.persistTranslationCacheEntry = id => cacheWrites.push(["translation", String(id)]);
	plugin.commitReceivedDisplayResult = result => (commits.push({messageId: String(result.messageId), status: result.status, reason: result.reason || null}), Promise.resolve({committedIds: [String(result.messageId)], confirmedIds: [], deferredIds: [String(result.messageId)]}));
	global.BdApi.Net = {fetch: async (url, options) => {
		const body = String(options.body || ""), parsed = JSON.parse(body), userText = String(parsed.messages && parsed.messages[parsed.messages.length - 1] && parsed.messages[parsed.messages.length - 1].content || "");
		const reasoningFields = Object.fromEntries(Object.entries(parsed).filter(([key]) => /reasoning|thinking/i.test(key)));
		wire.push({provider: engineKey, url: String(url), method: String(options.method || "GET"), headers: Object.assign({}, options.headers || {}), bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body), containsUserPrompt: body.includes("PRIVATE USER PROMPT"), reasoningFields});
		return {status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(JSON.stringify({choices: [{message: {content: userText}, finish_reason: "stop"}]}))};
	}};
	try {
		for (const [id, content, options] of [
			["manual-original", original14Markdown, {manual: true, silent: true, trackBusy: false}],
			["auto-original", original14Markdown, {auto: true, silent: true, trackBusy: false}],
			["manual-title", targetBodyForeignTitle, {manual: true, silent: true, trackBusy: false}],
			["auto-title", targetBodyForeignTitle, {auto: true, silent: true, trackBusy: false}]
		]) results.push([id, await plugin.translateMessage(message(id, content), {id: "m0a-equivalence"}, options)]);
	}
	finally {delete global.BdApi.Net; try {await Promise.resolve(plugin.onStop());} catch {}}
	return {wire, cacheReads, cacheWrites, commits, results};
}

async function verify(baselinePath, modifiedPath) {
	const baseline = await capture(baselinePath), modified = await capture(modifiedPath);
	assert.deepEqual(modified, baseline);
	assert.equal(modified.wire.length, 1);
	assert.equal(modified.wire[0].containsUserPrompt, false);
	assert.deepEqual(Object.keys(modified.wire[0].reasoningFields), ["reasoning_effort"]);
	assert.deepEqual(modified.results, [["manual-original", false], ["auto-original", true], ["manual-title", false], ["auto-title", false]]);
	return {equivalent: true, requestCount: modified.wire.length, wire: modified.wire.map(item => ({provider: item.provider, url: item.url, method: item.method, headerNames: Object.keys(item.headers).sort(), bodyBytes: item.bodyBytes, bodySha256: item.bodySha256, containsUserPrompt: item.containsUserPrompt, reasoningFields: item.reasoningFields})), cacheReads: modified.cacheReads, cacheWrites: modified.cacheWrites, commits: modified.commits, results: modified.results};
}

if (require.main === module) verify(path.resolve(process.argv[2]), path.resolve(process.argv[3])).then(result => {process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exit(0);}, error => {console.error(error && error.stack || error); process.exit(1);});
module.exports = {capture, verify};
