const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createPluginInstance} = require("./helpers/createPluginInstance");

function createMessage(id, content) {
	return {
		id,
		channel_id: "channel-history-job",
		content,
		embeds: [],
		author: {id: "other-user"}
	};
}

function installFakeClock() {
	const realDateNow = Date.now;
	const realSetTimeout = global.setTimeout;
	const realClearTimeout = global.clearTimeout;
	let now = 0;
	let nextTimerId = 1;
	const timers = new Map();
	const flushAsyncWork = () => new Promise(resolve => setImmediate(resolve));

	Date.now = () => now;
	global.setTimeout = (callback, delay = 0) => {
		const timerId = nextTimerId++;
		timers.set(timerId, {callback, time: now + Math.max(0, delay)});
		return timerId;
	};
	global.clearTimeout = timerId => timers.delete(timerId);

	return {
		async advanceTime(milliseconds) {
			const targetTime = now + milliseconds;
			while (true) {
				const nextTimer = [...timers.entries()]
					.filter(([, timer]) => timer.time <= targetTime)
					.sort((left, right) => left[1].time - right[1].time)[0];
				if (!nextTimer) break;
				now = nextTimer[1].time;
				timers.delete(nextTimer[0]);
				nextTimer[1].callback();
				await flushAsyncWork();
			}
			now = targetTime;
			await flushAsyncWork();
		},
		restore() {
			Date.now = realDateNow;
			global.setTimeout = realSetTimeout;
			global.clearTimeout = realClearTimeout;
		}
	};
}

test("legacy historical queue runtime is absent after coordinator migration", () => {
	const source = fs.readFileSync(path.resolve(__dirname, "..", "DiscordAITranslator.plugin.js"), "utf8");
	const removedRuntimeNames = [
		"canQueueHistoricalItem",
		"enqueueHistoricalItem",
		"beginHistoricalBatchIfNeeded",
		"ensureHistoricalChannelActive",
		"markHistoricalQueueItemProcessed",
		"handleHistoricalOutOfRange",
		"handleHistoricalPauseOrBatch",
		"retryHistoricalQueueItemIfTransient",
		"getHistoricalAiBatchContext",
		"selectHistoricalAiBatchItems",
		"processHistoricalPreparedItems",
		"applyHistoricalAiBatchResultMap",
		"requestHistoricalAiBatch",
		"processHistoricalAutoTranslationBatchChunk",
		"stageHistoricalAutoTranslationResult",
		"applyHistoricalAutoTranslationStaging",
		"flushHistoricalAutoTranslationProgress",
		"finishHistoricalAutoTranslationBatchIfDone",
		"scheduleLoadedAutoTranslationScrollRescan",
		"scheduleLoadedAutoTranslationPostBatchRescan",
		"requeueHistoricalAiBatchFallbackItems"
	];

	for (const runtimeName of removedRuntimeNames) {
		assert.doesNotMatch(source, new RegExp(`\\b${runtimeName}\\b`), `${runtimeName} should be removed`);
	}
});

test("historical job commits all translated IDs atomically with one rerender", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const appliedIds = [];
	let rerenderCount = 0;
	let resolveBatch;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-1",
		channelId: "channel-history-job",
		generation: 1,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => new Promise(resolve => {
				resolveBatch = resolve;
			}),
			validate: (item, translatedText) => ({
				ok: true,
				translation: {messageId: item.message.id, translatedContent: translatedText}
			}),
			repair: () => ({status: "failed", reason: "unexpected-repair"}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: summary => {
				appliedIds.push(...summary.translated.map(item => item.message.id));
			},
			rerender: () => {
				rerenderCount++;
			}
		}
	});

	job.add(createMessage("100", "first"));
	job.add(createMessage("200", "second"));
	const running = job.start();
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.deepEqual(appliedIds, []);
	assert.equal(rerenderCount, 0);
	assert.equal(job.isMessagePending("100"), true);
	assert.equal(job.isMessagePending("200"), true);

	resolveBatch({"100": "first translated", "200": "second translated"});
	await running;

	assert.deepEqual(appliedIds, ["100", "200"]);
	assert.equal(rerenderCount, 1);
	assert.equal(job.state, "committed");
});

