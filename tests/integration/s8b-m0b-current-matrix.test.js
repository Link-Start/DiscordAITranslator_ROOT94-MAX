const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

function createMatrixPlugin() {
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {
			exceptions: {wrapperPairs: ['"|"', '“|”', '`|`'], protectedTerms: []},
			engines: {translator: "custom-m0bmatrix", backup: "----", customProviders: [{id: "custom-m0bmatrix", name: "Fixture"}]},
			performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1"},
			filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false, minimumAutoTranslateLength: 1, autoTranslateDecisionMode: "ai"},
			choices: {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}}
		},
		defaults: {choices: {received: {value: {input: "auto", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	try {plugin.onLoad();} catch {}
	plugin.settings.engines.translator = "custom-m0bmatrix";
	plugin.settings.engines.backup = "----";
	plugin.settings.engines.customProviders = [{id: "custom-m0bmatrix", name: "Fixture"}];
	plugin.settings.filters.autoTranslateDecisionMode = "ai";
	plugin.shouldUseAtomicSemanticRevision = () => false;
	try {plugin.setLanguages();} catch {}
	plugin.ensureSettingsStore().replaceAuthKeys({"custom-m0bmatrix": {key: "fixture-key", endpoint: "https://m0b.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.isTranslationEnabled = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.isOwnMessage = message => !!(message && message.author && message.author.id === "current-user");
	plugin.getCachedReceivedTranslation = () => null;
	plugin.getCachedReceivedSkipDecision = () => null;
	plugin.getAutoTranslatedResultRejectReason = () => null;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	plugin.commitReceivedDisplayResult = () => Promise.resolve({committedIds: [], confirmedIds: [], deferredIds: []});
	plugin.applyStoredTranslationToMessage = () => {};
	plugin.scheduleReceivedDisplayFlush = () => {};
	plugin.openAiCompatibleTranslate = (data, callback) => {
		const placeholders = [...String(data.text || "").matchAll(/⟦\d+⟧/g)].map(match => match[0]);
		callback(["翻译内容", ...placeholders].join(" "));
	};
	return plugin;
}

const received = id => ({id, channel_id: "m0b-matrix", content: original14Markdown, embeds: [], attachments: [], author: {id: "other-user"}});

test("S8b M0b controlled received auto closes custom auto-single and source-filter cells", async () => {
	const plugin = createMatrixPlugin();
	const eligibleMessage = received("auto-cell");
	const eligible = plugin.getReceivedAutoTranslateEligibility(eligibleMessage, {id: "m0b-matrix"}, plugin.extractOriginalContentData(eligibleMessage), true);
	assert.equal(eligible.eligible, true); assert.equal(eligible.reason, "plan_translate");
	const selfAuthored = plugin.getReceivedAutoTranslateEligibility(Object.assign({}, eligibleMessage, {id: "self-cell", author: {id: "current-user"}}), {id: "m0b-matrix"}, null, true);
	assert.deepEqual(selfAuthored, {eligible: false, reason: "self_authored"});
	assert.equal(await plugin.translateMessage(eligibleMessage, {id: "m0b-matrix"}, {auto: true, silent: true, trackBusy: false}), true);
	const snapshot = plugin.getTranslationTerminalLedgerSnapshot(), target = snapshot.recent.find(item => item.lane === "auto-single" && item.placeholderOccurrences === 8);
	assert.ok(target, JSON.stringify(snapshot.currentBehaviorMatrix));
	assert.equal(target.engineFamily, "custom"); assert.equal(target.decisionApplied, false); assert.equal(target.promptFamily, "single-manual"); assert.equal(target.validatorFamily, "manual-received");
	assert.equal(target.outcome, "translated"); assert.equal(target.stage, "display-currentness"); assert.equal(target.reason, "committed");
	assert.equal(target.providerDispatchCount, 1); assert.deepEqual(target.providerRoles, {primary: 1}); assert.equal(target.cacheRead, "miss"); assert.equal(target.cacheWrite, "translation");
	assert.equal(target.ruleCounts["fenced-code"], 1, JSON.stringify(target.ruleCounts)); assert.equal(target.ruleCounts["configured-or-wrapper"], 1, JSON.stringify(target.ruleCounts)); assert.equal(target.ruleCounts["auto-slash-token"], 1, JSON.stringify(target.ruleCounts)); assert.equal(target.ruleCounts["auto-hyphen-token"], 5, JSON.stringify(target.ruleCounts));
	const sourceFilterCell = snapshot.currentBehaviorMatrix.rows.find(row => row.sourceFilterReason === "self_authored");
	assert.ok(sourceFilterCell); assert.equal(sourceFilterCell.providerDispatchCount, 0); assert.equal(sourceFilterCell.outcome, "skipped");
});

test("S8b M0b exact single-family matrix covers manual reply sent embed and translation cache", async () => {
	const plugin = createMatrixPlugin(), channel = {id: "m0b-matrix"};
	assert.equal(await plugin.translateMessage(received("manual-cell"), channel, {manual: true, silent: true, trackBusy: false}), true);
	await new Promise(resolve => plugin.translateText(original14Markdown, "received", () => resolve(), null, {showToast: false, showFailureToast: false, trackBusy: false, terminalLane: "reply", terminalEntry: "reply-preview"}));
	await new Promise(resolve => plugin.translateText(original14Markdown, "sent", () => resolve(), null, {showToast: false, showFailureToast: false, trackBusy: false}));
	const embedMessage = Object.assign(received("embed-cell"), {embeds: [{title: "Financial Aid", description: "Degree requirements"}]});
	assert.equal(await plugin.translateMessage(embedMessage, channel, {manual: true, silent: true, trackBusy: false}), true);
	const cachedMessage = received("cache-cell"), signature = plugin.createReceivedTranslationSignature(cachedMessage, channel.id, plugin.extractOriginalContentData(cachedMessage));
	plugin.getCachedReceivedTranslation = message => message && message.id === cachedMessage.id ? {signature, translatedContent: "缓存译文", originalContent: original14Markdown, content: "缓存译文", embeds: {}, input: {id: "en"}, output: {id: "zh-CN"}} : null;
	assert.equal(await plugin.translateMessage(cachedMessage, channel, {manual: true, silent: true, trackBusy: false}), true);
	const routes = plugin.getTranslationTerminalLedgerSnapshot().recent;
	const exact = routes.filter(route => route.placeholderOccurrences === 8);
	for (const lane of ["manual", "reply", "sent"]) assert.ok(exact.some(route => route.lane === lane), lane);
	assert.ok(exact.some(route => route.laneTags["embed-forward"] === 1 && route.shape === "embed-forward"));
	const cache = routes.find(route => route.reason === "translation_hit"); assert.ok(cache); assert.equal(cache.cacheRead, "translation-hit"); assert.equal(cache.providerDispatchCount, 0); assert.equal(cache.displayCommit, "cache-applied");
	assert.equal(exact.every(route => route.ruleCounts["auto-slash-token"] === 1 && route.ruleCounts["auto-uppercase-token"] === undefined && route.ruleCounts["auto-hyphen-token"] === 5), true);
});

test("S8b M0b exact historical primary repairs only the missing item before one atomic commit", async () => {
	const plugin = createMatrixPlugin(), channelId = "m0b-history", calls = [], views = new Map();
	plugin.settings.performance.historicalConcurrency = "1";
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "custom-m0bmatrix";
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin); plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false})); const ids = results.map(result => String(result.messageId)); return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});};
	let batchCall = 0;
	plugin.requestAiBatchTranslationDetailed = (_engine, prepared, timingContext) => {
		batchCall++; const ids = prepared.map(item => String(item.message.id)); calls.push({role: timingContext && timingContext.role || "primary", ids});
		const valid = item => `译文 ${[...String(item.protectedText).matchAll(/⟦\d+⟧/g)].map(match => match[0]).join(" ")}`;
		if (batchCall === 1) return Promise.resolve({translations: {[ids[0]]: valid(prepared[0]), [ids[1]]: valid(prepared[1]), [ids[2]]: "丢失占位符", [ids[3]]: "丢失占位符", [ids[4]]: "__SKIP_TRANSLATION__"}, failureKind: null, statusCode: 200});
		return Promise.resolve({translations: {[ids[0]]: "仍丢失占位符", [ids[1]]: valid(prepared[1])}, failureKind: null, statusCode: 200});
	};
	for (const id of ["8100", "8101", "8102", "8103", "8104"]) {const item = Object.assign(received(id), {channel_id: channelId}); plugin.queueAutoTranslateMessage(item, {id: channelId}, {content: original14Markdown, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
	await plugin.startCollectedHistoricalTranslationJobs(channelId);
	const snapshot = plugin.getTranslationTerminalLedgerSnapshot(), history = snapshot.recent.filter(route => route.lane === "history-primary"), itemRepair = snapshot.recent.find(route => route.lane === "item-repair");
	assert.equal(history.length, 5); assert.ok(itemRepair); assert.equal(itemRepair.placeholderOccurrences, 8);
	assert.ok(history.some(route => route.laneTags["batch-repair"] === 1 && route.laneTags["item-repair"] === 1), JSON.stringify(history));
	assert.equal(history.every(route => route.placeholderOccurrences === 8), true);
	assert.equal(history.filter(route => route.outcome === "translated").length, 4); assert.equal(history.filter(route => route.outcome === "skipped").length, 1);
	assert.equal(history.every(route => route.displayCommit === "atomic"), true); assert.equal(calls.length, 2); assert.deepEqual(calls[1].ids, ["8102", "8103"]);
});

test("S8b M0b retained compatibility id is the AI-decision contrast, custom id is not", async () => {
	const plugin = createMatrixPlugin();
	assert.equal(plugin.supportsAiAutoTranslateDecisionEngine("custom-m0bmatrix"), false);
	assert.equal(plugin.supportsAiAutoTranslateDecisionEngine("oaicompat"), true);
	assert.equal(await plugin.translateMessage(received("custom-contrast"), {id: "m0b-matrix"}, {auto: true, silent: true, trackBusy: false}), true);
	plugin.settings.engines.translator = "oaicompat";
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-key", endpoint: "https://m0b.fixture/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.setLanguages();
	assert.equal(plugin.getEffectivePrimaryEngine("m0b-matrix"), "oaicompat"); assert.equal(plugin.isEngineConfiguredForRuntime("oaicompat"), true); assert.equal(plugin.shouldUseAiAutoTranslateDecision("m0b-matrix"), true);
	await new Promise(resolve => plugin.translateText("这是需要由兼容引擎判断是否翻译的中文内容。", "received", () => resolve(), null, {auto: true, showToast: false, showFailureToast: false, trackBusy: false, channelId: "m0b-matrix", terminalLane: "auto-single", terminalEntry: "received-auto"}));
	const rows = plugin.getTranslationTerminalLedgerSnapshot().recent.filter(route => route.lane === "auto-single");
	assert.deepEqual(rows.map(row => [row.engineFamily, row.decisionApplied, row.promptFamily, row.providerRoles]), [["custom", false, "single-manual", {primary: 1}], ["ai", true, "single-auto-decision", {primary: 1}]]);
});
