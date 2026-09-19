const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const response = (body, status = 200, retryAfter = null) => ({status, headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "retry-after" ? retryAfter : null}, text: () => Promise.resolve(body)});

// Exercise the real bundle's history intake, failed-snapshot ledger, retry and provider
// admission. Only external transport, rendering, classification and persistence boundaries
// are fixtures; no health/reset/retry method is replaced or inspected through a fake owner.
function createHarness() {
	const calls = [], outcomes = new Map(), views = new Map(), disabledChannels = new Set();
	let sequence = 1000;
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		isTranslationEnabled: channelId => !disabledChannels.has(channelId),
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: true, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
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
	plugin.setHistoricalBatchExperimentConcurrency(4);
	function select(host, status = 200) {
		outcomes.set(host, status);
		plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: `https://${host}/v1/chat/completions`, model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	}
	async function history(channelId) {
		const item = {id: String(++sequence), channel_id: channelId, content: `Historical retry isolation fixture ${sequence}.`, embeds: [], attachments: [], author: {id: "fixture-user"}};
		plugin.queueAutoTranslateMessage(item, {id: channelId}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
		await plugin.startCollectedHistoricalTranslationJobs(channelId);
		return item;
	}
	function budget() {return plugin.getHistoricalBatchPerformanceSnapshot().providerBudget;}
	return {plugin, calls, outcomes, select, history, budget, disabledChannels, count: host => calls.filter(value => value === host).length, async close() {
		try {await plugin.onStop();}
		finally {delete global.BdApi.Net;}
		assert.deepEqual(budget().resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
	}};
}

test("2b explicit history retry probes its auth key but preserves another channel's Retry-After", async () => {
	const fixture = createHarness(), {plugin} = fixture;
	try {
		fixture.select("retry-a.invalid", 401);
		await fixture.history("retry-channel-a");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-channel-a"), 1);
		fixture.select("retry-b.invalid", 429);
		await fixture.history("retry-channel-b");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-channel-b"), 1);
		assert.equal(fixture.budget().cooldownKeyCount, 2);
		fixture.select("retry-a.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("retry-channel-a"), true);
		assert.equal(fixture.count("retry-a.invalid"), 2, "the failed auth key receives its requested probe");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-channel-a"), 0);
		assert.equal(fixture.count("retry-b.invalid"), 1);
		fixture.select("retry-b.invalid");
		await fixture.history("retry-channel-b-fresh");
		assert.equal(fixture.count("retry-b.invalid"), 1, "an unrelated Retry-After remains effective after retrying A");
		assert.equal(fixture.budget().cooldownKeyCount, 1);
	}
	finally {await fixture.close();}
});

test("2b retrying the rate-limited history itself preserves its active Retry-After", async () => {
	const fixture = createHarness(), {plugin} = fixture;
	try {
		fixture.select("retry-rate.invalid", 429);
		await fixture.history("retry-rate-channel");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-rate-channel"), 1);
		fixture.select("retry-rate.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("retry-rate-channel"), true, "the retry is collected even though admission is still cooling");
		assert.equal(fixture.count("retry-rate.invalid"), 1, "manual retry sends no request inside Retry-After");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-rate-channel"), 1);
		assert.equal(fixture.budget().cooldownKeyCount, 1);
	}
	finally {await fixture.close();}
});

for (const mode of ["disabled", "no-failure", "intake-blocked"]) {
	test(`2b ${mode} retry changes neither health nor transport activity`, async () => {
		const fixture = createHarness(), {plugin} = fixture;
		try {
			fixture.select("retry-rejected.invalid", 401);
			await fixture.history("retry-rejected-channel");
			assert.equal(fixture.budget().cooldownKeyCount, 1);
			if (mode === "disabled") fixture.disabledChannels.add("retry-rejected-channel");
			if (mode === "intake-blocked") plugin.getHistoricalTranslationJobQueue("retry-rejected-channel").intakeBlocked = true;
			const channelId = mode === "no-failure" ? "retry-empty-channel" : "retry-rejected-channel";
			assert.equal(await plugin.retryFailedHistoricalTranslations(channelId), false);
			assert.equal(fixture.count("retry-rejected.invalid"), 1);
			assert.equal(fixture.budget().cooldownKeyCount, 1, "no accepted retry means no probe/reset side effect");
			assert.equal(plugin.getFailedHistoricalTranslationCount("retry-rejected-channel"), 1);
		}
		finally {await fixture.close();}
	});
}

test("2b changed configuration cannot probe an unrelated key and refreshes the failed item's captured association", async () => {
	const fixture = createHarness(), {plugin} = fixture;
	try {
		fixture.select("retry-config-a.invalid", 401);
		await fixture.history("retry-config-channel-a");
		const registry = plugin.ensureHistoricalJobRegistry();
		const keysA = [].concat(registry.getFailedSnapshot("retry-config-channel-a").items[0].historicalRetryTransportKeys || []);
		fixture.select("retry-config-b.invalid", 401);
		await fixture.history("retry-config-channel-b");
		const keysB = [].concat(registry.getFailedSnapshot("retry-config-channel-b").items[0].historicalRetryTransportKeys || []);
		fixture.select("retry-config-b.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("retry-config-channel-a"), true);
		assert.equal(fixture.count("retry-config-b.invalid"), 1, "A's old association does not release B's independent cooldown");
		assert.equal(fixture.budget().cooldownKeyCount, 2, "neither the unused old key nor the unrelated actual key was reset");
		assert.equal(keysA.length, 1);
		assert.equal(keysB.length, 1);
		assert.notDeepEqual(keysA, keysB);
		const refreshedKeys = registry.getFailedSnapshot("retry-config-channel-a").items[0].historicalRetryTransportKeys;
		assert.deepEqual(refreshedKeys, keysB, "the new admission denial captures only the current B failure, not stale A");
		assert.equal(await plugin.retryFailedHistoricalTranslations("retry-config-channel-a"), true);
		assert.equal(fixture.count("retry-config-b.invalid"), 2, "the newly associated B can be probed on the next explicit retry");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-config-channel-a"), 0);
		fixture.select("retry-config-a.invalid");
		await fixture.history("retry-config-channel-a-fresh");
		assert.equal(fixture.count("retry-config-a.invalid"), 1, "the prior A cooldown remains intact throughout the B retries");
	}
	finally {await fixture.close();}
});

test("2b a legacy failed snapshot with no captured key retries normally without resetting health", async () => {
	const fixture = createHarness(), {plugin} = fixture;
	try {
		fixture.select("retry-legacy.invalid", 401);
		await fixture.history("retry-legacy-channel");
		const registry = plugin.ensureHistoricalJobRegistry();
		const legacy = JSON.parse(JSON.stringify(registry.getFailedSnapshot("retry-legacy-channel")));
		for (const item of legacy.items) delete item.historicalRetryTransportKeys;
		registry.setFailedSnapshot("retry-legacy-channel", legacy);
		fixture.select("retry-legacy.invalid");
		assert.equal(await plugin.retryFailedHistoricalTranslations("retry-legacy-channel"), true);
		assert.equal(fixture.count("retry-legacy.invalid"), 1, "unknown association does not guess or globally reset a provider key");
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-legacy-channel"), 1);
		assert.equal(fixture.budget().cooldownKeyCount, 1);
		const captured = registry.getFailedSnapshot("retry-legacy-channel").items[0].historicalRetryTransportKeys;
		assert.equal(captured.length, 1, "the real denied request establishes a current association");
		assert.match(captured[0], /^tk1:/);
		assert.equal(await plugin.retryFailedHistoricalTranslations("retry-legacy-channel"), true);
		assert.equal(fixture.count("retry-legacy.invalid"), 2);
		assert.equal(plugin.getFailedHistoricalTranslationCount("retry-legacy-channel"), 0);
	}
	finally {await fixture.close();}
});