test("historical job repairs missing IDs before the atomic commit", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const repairIds = [];
	let committedSummary = null;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-repair",
		channelId: "channel-history-job",
		generation: 2,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => Promise.resolve({"100": "first translated"}),
			validate: (item, translatedText) => translatedText ? {
				ok: true,
				translation: {messageId: item.message.id, translatedContent: translatedText}
			} : {ok: false},
			repair: item => {
				repairIds.push(item.message.id);
				return Promise.resolve({
					status: "translated",
					translation: {messageId: item.message.id, translatedContent: "repaired translation"}
				});
			},
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: summary => {
				committedSummary = summary;
			},
			rerender: () => {}
		}
	});

	job.add(createMessage("100", "first"));
	job.add(createMessage("200", "second"));
	await job.start();

	assert.deepEqual(repairIds, ["200"]);
	assert.equal(committedSummary.translated.length, 2);
	assert.equal(committedSummary.failed.length, 0);
});

test("historical job retries unresolved items in a smaller batch before single repair", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const smallerBatchIds = [];
	const singleRepairIds = [];
	let committedSummary = null;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-smaller-repair",
		channelId: "channel-history-job",
		generation: 3,
		repairBatchSize: 2,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => Promise.resolve({"100": "first translated"}),
			repairBatch: items => {
				smallerBatchIds.push(items.map(item => item.message.id));
				return Promise.resolve({"200": "second translated"});
			},
			validate: (item, translatedText) => translatedText ? {
				ok: true,
				translation: {messageId: item.message.id, translatedContent: translatedText}
			} : {ok: false},
			repair: item => {
				singleRepairIds.push(item.message.id);
				return Promise.resolve({
					status: "translated",
					translation: {messageId: item.message.id, translatedContent: "single repaired"}
				});
			},
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: summary => {
				committedSummary = summary;
			},
			rerender: () => {}
		}
	});

	for (const id of ["100", "200", "300"]) job.add(createMessage(id, `message ${id}`));
	await job.start();

	assert.deepEqual(smallerBatchIds, [["200", "300"]]);
	assert.deepEqual(singleRepairIds, ["300"]);
	assert.deepEqual(committedSummary.translated.map(item => item.message.id), ["100", "200", "300"]);
});

test("historical repair requests run with bounded concurrency before one commit", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const repairResolvers = [];
	const startedIds = [];
	let commitCount = 0;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-concurrent-repair",
		channelId: "channel-history-job",
		generation: 2,
		repairConcurrency: 2,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => Promise.resolve(null),
			validate: () => ({ok: false}),
			repair: item => new Promise(resolve => {
				startedIds.push(item.message.id);
				repairResolvers.push(() => resolve({status: "translated", translation: {translatedContent: item.message.id}}));
			}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: () => {
				commitCount++;
			},
			rerender: () => {}
		}
	});

	job.add(createMessage("100", "first"));
	job.add(createMessage("200", "second"));
	const running = job.start();
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.deepEqual(startedIds, ["100", "200"]);
	repairResolvers.forEach(resolve => resolve());
	await running;
	assert.equal(commitCount, 1);
});

test("cancelled historical job ignores late provider results", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	let resolveBatch;
	let commitCount = 0;
	let rerenderCount = 0;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-cancel",
		channelId: "channel-history-job",
		generation: 3,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => new Promise(resolve => {
				resolveBatch = resolve;
			}),
			validate: (_item, translatedText) => ({ok: true, translation: {translatedContent: translatedText}}),
			repair: () => ({status: "failed"}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: () => {
				commitCount++;
			},
			rerender: () => {
				rerenderCount++;
			}
		}
	});

	job.add(createMessage("100", "first"));
	const running = job.start();
	await new Promise(resolve => setTimeout(resolve, 0));
	job.cancel("channel-disabled");
	resolveBatch({"100": "late translation"});
	await running;

	assert.equal(job.state, "cancelled");
	assert.equal(commitCount, 0);
	assert.equal(rerenderCount, 0);
	assert.equal(job.isMessagePending("100"), false);
});

test("editing one historical item invalidates only that item before commit", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	let resolveBatch;
	let committedSummary = null;
	let rerenderCount = 0;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-edit-one",
		channelId: "channel-history-job",
		generation: 4,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => new Promise(resolve => {
				resolveBatch = resolve;
			}),
			validate: (item, translatedText) => ({ok: true, translation: {messageId: item.message.id, translatedContent: translatedText}}),
			repair: () => ({status: "failed"}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: summary => {
				committedSummary = summary;
			},
			rerender: () => {
				rerenderCount++;
			}
		}
	});

	job.add(createMessage("100", "old text"));
	job.add(createMessage("200", "stable text"));
	const running = job.start();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(job.invalidateMessage("100", "source-edited"), true);

	resolveBatch({"100": "stale translation", "200": "valid translation"});
	await running;

	assert.deepEqual(committedSummary.translated.map(item => item.message.id), ["200"]);
	assert.equal(job.isMessagePending("100"), false);
	assert.equal(rerenderCount, 1);
});

