const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const response = (body, status = 200, retryAfter = null) => ({status, headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "retry-after" ? retryAfter : null}, text: () => Promise.resolve(body)});

// Exercise the real bundle's history intake, failed-snapshot retry, provider admission
// and adaptive owner. Transport, rendering, classification and persistence are boundary
// fixtures: successful transport here is not an end-to-end translation-quality claim.
function createHarness({mode = "auto"} = {}) {
	const calls = [], outcomes = new Map(), views = new Map(), disabledChannels = new Set();
	let sequence = 1000;
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		isTranslationEnabled: channelId => !disabledChannels.has(channelId),
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: mode, historicalSafetyDownshift: true, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}
	});
	try {plugin.onLoad();} catch (error) {assert.match(error.message, /_translatortranslatebutton/);}
	plugin.shouldUseAtomicSemanticRevision = () => false;
	global.BdApi.Net = {fetch: async (url, options) => {
		const host = new URL(url).hostname;
		calls.push(host);
		const status = outcomes.get(host) || 200;
		if (status === 429) return response("{}", 429, "600");
		if (status !== 200) return response(JSON.stringify({error: {message: "Invalid API key", type: "authentication_error"}}), status);
		const prompt = JSON.parse(options.body).messages[1].content;
		const ids = [...new Set([...prompt.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]).filter(id => /^\d+$/.test(id)))];
		return response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}]}));
	}};
	plugin.settings.engines.translator = "oaicompat";
	plugin.settings.engines.backup = "----";
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.validateHistoricalTranslationJobResult = (prepared, rawTranslation, job) => rawTranslation == null ? {ok: false} : {ok: true, translation: {channelId: job.channelId, auto: true, content: String(rawTranslation), translatedContent: String(rawTranslation), originalContent: prepared.originalContentData && prepared.originalContentData.content || "", signature: prepared.signature, input: prepared.input, output: prepared.output}};
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(mode);
	function select(host, status = 200) {
		outcomes.set(host, status);
		plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: `https://${host}/v1/chat/completions`, model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	}
	async function history(channelId, count = 1) {
		let item;
		for (let index = 0; index < count; index++) {
			item = {id: String(++sequence), channel_id: channelId, content: `Historical adaptive recovery fixture ${sequence}.`, embeds: [], attachments: [], author: {id: "fixture-user"}};
			plugin.queueAutoTranslateMessage(item, {id: channelId}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
		}
		await plugin.startCollectedHistoricalTranslationJobs(channelId);
		return item;
	}
	function budget() {return plugin.getHistoricalBatchPerformanceSnapshot().providerBudget;}
	return {plugin, calls, outcomes, select, history, budget, disabledChannels, count: host => calls.filter(value => value === host).length, async close() {
		try {await plugin.onStop();}
		finally {delete global.BdApi.Net;}
		assert.deepEqual(budget().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
		const stopped = plugin.getHistoricalBatchPerformanceSnapshot();
		assert.deepEqual(stopped.adaptiveResources, {keys: 0, observations: 0});
		assert.deepEqual({active: stopped.physical.active, waiting: stopped.physical.waiting}, {active: 0, waiting: 0});
		assert.equal(stopped.historicalAbortControllerCount, 0);
	}};
}

test("2c successful manual auth retry releases Auto's permanent cap of one without jumping to four", async () => {
	const fixture = createHarness(), {plugin} = fixture;
	try {
		fixture.select("recover-auto.invalid", 401);
		await fixture.history("recover-auto-failed");
		assert.equal(plugin.getFailedHistoricalTranslationCount("recover-auto-failed"), 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, "auth");
		fixture.select("recover-auto.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("recover-auto-failed"), true);
		assert.equal(fixture.count("recover-auto.invalid"), 2);
		assert.equal(plugin.getFailedHistoricalTranslationCount("recover-auto-failed"), 0);
		assert.equal(fixture.budget().cooldownKeyCount, 0);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 2, "confirmed same-key transport recovery must release the sticky adaptive cap");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 0, "one probe does not inherit pre-failure promotion evidence");
	}
	finally {await fixture.close();}
});

