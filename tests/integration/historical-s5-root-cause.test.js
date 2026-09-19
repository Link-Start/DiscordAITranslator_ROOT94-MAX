const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const settle = () => new Promise(resolve => setImmediate(resolve));
const message = id => ({id: String(id), channel_id: "s5-history", content: `Historical fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}});
const response = (body, status = 200, retryAfter = null) => ({status, headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "retry-after" ? retryAfter : null}, text: () => Promise.resolve(body)});

function configure(plugin, {backup = "----"} = {}) {
	plugin.shouldUseAtomicSemanticRevision = () => false;
	plugin.settings.engines.translator = "oaicompat";
	plugin.settings.engines.backup = backup;
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
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
	const views = new Map();
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);
}

test("S5 429 and 5xx block only the failed key while healthy backup bypasses HOL", async () => {
	for (const mode of ["rate_limit", "server"]) {
		let fetches = 0, backupRequests = 0;
		const plugin = createPluginInstance({
			pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
			callSetLanguages: false,
			settings: {engines: {translator: "oaicompat", backup: "googleapi"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
			defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
			bdfdb: {LibraryRequires: {request(_url, _options, callback) {backupRequests++; setImmediate(() => callback(null, {statusCode: 200}, JSON.stringify({src: "en", sentences: [{trans: `备用译文-${backupRequests}`}]})));}}}
		});
		global.BdApi.Net = {fetch: async () => {fetches++; return response("{}", mode === "rate_limit" ? 429 : 503, mode === "rate_limit" ? "2" : null);}};
		plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://fixture.test/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
		configure(plugin, {backup: "googleapi"});
		try {
			for (const id of ["101", "102"]) {const item = message(id); plugin.queueAutoTranslateMessage(item, {id: "s5-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
			await plugin.startCollectedHistoricalTranslationJobs("s5-history");
			assert.equal(fetches, 1, `${mode}: failed primary key dispatches once`);
			assert.equal(backupRequests, 2, `${mode}: both items bypass to healthy backup without same-key retry`);
			const snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
			assert.equal(snapshot.latestRun.translatedCount, 2);
			assert.equal(mode === "rate_limit" ? snapshot.providerBudget.rateLimitCount : snapshot.providerBudget.serverCooldownCount, 1);
			assert.equal(snapshot.providerBudget.cooldownKeyCount, 1);
			assert.equal(snapshot.learnedTier, 2);
			assert.equal(snapshot.promotionEvidence, 0);
			assert.equal(snapshot.effectiveCap, 1);
			assert.equal(snapshot.effectiveReason, mode === "rate_limit" ? "rate_limit" : "server");
			assert.ok(snapshot.cooldownRemainingMs > 0);
			assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
		}
		finally {delete global.BdApi.Net;}
	}
});

test("S5 migrated timeout bisects the original failed block once after physical abort", async () => {
	const timers = [];
	const fetches = [];
	let firstSignal = null;
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {TimeUtils: {timeout(callback, delay) {const timer = {callback, delay, cleared: false}; timers.push(timer); return timer;}, clear(timer) {if (timer) timer.cleared = true;}, interval: (callback, delay) => setInterval(callback, delay)}, LibraryRequires: {request() {throw new Error("timeout split stays on native batch transport");}}}
	});
	global.BdApi.Net = {fetch: (_url, options) => {
		const input = JSON.parse(options.body).messages[1].content;
		const ids = [...input.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]).filter(id => ["101", "102", "103", "104"].includes(id));
		fetches.push({ids, parentActiveAtDispatch: firstSignal ? !firstSignal.aborted : null});
		if (fetches.length === 1) {
			firstSignal = options.signal;
			return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")), {once: true}));
		}
		return Promise.resolve(response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]})));
	}};
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://fixture.test/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	configure(plugin);
	try {
		for (const id of ["101", "102", "103", "104"]) {const item = message(id); plugin.queueAutoTranslateMessage(item, {id: "s5-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});}
		const running = plugin.startCollectedHistoricalTranslationJobs("s5-history");
		while (!firstSignal) await settle();
		const timeoutTimer = timers.find(timer => timer.delay === 30000 && !timer.cleared);
		assert.ok(timeoutTimer);
		timeoutTimer.callback();
		await running;
		assert.equal(firstSignal.aborted, true);
		assert.deepEqual(fetches.map(entry => entry.ids.length), [4, 2, 2]);
		assert.equal(fetches.slice(1).every(entry => entry.parentActiveAtDispatch === false), true);
		assert.equal(fetches.some(entry => entry.ids.length === 4 && entry !== fetches[0]), false, "original timeout block is never replayed intact");
		const snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
		assert.equal(snapshot.latestRun.translatedCount, 4);
		assert.equal(snapshot.latestRun.h1.attempts[0].physicalAbort, true);
		assert.equal(snapshot.latestRun.repairBatchRequests, 2);
		assert.equal(snapshot.configuredConcurrency, 4, "fixed4 target is preserved");
		assert.ok(snapshot.adaptivePressureCount >= 1);
		assert.deepEqual(snapshot.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
		assert.equal(plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
	}
	finally {delete global.BdApi.Net;}
});