test("historical commit rejects a translated item when Discord now stores edited content", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const message = createMessage("store-edit", "old stored source");
	let currentMessage = message;
	let resolveBatch;
	let appliedCount = 0;
	let persistedCount = 0;
	plugin._testBdfdb.LibraryStores.MessageStore = {
		getMessage: (_channelId, messageId) => String(messageId) == String(message.id) ? currentMessage : null
	};
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => {
		appliedCount++;
		return {};
	};
	plugin.persistTranslationCacheEntry = () => {
		persistedCount++;
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {};

	plugin.queueAutoTranslateMessage(message, {id: "channel-history-job"}, {content: message.content}, {historicalLoad: true});
	const running = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));
	currentMessage = Object.assign({}, message, {content: "new stored source"});
	resolveBatch({"store-edit": "old source translation"});
	await running;

	assert.equal(appliedCount, 0);
	assert.equal(persistedCount, 0);
});

function configureHistoricalCoordinatorPlugin(options = {}) {
	const plugin = createPluginInstance();
	plugin.settings.filters.receivedAutoTranslateScope = "loaded_messages";
	plugin.shouldAutoTranslateReceivedMessage = () => true;
	plugin.isMessageWithinLoadedRange = () => true;
	plugin.getHistoricalAiBatchEngineKey = () => "deepseek";
	plugin.isTranslationLikelyInTargetLanguage = () => true;
	plugin.shouldKeepAutoTranslatedResult = () => true;
	plugin.isTranslationResultTooSimilar = () => false;
	if (!options.scheduleAutomatically) plugin.scheduleHistoricalTranslationJobStart = () => {};
	plugin.waitForHistoricalTranslationCommit = () => Promise.resolve();
	plugin.isHistoricalTranslationJobCurrent = () => true;
	plugin.updateLoadedAutoTranslationStatus = () => {};
	plugin.persistTranslationCacheEntry = () => {};
	plugin.persistReceivedSkipDecision = () => {};
	return plugin;
}

test("historical collection waits for a quiet period before starting one atomic job", async () => {
	const clock = installFakeClock();

	try {
		const plugin = configureHistoricalCoordinatorPlugin({scheduleAutomatically: true});
		const requestedIds = [];
		let rerenderCount = 0;
		plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => {
			requestedIds.push(preparedItems.map(item => item.message.id));
			return Promise.resolve(Object.fromEntries(preparedItems.map(item => [item.message.id, `translated ${item.message.id}`])));
		};
		plugin.applyStoredTranslationToMessage = () => ({});
		plugin.rerenderMessagesWithScrollPreserved = () => {
			rerenderCount++;
		};

		plugin.queueAutoTranslateMessage(createMessage("100", "first"), {id: "channel-history-job"}, {content: "first"}, {historicalLoad: true});
		await clock.advanceTime(300);
		plugin.queueAutoTranslateMessage(createMessage("200", "second"), {id: "channel-history-job"}, {content: "second"}, {historicalLoad: true});
		await clock.advanceTime(200);
		plugin.queueAutoTranslateMessage(createMessage("300", "third"), {id: "channel-history-job"}, {content: "third"}, {historicalLoad: true});
		await clock.advanceTime(449);

		assert.deepEqual(requestedIds, []);

		await clock.advanceTime(1);
		await plugin.waitForHistoricalTranslationJobs("channel-history-job");

		assert.deepEqual(requestedIds, [["100", "200", "300"]]);
		assert.equal(rerenderCount, 1);
	}
	finally {
		clock.restore();
	}
});

test("historical collection starts at the maximum wait even while messages keep arriving", async () => {
	const clock = installFakeClock();
	try {
		const plugin = configureHistoricalCoordinatorPlugin({scheduleAutomatically: true});
		const requestedIds = [];
		plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => {
			requestedIds.push(preparedItems.map(item => item.message.id));
			return Promise.resolve(Object.fromEntries(preparedItems.map(item => [item.message.id, `translated ${item.message.id}`])));
		};
		plugin.applyStoredTranslationToMessage = () => ({});
		plugin.rerenderMessagesWithScrollPreserved = () => {};

		for (let index = 0; index < 6; index++) {
			plugin.queueAutoTranslateMessage(createMessage(String(index + 1), `message ${index + 1}`), {id: "channel-history-job"}, {content: `message ${index + 1}`}, {historicalLoad: true});
			if (index < 5) await clock.advanceTime(300);
		}
		await clock.advanceTime(299);
		assert.deepEqual(requestedIds, []);

		await clock.advanceTime(1);
		await plugin.waitForHistoricalTranslationJobs("channel-history-job");

		assert.deepEqual(requestedIds, [["1", "2", "3", "4", "5", "6"]]);
	}
	finally {
		clock.restore();
	}
});