for (const mode of ["auto", "4"]) {
	test(`2c ${mode} recovers 2 → 3 → 4 only after separate clean saturated jobs`, async () => {
		const fixture = createHarness({mode}), {plugin} = fixture;
		try {
			fixture.select("recover-progress.invalid");
			if (mode === "auto") {
				for (let index = 0; index < 4; index++) await fixture.history(`recover-warm-${index}`, 50);
				assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().learnedTier, 4, "Auto establishes a four-slot target before the incident");
			}
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 4);
			fixture.select("recover-progress.invalid", 401);
			await fixture.history("recover-progress-failed");
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
			fixture.select("recover-progress.invalid");
			assert.equal(await plugin.retryFailedHistoricalTranslations("recover-progress-failed"), true);
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 2, "one successful probe only returns to the cautious base tier");
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 0);
			for (let index = 0; index < 3; index++) await fixture.history(`recover-small-${index}`);
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 2, "small non-saturated jobs do not promote recovery");
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 0);
			const caps = [], evidence = [], dispatchedCaps = [];
			for (let index = 0; index < 4; index++) {
				await fixture.history(`recover-saturated-${index}`, 50);
				const snapshot = plugin.getHistoricalBatchPerformanceSnapshot();
				caps.push(snapshot.effectiveCap);
				evidence.push(snapshot.promotionEvidence);
				dispatchedCaps.push(snapshot.latestRun.maxActiveChunks);
				assert.equal(snapshot.configuredConcurrency, 4, "recovery does not rewrite the selected or learned target");
			}
			assert.deepEqual(caps, [2, 3, 3, 4], "two independent clean saturated jobs are required for each one-slot recovery step");
			assert.deepEqual(evidence, [1, 0, 1, 0]);
			assert.deepEqual(dispatchedCaps, [2, 2, 3, 3], "actual primary dispatch follows the cautious cap, not just its diagnostics");
			await fixture.history("recover-at-four", 50);
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().latestRun.maxActiveChunks, 4);
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, null);
			assert.equal(fixture.budget().cooldownKeyCount, 0);
		}
		finally {await fixture.close();}
	});
}

test("2c fixed one clears the recovered fault without raising the user's one-slot target", async () => {
	const fixture = createHarness({mode: "1"}), {plugin} = fixture;
	try {
		fixture.select("recover-fixed-one.invalid", 401);
		await fixture.history("recover-fixed-one-failed");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, "auth");
		fixture.select("recover-fixed-one.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("recover-fixed-one-failed"), true);
		assert.equal(plugin.getFailedHistoricalTranslationCount("recover-fixed-one-failed"), 0);
		assert.equal(fixture.budget().cooldownKeyCount, 0);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		assert.notEqual(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, "auth");
		for (let index = 0; index < 4; index++) {
			await fixture.history(`recover-fixed-one-clean-${index}`, 30);
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
			assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().configuredConcurrency, 1);
		}
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, null);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 0);
	}
	finally {await fixture.close();}
});

test("2c one auth key's recovery preserves a healthy key's learned tier and pending evidence", async () => {
	const fixture = createHarness(), {plugin} = fixture;
	try {
		fixture.select("recover-healthy-b.invalid");
		for (let index = 0; index < 3; index++) await fixture.history(`recover-healthy-b-${index}`, 50);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().learnedTier, 3);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 1);
		fixture.select("recover-failed-a.invalid", 401);
		await fixture.history("recover-failed-a-channel");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		fixture.select("recover-healthy-b.invalid");
		await fixture.history("recover-healthy-b-during-fault");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 3);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 1);
		assert.equal(fixture.budget().cooldownKeyCount, 1, "B's success does not release A's fault");
		fixture.select("recover-failed-a.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("recover-failed-a-channel"), true);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 2);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 0);
		fixture.select("recover-healthy-b.invalid");
		await fixture.history("recover-healthy-b-after-a");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 3);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 1, "recovering A preserves B's existing evidence");
		await fixture.history("recover-healthy-b-promotion", 50);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 4);
		assert.equal(fixture.budget().cooldownKeyCount, 0);
	}
	finally {await fixture.close();}
});

test("2c active Retry-After remains cap one despite explicit retry and another key's success", async () => {
	const fixture = createHarness({mode: "4"}), {plugin} = fixture;
	try {
		fixture.select("recover-rate.invalid", 429);
		await fixture.history("recover-rate-failed");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, "rate_limit");
		fixture.select("recover-rate.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("recover-rate-failed"), true);
		assert.equal(fixture.count("recover-rate.invalid"), 1, "rate-limited retry is rejected before transport");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		fixture.select("recover-rate-other.invalid");
		await fixture.history("recover-rate-other-clean", 50);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 4);
		fixture.select("recover-rate.invalid");
		await fixture.history("recover-rate-fresh");
		assert.equal(fixture.count("recover-rate.invalid"), 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, "rate_limit");
		assert.ok(plugin.getHistoricalBatchPerformanceSnapshot().cooldownRemainingMs > 0);
		assert.equal(fixture.budget().cooldownKeyCount, 1);
	}
	finally {await fixture.close();}
});

test("2c an unsuccessful manual probe retains the adaptive auth block", async () => {
	const fixture = createHarness({mode: "4"}), {plugin} = fixture;
	try {
		fixture.select("recover-still-auth.invalid", 401);
		await fixture.history("recover-still-auth-failed");
		assert.equal(await plugin.retryFailedHistoricalTranslations("recover-still-auth-failed"), true);
		assert.equal(fixture.count("recover-still-auth.invalid"), 2);
		assert.equal(plugin.getFailedHistoricalTranslationCount("recover-still-auth-failed"), 1);
		assert.equal(fixture.budget().cooldownKeyCount, 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveCap, 1);
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().effectiveReason, "auth");
		assert.equal(plugin.getHistoricalBatchPerformanceSnapshot().promotionEvidence, 0);
	}
	finally {await fixture.close();}
});
