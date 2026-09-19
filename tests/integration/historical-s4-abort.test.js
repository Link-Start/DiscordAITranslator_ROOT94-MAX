const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const settle = () => new Promise(resolve => setImmediate(resolve));

function message(id) {
	return {id: String(id), channel_id: "s4-history", content: `Historical fixture ${id}.`, embeds: [], attachments: [], author: {id: "fixture-user"}};
}

function response(body, status = 200) {
	return {status, headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : null}, text: () => Promise.resolve(body)};
}

function createFixture({fetchFunction, callbackRequest = () => {throw new Error("callback transport reached");}}) {
	const cacheWrites = [], commits = [], views = new Map();
	const plugin = createPluginInstance({
		pluginPath: process.env.DTA_PLUGIN_PATH || undefined,
		callSetLanguages: false,
		settings: {engines: {translator: "oaicompat", backup: "----"}, performance: {historicalConcurrency: "4", historicalSafetyDownshift: false, liveConcurrency: "1", liveStreaming: true}, filters: {receivedAutoTranslateScope: "loaded_messages", skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "auto", output: "en"}}},
		defaults: {choices: {received: {value: {input: "en", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}},
		bdfdb: {LibraryRequires: {request: callbackRequest}}
	});
	global.BdApi.Net = {fetch: fetchFunction};
	plugin.ensureSettingsStore().replaceAuthKeys({oaicompat: {key: "fixture-secret", endpoint: "https://fixture.test/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
	plugin.shouldUseAtomicSemanticRevision = () => false;
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "oaicompat";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.persistTranslationCacheEntry = (messageId, _signature, translation) => cacheWrites.push({messageId: String(messageId), translatedContent: translation && translation.translatedContent});
	plugin.persistReceivedSkipDecision = () => {};
	const originalView = plugin.getReceivedDisplayRuntimeView.bind(plugin);
	plugin.getReceivedDisplayRuntimeView = id => views.get(String(id)) || originalView(id);
	plugin.commitHistoricalReceivedDisplayBatch = results => {
		commits.push(results.map(result => ({messageId: String(result.messageId), status: result.status})));
		const ids = results.map(result => String(result.messageId));
		for (const result of results) views.set(String(result.messageId), Object.assign({}, result, {translated: result.status === "translated", showLoading: false}));
		return Promise.resolve({committedIds: ids, confirmedIds: ids, deferredIds: [], missingIds: [], retryIds: [], rejectedIds: [], staleIds: []});
	};
	plugin.setHistoricalBatchExperimentConcurrency(4);
	return {plugin, cacheWrites, commits};
}

test("S4 clean historical compatible batch uses native fetch and reports physical settle without abort", async () => {
	let fetches = 0;
	const fixture = createFixture({fetchFunction: async (_url, options) => {
		fetches++;
		const input = JSON.parse(options.body).messages[1].content;
		const ids = [...input.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
		return response(JSON.stringify({choices: [{message: {content: JSON.stringify(ids.map(id => ({id, translation: `译文-${id}`})))}, finish_reason: "stop"}], usage: {prompt_tokens: 20, completion_tokens: 5}}));
	}});
	try {
		for (const id of ["101", "102"]) {
			const item = message(id);
			assert.equal(fixture.plugin.queueAutoTranslateMessage(item, {id: "s4-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true}), true);
		}
		await fixture.plugin.startCollectedHistoricalTranslationJobs("s4-history");
		assert.equal(fetches, 1);
		assert.equal(fixture.commits.length, 1);
		assert.equal(fixture.cacheWrites.length, 2);
		const performance = fixture.plugin.getHistoricalBatchPerformanceSnapshot();
		assert.equal(performance.latestRun.h1.attempts[0].physicalAbort, false);
		assert.equal(performance.providerBudget.resources.active, 0);
		assert.equal(performance.physical.active, 0);
		assert.equal(performance.historicalAbortControllerCount, 0);
		assert.deepEqual(fixture.plugin.ensureProviderClient().getProviderAttemptSnapshot(), {generation: 0, active: 0, highWater: 1, controllerCount: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
	}
	finally {delete global.BdApi.Net;}
});

test("S4 edit and delete synchronously abort the parent and fence every continuation behind physical settle", async () => {
	for (const mode of ["edit", "delete"]) {
		const events = [];
		let fetchSignal = null;
		let fixture = null;
		fixture = createFixture({
			fetchFunction: (_url, options) => {
				fetchSignal = options.signal;
				return new Promise((_resolve, reject) => fetchSignal.addEventListener("abort", () => {events.push("parent-abort"); reject(new Error("aborted"));}, {once: true}));
			},
			callbackRequest: (_url, _options, callback) => {
				events.push(`child-active-${fixture.plugin.ensureProviderClient().getProviderAttemptSnapshot().active}`);
				setImmediate(() => callback(null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文-102"}, finish_reason: "stop"}]})));
			}
		});
		try {
			for (const id of ["101", "102"]) {
				const item = message(id);
				fixture.plugin.queueAutoTranslateMessage(item, {id: "s4-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
			}
			const running = fixture.plugin.startCollectedHistoricalTranslationJobs("s4-history");
			while (!fetchSignal) await settle();
			let lifecycle = null;
			if (mode === "edit") assert.equal(fixture.plugin.invalidateHistoricalTranslationMessage("101", "s4-history", "changed-signature"), true);
			else lifecycle = fixture.plugin.ensureMessageDeletionLifecycle().deleteMessage("101", "s4-history");
			assert.equal(fetchSignal.aborted, true, `${mode} aborts synchronously`);
			if (lifecycle) await lifecycle;
			await running;
			assert.equal(events[0], "parent-abort");
			if (events[1]) assert.equal(events[1], "child-active-0", "a derived request sees zero active parent attempts");
			assert.equal(fixture.commits.length, 1);
			assert.deepEqual(fixture.cacheWrites, [], "the aborted parent body writes zero cache");
			const performance = fixture.plugin.getHistoricalBatchPerformanceSnapshot();
			assert.equal(performance.latestRun.h1.attempts.find(attempt => attempt.role === "primary").physicalAbort, true);
			const repairAttempt = performance.latestRun.h1.attempts.find(attempt => attempt.role === "repair");
			if (repairAttempt) assert.equal(repairAttempt.physicalAbort, null, "unmigrated single repair stays honest");
			assert.deepEqual(performance.providerBudget.resources, {active: 0, waiting: 0, logicals: 0, keys: 0});
			assert.equal(performance.physical.active, 0);
			assert.equal(performance.historicalAbortControllerCount, 0);
			assert.equal(fixture.plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
		}
		finally {delete global.BdApi.Net;}
	}
});

test("S4 channel switch and plugin stop synchronously abort the physical historical attempt", async () => {
	for (const mode of ["channel-switch", "plugin-stop"]) {
		let fetchSignal = null;
		const fixture = createFixture({fetchFunction: (_url, options) => {
			fetchSignal = options.signal;
			return new Promise((_resolve, reject) => fetchSignal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
		}});
		try {
			for (const id of ["101", "102"]) {
				const item = message(id);
				fixture.plugin.queueAutoTranslateMessage(item, {id: "s4-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
			}
			const running = fixture.plugin.startCollectedHistoricalTranslationJobs("s4-history");
			while (!fetchSignal) await settle();
			const stopping = mode === "plugin-stop" ? fixture.plugin.onStop() : (fixture.plugin.cancelHistoricalTranslationJobs("s4-history", "channel-switch"), null);
			assert.equal(fetchSignal.aborted, true);
			if (stopping) await stopping;
			await running;
			assert.deepEqual(fixture.cacheWrites, []);
			assert.deepEqual(fixture.commits, []);
			const resources = fixture.plugin.ensureProviderClient().getProviderAttemptSnapshot();
			assert.equal(resources.active, 0);
			assert.equal(resources.controllerCount, 0);
			assert.equal(resources.readerCount, 0);
			assert.equal(resources.timerCount, 0);
			assert.equal(resources.logicalSignalCount, 0);
		}
		finally {delete global.BdApi.Net;}
	}
});

test("S4 late body after channel cancellation writes zero trace resurrection store DOM and cache", async () => {
	let fetchSignal = null, resolveFetch = null;
	const lateBody = JSON.stringify({choices: [{message: {content: JSON.stringify([{id: "101", translation: "迟到甲"}, {id: "102", translation: "迟到乙"}])}}]});
	const fixture = createFixture({fetchFunction: (_url, options) => {
		fetchSignal = options.signal;
		return new Promise(resolve => {resolveFetch = () => resolve(response(lateBody));});
	}});
	try {
		for (const id of ["101", "102"]) {
			const item = message(id);
			fixture.plugin.queueAutoTranslateMessage(item, {id: "s4-history"}, {content: item.content, embeds: []}, {historicalLoad: true, deferHistoricalSnapshotStart: true});
		}
		let settled = false;
		const running = fixture.plugin.startCollectedHistoricalTranslationJobs("s4-history").finally(() => {settled = true;});
		while (!fetchSignal) await settle();
		fixture.plugin.cancelHistoricalTranslationJobs("s4-history", "channel-switch");
		assert.equal(fetchSignal.aborted, true);
		await settle();
		assert.equal(settled, false, "ignored-abort fixture keeps the physical parent unsettled");
		assert.deepEqual(fixture.cacheWrites, []);
		assert.deepEqual(fixture.commits, []);
		resolveFetch();
		await running;
		assert.deepEqual(fixture.cacheWrites, []);
		assert.deepEqual(fixture.commits, []);
		assert.equal(fixture.plugin.getHistoricalBatchPerformanceSnapshot().latestRun.h1.attempts[0].physicalAbort, true);
		const resources = fixture.plugin.ensureProviderClient().getProviderAttemptSnapshot();
		assert.equal(resources.active, 0);
		assert.equal(resources.controllerCount, 0);
		assert.equal(resources.timerCount, 0);
		assert.equal(resources.logicalSignalCount, 0);
	}
	finally {delete global.BdApi.Net;}
});
