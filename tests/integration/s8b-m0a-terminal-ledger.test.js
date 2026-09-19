const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown, targetBodyForeignTitle} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

function createObservedPlugin({engine = "googleapi", persisted = {}} = {}) {
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: engine, backup: "----"}, performance: {historicalConcurrency: "1", historicalSafetyDownshift: false, liveConcurrency: "1"}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "en", output: "zh-CN"}}}},
		bdfdb: {DataUtils: {load: (_plugin, key) => persisted[key] || {}, save: (value, _plugin, key) => {persisted[key] = JSON.parse(JSON.stringify(value));}}}
	});
	try {plugin.onLoad();} catch {}
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getReceivedTranslationPlanEligibility = () => ({enabled: false});
	plugin.isTranslationEnabled = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.isOwnMessage = () => false;
	plugin.scheduleReceivedDisplayFlush = () => {};
	return plugin;
}

const message = (id, content, embeds = []) => ({id, channel_id: "m0a-channel", content, embeds, attachments: [], author: {id: "fixture-user"}});

test("S8b M0a production single routes report exact current terminal causes without changing provider count", async () => {
	const persisted = {}, plugin = createObservedPlugin({persisted});
	let providerRequests = 0;
	plugin.googleApiTranslate = (_data, callback) => {providerRequests++; callback("仅翻译正文");};
	plugin.applyStoredTranslationToMessage = () => {};
	plugin.commitReceivedDisplayResult = () => Promise.resolve({committedIds: [], confirmedIds: [], deferredIds: []});

	assert.equal(await plugin.translateMessage(message("manual-original", original14Markdown), {id: "m0a-channel"}, {manual: true, silent: true, trackBusy: false}), false);
	assert.equal(await plugin.translateMessage(message("auto-original", original14Markdown), {id: "m0a-channel"}, {auto: true, silent: true, trackBusy: false}), false);
	assert.equal(await plugin.translateMessage(message("manual-title", targetBodyForeignTitle), {id: "m0a-channel"}, {manual: true, silent: true, trackBusy: false}), false);
	assert.equal(await plugin.translateMessage(message("auto-title", targetBodyForeignTitle), {id: "m0a-channel"}, {auto: true, silent: true, trackBusy: false}), false);
	assert.equal(await plugin.translateMessage(message("embed-title", targetBodyForeignTitle, [{title: "Financial Aid Application Requirements"}]), {id: "m0a-channel"}, {manual: true, silent: true, trackBusy: false}), false);
	// All-caps words are translatable text since the acronym guess was retired, so the
	// "nothing translatable" reply preview is an emoji-only one.
	await new Promise(resolve => plugin.translateText("😂😂", "received", () => resolve(), null, {showToast: false, showFailureToast: false, trackBusy: false, terminalLane: "reply"}));
	// The sent direction no longer guesses acronyms either, so its untranslatable sample is emoji-only too.
	await new Promise(resolve => plugin.translateText("😂😂", "sent", () => resolve(), null, {showToast: false, showFailureToast: false, trackBusy: false}));

	const snapshot = plugin.getTranslationTerminalLedgerSnapshot();
	const byLane = lane => snapshot.recent.filter(item => item.lane === lane);
	assert.equal(providerRequests, 2, "the two pre-request skips add no provider request");
	assert.deepEqual(byLane("manual").slice(0, 2).map(item => [item.outcome, item.stage, item.reason, item.placeholderOccurrences]), [
		["failed", "placeholder", "placeholder_missing", 8],
		["skipped", "precheck", "same_language", 0]
	]);
	assert.deepEqual(byLane("auto-single").map(item => [item.outcome, item.stage, item.reason, item.placeholderOccurrences]), [
		["failed", "placeholder", "placeholder_missing", 8],
		["skipped", "precheck", "same_language", 0]
	]);
	const embed = snapshot.recent.find(item => item.laneTags["embed-forward"]);
	assert.ok(embed); assert.equal(embed.shape, "embed-forward"); assert.equal(embed.stage, "precheck");
	// P3 item 3: a reply preview with nothing translatable is a skip, not a failure; the sent lane is unchanged.
	assert.deepEqual(byLane("reply").map(item => [item.outcome, item.stage, item.reason]), [["skipped", "protection", "all_protected"]]);
	assert.deepEqual(byLane("sent").map(item => [item.outcome, item.stage, item.reason]), [["failed", "protection", "all_protected"]]);
	assert.equal(snapshot.activeRouteCount, 0);
	plugin.flushTranslationTerminalLedger();
	assert.equal(persisted.translationTerminalLedger.routes.length, 7);
	assert.doesNotMatch(JSON.stringify(persisted.translationTerminalLedger), /Financial Aid|Degree of Interest|fixture-user|仅翻译正文|https?:|authorization/i);
});

test("S8b M0a production history primary routes terminate at the shared display-currentness owner", async () => {
	const persisted = {}, plugin = createObservedPlugin({engine: "oaicompat", persisted});
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://m0a.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.settings.engines.translator = "oaicompat";
	plugin.shouldUseAtomicSemanticRevision = () => false;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = () => {};
	plugin.commitHistoricalReceivedDisplayBatch = results => Promise.resolve({committedIds: results.map(result => result.messageId), confirmedIds: results.map(result => result.messageId), deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	global.BdApi.Net = {fetch: async (_url, options) => {const prompt = JSON.parse(options.body).messages[1].content; const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]); return {status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]}))};}};
	try {
		for (const id of ["1000", "1001"]) {const item = message(id, `Historical route ${id}`); plugin.queueAutoTranslateMessage(item, {id: "m0a-channel"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
		await plugin.startCollectedHistoricalTranslationJobs("m0a-channel");
		const routes = plugin.getTranslationTerminalLedgerSnapshot().recent.filter(item => item.lane === "history-primary");
		assert.equal(routes.length, 2);
		assert.equal(routes.every(item => item.outcome === "translated" && item.stage === "display-currentness" && item.reason === "committed"), true, JSON.stringify(routes));
		assert.equal(routes.every(item => item.promptFamily === "batch-json" && item.validatorFamily === "history-batch" && item.engineFamily === "ai"), true);
		assert.equal(plugin.getTranslationTerminalLedgerSnapshot().activeRouteCount, 0);
	}
	finally {delete global.BdApi.Net; try {await Promise.resolve(plugin.onStop());} catch {}}
});