test("historical coordinator keeps loading state until one atomic commit", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const appliedIds = [];
	let rerenderCount = 0;
	let resolveBatch;
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = message => {
		appliedIds.push(message.id);
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {
		rerenderCount++;
	};

	for (const [id, content] of [["100", "first"], ["200", "second"]]) {
		plugin.queueAutoTranslateMessage(createMessage(id, content), {id: "channel-history-job"}, {content}, {
			historicalLoad: true,
			deferWhileReading: true
		});
	}

	const running = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.equal(plugin.isHistoricalMessagePending("100", "channel-history-job"), true);
	assert.equal(plugin.isHistoricalMessagePending("200", "channel-history-job"), true);
	assert.deepEqual(appliedIds, []);
	assert.equal(rerenderCount, 0);

	resolveBatch({"100": "第一条", "200": "第二条"});
	await running;

	assert.deepEqual(appliedIds, ["100", "200"]);
	assert.equal(rerenderCount, 1);
	assert.equal(plugin.isHistoricalMessagePending("100", "channel-history-job"), false);
});

test("initial loaded-message pass stops at the configured historical job limit", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const requestedIds = [];
	let acceptedCount = 0;
	let commitCount = 0;
	plugin.getReceivedAutoTranslateLoadedLimit = () => 50;
	plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => {
		requestedIds.push(preparedItems.map(item => item.message.id));
		return Promise.resolve(Object.fromEntries(preparedItems.map(item => [item.message.id, `translated ${item.message.id}`])));
	};
	plugin.applyStoredTranslationToMessage = () => ({});
	plugin.rerenderMessagesWithScrollPreserved = () => {};
	const commitHistoricalTranslationJob = plugin.commitHistoricalTranslationJob.bind(plugin);
	plugin.commitHistoricalTranslationJob = (summary, job) => {
		commitCount++;
		return commitHistoricalTranslationJob(summary, job);
	};

	for (let index = 0; index < 200; index++) {
		const id = String(index + 1);
		if (plugin.queueAutoTranslateMessage(createMessage(id, `message ${id}`), {id: "channel-history-job"}, {content: `message ${id}`}, {historicalLoad: true})) acceptedCount++;
	}

	await plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await plugin.waitForHistoricalTranslationJobs("channel-history-job");

	assert.equal(requestedIds.length, 1);
	assert.equal(requestedIds.flat().length, 50);
	assert.equal(acceptedCount, 50);
	assert.equal(commitCount, 1);
});

test("messages loaded during a running historical job form the next atomic job", async () => {
	const clock = installFakeClock();
	try {
		const plugin = configureHistoricalCoordinatorPlugin({scheduleAutomatically: true});
		const batchResolvers = [];
		const requestedIds = [];
		let rerenderCount = 0;
		plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => {
			requestedIds.push(preparedItems.map(item => item.message.id));
			return new Promise(resolve => batchResolvers.push(resolve));
		};
		plugin.applyStoredTranslationToMessage = () => ({});
		plugin.rerenderMessagesWithScrollPreserved = () => {
			rerenderCount++;
		};

		plugin.queueAutoTranslateMessage(createMessage("100", "first"), {id: "channel-history-job"}, {content: "first"}, {historicalLoad: true});
		const firstRunning = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
		await new Promise(resolve => setImmediate(resolve));

		plugin.queueAutoTranslateMessage(createMessage("200", "older"), {id: "channel-history-job"}, {content: "older"}, {historicalLoad: true});
		assert.equal(plugin.isHistoricalMessagePending("200", "channel-history-job"), true);
		assert.deepEqual(requestedIds, [["100"]]);

		batchResolvers.shift()({"100": "第一条"});
		await firstRunning;
		await clock.advanceTime(449);
		assert.deepEqual(requestedIds, [["100"]]);

		await clock.advanceTime(1);
		assert.deepEqual(requestedIds, [["100"], ["200"]]);

		batchResolvers.shift()({"200": "第二条"});
		await plugin.waitForHistoricalTranslationJobs("channel-history-job");

		assert.equal(rerenderCount, 2);
	}
	finally {
		clock.restore();
	}
});

test("live messages run while a historical provider request is pending", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let resolveBatch;
	let liveTranslateCalls = 0;
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => ({});
	plugin.rerenderMessagesWithScrollPreserved = () => {};
	plugin.translateMessage = () => {
		liveTranslateCalls++;
		return Promise.resolve(true);
	};

	plugin.queueAutoTranslateMessage(createMessage("100", "old"), {id: "channel-history-job"}, {content: "old"}, {historicalLoad: true});
	const historicalRunning = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));

	plugin.queueAutoTranslateMessage(createMessage("300", "new live"), {id: "channel-history-job"}, {content: "new live"}, {historicalLoad: false});
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(liveTranslateCalls, 1);

	resolveBatch({"100": "旧消息"});
	await historicalRunning;
});

test("cached historical translations commit without a provider request", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let providerRequests = 0;
	const appliedIds = [];
	let rerenderCount = 0;
	plugin.requestAiBatchTranslation = () => {
		providerRequests++;
		return Promise.resolve(null);
	};
	plugin.applyStoredTranslationToMessage = message => {
		appliedIds.push(message.id);
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {
		rerenderCount++;
	};

	plugin.queueAutoTranslateMessage(createMessage("cached-1", "cached source"), {id: "channel-history-job"}, {content: "cached source"}, {
		historicalLoad: true,
		cachedTranslation: {
			signature: "cached-signature",
			channelId: "channel-history-job",
			auto: true,
			content: "缓存译文",
			translatedContent: "缓存译文",
			originalContent: "cached source",
			input: {id: "en"},
			output: {id: "zh-CN"}
		}
	});

	await plugin.startCollectedHistoricalTranslationJobs("channel-history-job");

	assert.equal(providerRequests, 0);
	assert.deepEqual(appliedIds, ["cached-1"]);
	assert.equal(rerenderCount, 1);
});

test("invalid batch items are repaired before one atomic coordinator commit", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const repairedIds = [];
	const appliedIds = [];
	let rerenderCount = 0;
	plugin.requestAiBatchTranslation = () => Promise.resolve({
		"invalid-skip": "__SKIP_TRANSLATION__",
		"invalid-language": "still English",
		"invalid-placeholder": "translated without the protected mention"
	});
	plugin.isTranslationLikelyInTargetLanguage = text => text != "still English";
	plugin.repairHistoricalTranslationJobItem = prepared => {
		repairedIds.push(prepared.message.id);
		return Promise.resolve({
			status: "translated",
			translation: {
				signature: prepared.signature,
				channelId: "channel-history-job",
				auto: true,
				content: `${prepared.message.id} repaired`,
				translatedContent: `${prepared.message.id} repaired`,
				originalContent: prepared.originalContentData.content,
				input: prepared.input,
				output: prepared.output
			}
		});
	};
	plugin.applyStoredTranslationToMessage = message => {
		appliedIds.push(message.id);
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {
		rerenderCount++;
	};

	for (const id of ["invalid-skip", "invalid-language", "invalid-placeholder"]) {
		const content = id == "invalid-placeholder" ? "translate <@123456789>" : "translate me";
		plugin.queueAutoTranslateMessage(createMessage(id, content), {id: "channel-history-job"}, {content}, {historicalLoad: true});
	}

	await plugin.startCollectedHistoricalTranslationJobs("channel-history-job");

	assert.deepEqual(repairedIds.sort(), ["invalid-language", "invalid-placeholder", "invalid-skip"]);
	assert.deepEqual(appliedIds.sort(), ["invalid-language", "invalid-placeholder", "invalid-skip"]);
	assert.equal(rerenderCount, 1);
});

test("failed historical items are retained by channel and retried in a new bounded job", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const channelId = "channel-history-retry";
	const requestedIds = [];
	const appliedIds = [];
	const statusUpdates = [];
	let shouldFail = true;
	let holdRetry = false;
	let resolveRetryBatch = null;
	plugin.requestAiBatchTranslation = (_engineKey, preparedItems) => {
		requestedIds.push(preparedItems.map(item => item.message.id));
		if (shouldFail) return Promise.resolve(null);
		const result = Object.fromEntries(preparedItems.map(item => [item.message.id, `translated ${item.protectedText}`]));
		if (!holdRetry) return Promise.resolve(result);
		return new Promise(resolve => {
			resolveRetryBatch = () => resolve(result);
		});
	};
	plugin.repairHistoricalTranslationJobBatch = () => Promise.resolve(null);
	plugin.repairHistoricalTranslationJobItem = () => Promise.resolve({status: "failed", reason: "provider_failed"});
	plugin.applyStoredTranslationToMessage = message => {
		appliedIds.push(message.id);
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {};
	plugin.updateLoadedAutoTranslationStatus = updates => {
		statusUpdates.push(updates);
	};

	for (const id of ["retry-1", "retry-2"]) {
		plugin.queueAutoTranslateMessage(createMessage(id, `source ${id}`), {id: channelId}, {content: `source ${id}`}, {historicalLoad: true});
	}
	await plugin.startCollectedHistoricalTranslationJobs(channelId);

	assert.equal(plugin.getFailedHistoricalTranslationCount(channelId), 2);
	assert.deepEqual(appliedIds, []);

	shouldFail = false;
	holdRetry = true;
	plugin.getReceivedAutoTranslateLoadedLimit = () => 1;
	const firstRetry = plugin.retryFailedHistoricalTranslations(channelId);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(await plugin.retryFailedHistoricalTranslations(channelId), false);
	resolveRetryBatch();
	await firstRetry;

	assert.deepEqual(requestedIds, [["retry-1", "retry-2"], ["retry-1"]]);
	assert.deepEqual(appliedIds, ["retry-1"]);
	assert.equal(plugin.getFailedHistoricalTranslationCount(channelId), 1);
	const partialRetryStatus = statusUpdates.findLast(status => status && status.done && status.active === false);
	assert.equal(partialRetryStatus.total, 1);
	assert.equal(partialRetryStatus.displayed, 1);
	assert.equal(partialRetryStatus.failed, 0);
	assert.equal(partialRetryStatus.retryable, 1);
	assert.doesNotMatch(plugin.getLoadedAutoTranslationStatusText(partialRetryStatus), /failed 1/i);
	assert.match(plugin.getLoadedAutoTranslationStatusText(partialRetryStatus), /retry/i);

	holdRetry = false;
	await plugin.retryFailedHistoricalTranslations(channelId);

	assert.deepEqual(requestedIds, [["retry-1", "retry-2"], ["retry-1"], ["retry-2"]]);
	assert.deepEqual(appliedIds, ["retry-1", "retry-2"]);
	assert.equal(plugin.getFailedHistoricalTranslationCount(channelId), 0);
});

test("editing a source removes its retained historical failure snapshot", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const channelId = "channel-history-failed-edit";
	plugin.requestAiBatchTranslation = () => Promise.resolve(null);
	plugin.repairHistoricalTranslationJobBatch = () => Promise.resolve(null);
	plugin.repairHistoricalTranslationJobItem = () => Promise.resolve({status: "failed", reason: "provider_failed"});
	plugin.rerenderMessagesWithScrollPreserved = () => {};
	const message = createMessage("failed-edit-1", "old failed source");

	plugin.queueAutoTranslateMessage(message, {id: channelId}, {content: message.content}, {historicalLoad: true});
	await plugin.startCollectedHistoricalTranslationJobs(channelId);
	assert.equal(plugin.getFailedHistoricalTranslationCount(channelId), 1);

	const editedMessage = Object.assign({}, message, {content: "new edited source"});
	const editedContentData = plugin.extractOriginalContentData(editedMessage);
	const editedSignature = plugin.createReceivedTranslationSignature(editedMessage, channelId, editedContentData);

	assert.equal(plugin.invalidateHistoricalTranslationMessage(message.id, channelId, editedSignature), true);
	assert.equal(plugin.getFailedHistoricalTranslationCount(channelId), 0);
});

test("failed historical status exposes a visible retry action", () => {
	const plugin = createPluginInstance({
		callSetLanguages: false,
		settings: {filters: {receivedAutoTranslateScope: "loaded_messages"}},
		bdfdb: {
			LibraryStores: {
				SelectedChannelStore: {getChannelId: () => "channel-history-retry-ui"}
			}
		}
	});
	const createNode = tagName => {
		const node = {
			tagName,
			children: [],
			className: "",
			textContent: "",
			appendChild(child) {
				child.parentNode = this;
				this.children.push(child);
				return child;
			},
			remove() {
				if (!this.parentNode) return;
				this.parentNode.children = this.parentNode.children.filter(child => child !== this);
			},
			querySelector(selector) {
				const className = selector.startsWith(".") ? selector.slice(1) : null;
				return this.children.find(child => className && String(child.className || "").split(/\s+/).includes(className)) || null;
			}
		};
		return node;
	};
	const statusElement = createNode("div");
	statusElement.id = "DiscordAITranslator-loaded-status";
	const dot = createNode("span");
	dot.className = "translator-loaded-status-dot";
	const text = createNode("span");
	text.className = "translator-loaded-status-text";
	statusElement.appendChild(dot);
	statusElement.appendChild(text);
	const body = createNode("body");
	body.appendChild(statusElement);
	const originalDocument = global.document;
	const originalRequestAnimationFrame = global.requestAnimationFrame;
	let retriedChannelId = null;
	global.document = {
		body,
		createElement: createNode,
		getElementById: id => id == statusElement.id ? statusElement : null,
		querySelector: () => null,
		querySelectorAll: () => []
	};
	global.requestAnimationFrame = () => 0;
	plugin.attachAutoTranslationScrollWatcher = () => {};
	plugin.ensureLoadedAutoTranslationStatusPositionWatcher = () => {};
	plugin.positionLoadedAutoTranslationStatusElement = () => {};
	plugin.updateInlineLoadedAutoTranslationStatusElements = () => {};
	plugin.retryFailedHistoricalTranslations = channelId => {
		retriedChannelId = channelId;
		return Promise.resolve(true);
	};

	try {
		plugin.updateLoadedAutoTranslationStatus({
			active: false,
			collecting: false,
			done: true,
			channelId: "channel-history-retry-ui",
			total: 2,
			processed: 2,
			displayed: 0,
			skipped: 0,
			failed: 2,
			retryable: 2
		});
		const retryButton = statusElement.querySelector(".translator-loaded-status-retry");
		assert.ok(retryButton);
		assert.equal(retryButton.textContent, "Retry");
		assert.match(statusElement.className, /translator-loaded-status-retryable/);
		retryButton.onclick({stopPropagation: () => {}});
		assert.equal(retriedChannelId, "channel-history-retry-ui");
	}
	finally {
		global.document = originalDocument;
		global.requestAnimationFrame = originalRequestAnimationFrame;
	}
});

test("batch parser drops duplicate and unknown IDs so they enter repair", () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const response = JSON.stringify([
		{id: "100", translation: "first"},
		{id: "100", translation: "duplicate"},
		{id: "200", translation: "second"},
		{id: "unknown", translation: "must be ignored"}
	]);

	assert.deepEqual(plugin.parseAiBatchTranslationResponse(response, ["100", "200"]), {"200": "second"});
	assert.deepEqual(plugin.parseAiBatchTranslationResponse(JSON.stringify([
		{id: "100", translation: ""}
	]), ["100", "200"]), {"100": ""});
	assert.equal(plugin.parseAiBatchTranslationResponse("not json", ["100"]), null);
});

test("pending translation renders a stable loading icon and clears stale translated styling", () => {
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			ReactUtils: {
				createElement: (type, props) => ({type, props, key: props && props.key})
			},
			DOMUtils: {
				formatClassName: (...names) => names.filter(Boolean).join(" ")
			}
		}
	});
	plugin.isMessageTranslationPending = () => true;
	const event = {
		returnvalue: {
			props: {
				children: ["message text"],
				className: "message-content translator-translated-message another-class",
				style: {
					color: "white",
					"--translator-accent-color": "#00ff00",
					"--translator-text-color": "#00ff00"
				}
			}
		}
	};
	const message = createMessage("pending-loader", "message text");

	plugin.applyMessageContentRenderDecorations(event, message, null);

	assert.doesNotMatch(event.returnvalue.props.className, /translator-translated-message/);
	assert.equal(event.returnvalue.props.style["--translator-accent-color"], undefined);
	assert.equal(event.returnvalue.props.style["--translator-text-color"], undefined);
	assert.equal(event.returnvalue.props.style.color, "white");
	const loadingNode = event.returnvalue.props.children.find(child => child && child.props && child.props.className == "translator-translation-loading");
	assert.ok(loadingNode);
	assert.equal(loadingNode.props["aria-label"], "Translating");
});

test("cancelling a channel discards a late coordinator response", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let resolveBatch;
	let appliedCount = 0;
	let rerenderCount = 0;
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => {
		appliedCount++;
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {
		rerenderCount++;
	};

	plugin.queueAutoTranslateMessage(createMessage("cancel-late", "translate later"), {id: "channel-history-job"}, {content: "translate later"}, {historicalLoad: true});
	const running = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));
	plugin.cancelHistoricalTranslationJobs("channel-history-job", "channel-disabled");
	resolveBatch({"cancel-late": "迟到译文"});
	await running;

	assert.equal(appliedCount, 0);
	assert.equal(rerenderCount, 0);
	assert.equal(plugin.isHistoricalMessagePending("cancel-late", "channel-history-job"), false);
});

test("a cancelled historical job cannot delete a replacement queue for the same channel", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let resolveOldBatch;
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveOldBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => ({});
	plugin.rerenderMessagesWithScrollPreserved = () => {};

	plugin.queueAutoTranslateMessage(createMessage("old-job", "old source"), {id: "channel-history-job"}, {content: "old source"}, {historicalLoad: true});
	const oldRunning = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));

	plugin.cancelHistoricalTranslationJobs("channel-history-job", "channel-disabled");
	plugin.queueAutoTranslateMessage(createMessage("replacement-job", "replacement source"), {id: "channel-history-job"}, {content: "replacement source"}, {historicalLoad: true});
	assert.equal(plugin.isHistoricalMessagePending("replacement-job", "channel-history-job"), true);

	resolveOldBatch({"old-job": "late old translation"});
	await oldRunning;

	assert.equal(plugin.isHistoricalMessagePending("replacement-job", "channel-history-job"), true);
});

test("historical coordinator discards a late response after received translation settings change", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let resolveBatch;
	let appliedCount = 0;
	let rerenderCount = 0;
	plugin.isHistoricalTranslationJobCurrent = Object.getPrototypeOf(plugin).isHistoricalTranslationJobCurrent.bind(plugin);
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => {
		appliedCount++;
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {
		rerenderCount++;
	};

	plugin.queueAutoTranslateMessage(createMessage("settings-late", "translate with old settings"), {id: "channel-history-job"}, {content: "translate with old settings"}, {historicalLoad: true});
	const running = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));
	plugin.settings.choices.received.output = "zh-CN";
	resolveBatch({"settings-late": "旧配置译文"});
	await running;

	assert.equal(appliedCount, 0);
	assert.equal(rerenderCount, 0);
	assert.equal(plugin.isMessageTranslationPending("settings-late", "channel-history-job"), false);
});

test("plugin stop clears active automatic translation display state", () => {
	const plugin = createPluginInstance();
	const message = createMessage("stop-restore", "original text");
	plugin.applyStoredTranslationToMessage(message, {
		channelId: message.channel_id,
		auto: true,
		content: "译文",
		translatedContent: "译文",
		originalContent: "original text",
		input: {id: "en"},
		output: {id: "zh-CN"}
	});
	assert.ok(plugin.getActiveMessageTranslation(message, message.channel_id));

	plugin.onStop();

	assert.equal(plugin.getActiveMessageTranslation(message, message.channel_id), null);
});

test("clearing one channel queue cancels its historical coordinator job", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let resolveBatch;
	let appliedCount = 0;
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => {
		appliedCount++;
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {};

	plugin.queueAutoTranslateMessage(createMessage("clear-channel", "translate later"), {id: "channel-history-job"}, {content: "translate later"}, {historicalLoad: true});
	const running = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));

	plugin.clearAutoTranslationQueue("channel-history-job");
	assert.equal(plugin.isHistoricalMessagePending("clear-channel", "channel-history-job"), false);

	resolveBatch({"clear-channel": "late translation"});
	await running;
	assert.equal(appliedCount, 0);
});

test("switching channels cancels the previous channel historical job", () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	const message = Object.assign(createMessage("switch-channel", "translate later"), {channel_id: "channel-a"});
	plugin.prepareAutoTranslationChannelSession("channel-a");
	plugin.queueAutoTranslateMessage(message, {id: "channel-a"}, {content: "translate later"}, {historicalLoad: true});
	assert.equal(plugin.isHistoricalMessagePending(message.id, "channel-a"), true);

	plugin.prepareAutoTranslationChannelSession("channel-b");

	assert.equal(plugin.isHistoricalMessagePending(message.id, "channel-a"), false);
});

test("plugin stop cancels pending historical work and ignores its late result", async () => {
	const plugin = configureHistoricalCoordinatorPlugin();
	let resolveBatch;
	let appliedCount = 0;
	let rerenderCount = 0;
	plugin.requestAiBatchTranslation = () => new Promise(resolve => {
		resolveBatch = resolve;
	});
	plugin.applyStoredTranslationToMessage = () => {
		appliedCount++;
		return {};
	};
	plugin.rerenderMessagesWithScrollPreserved = () => {
		rerenderCount++;
	};

	plugin.queueAutoTranslateMessage(createMessage("stop-late", "translate later"), {id: "channel-history-job"}, {content: "translate later"}, {historicalLoad: true});
	const running = plugin.startCollectedHistoricalTranslationJobs("channel-history-job");
	await new Promise(resolve => setTimeout(resolve, 0));

	plugin.onStop();
	resolveBatch({"stop-late": "late translation"});
	await running;

	assert.equal(appliedCount, 0);
	assert.equal(rerenderCount, 0);
	assert.equal(plugin.isHistoricalMessagePending("stop-late", "channel-history-job"), false);
});
