const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginLiveTranslationQueue} = require("../src/orchestrator/live-translation-queue-wiring");
const {createTranslationTerminalLedger} = require("../src/diagnostics/translation-terminal-ledger");

const EXPECTED_PORTS = [
	"clearChannelTranslationQueue", "clearEligibleReplyPreviewMessages", "clearTimeout",
	"collectHistoricalMessage", "commitBurstResult", "commitCachedResult", "createBurstContext",
	"createTranslationSignature", "extractOriginalContentData", "getBatchEngineKey",
	"getDisplayCommitGeneration", "getMessageChannelId", "isMessageWithinLoadedRange",
	"isProviderBackoffActive", "isRuntimeActive", "isTranslationEnabled", "markDisplayPending",
	"onChannelSessionLeft", "onChannelSessionStarted", "onLiveTurnStarted", "onReservedLiveRequestConsumed",
	"onReservedLiveRequestRetired", "onLiveMessageQueued", "prepareBurstItem", "releaseDisplayPending",
	"observer", "requestBurstTranslation", "resetLoadedMessageTracking", "resolveBurstItemResult",
	"scheduleDisplayFlush", "setTimeout", "shouldAutoTranslateMessage", "translateSingleItem"
].sort();

function createHarness(overrides = {}) {
	const calls = [];
	const store = {getLanguage: choice => ({choice})};
	const display = {pruneChannel: channelId => calls.push(["pruneChannel", channelId])};
	const viewport = {preserveHistoryOnLiveMessage: channelId => calls.push(["preserveHistoryOnLiveMessage", channelId])};
	const plugin = Object.assign({
		isTranslationEnabled: channelId => (calls.push(["isTranslationEnabled", channelId]), true),
		extractOriginalContentData: message => (calls.push(["extractOriginalContentData", message]), {content: message.content}),
		createReceivedTranslationSignature: (...args) => (calls.push(["createTranslationSignature", ...args]), "signature"),
		getMessageChannelId: message => (calls.push(["getMessageChannelId", message]), message.channel_id),
		ensureProviderClient: () => ({
			isBackoffActive: () => (calls.push(["isBackoffActive"]), false),
			beginLatencyRequest: options => (calls.push(["beginLatencyRequest", options]), Object.freeze({requestId: 1, generation: 0, kind: options.kind, queueWaitMs: options.queueWaitMs == null ? null : options.queueWaitMs, messageCount: options.messageCount, inputChars: options.inputChars}))
		}),
		shouldAutoTranslateReceivedMessage: (...args) => (calls.push(["shouldAutoTranslateMessage", ...args]), true),
		isMessageWithinLoadedRange: message => (calls.push(["isMessageWithinLoadedRange", message]), true),
		getReceivedDisplayCommitGeneration: channelId => (calls.push(["getDisplayCommitGeneration", channelId]), 7),
		markReceivedDisplayPending: (...args) => (calls.push(["markDisplayPending", ...args]), "pending"),
		releaseReceivedDisplayPending: record => calls.push(["releaseDisplayPending", record]),
		scheduleReceivedDisplayFlush: (...args) => calls.push(["scheduleDisplayFlush", ...args]),
		collectHistoricalTranslationMessage: item => (calls.push(["collectHistoricalMessage", item]), true),
		clearAutoTranslationEligibleReplyPreviewMessages: channelId => calls.push(["clearEligibleReplyPreviewMessages", channelId]),
		clearAutoTranslationQueue: channelId => calls.push(["clearChannelTranslationQueue", channelId]),
		ensureReceivedDisplayRuntime: () => display,
		ensureMessageViewportStore: () => viewport,
		getReceivedAutoTranslateScope: () => "new_only",
		clearDisplayedAutoTranslations: channelId => calls.push(["clearDisplayedAutoTranslations", channelId]),
		resumeQueuedHistoricalTranslationJobs: (...args) => calls.push(["resumeHistorical", ...args]),
		getHistoricalAiBatchEngineKey: channelId => (calls.push(["getBatchEngineKey", channelId]), "engine"),
		ensureSettingsStore: () => store,
		getLanguageChoice: (...args) => (calls.push(["getLanguageChoice", ...args]), args[0]),
		prepareHistoricalAiBatchQueueItem: (...args) => (calls.push(["prepareBurstItem", ...args]), "prepared"),
		requestAiBatchTranslationDetailed: (...args) => (calls.push(["requestBurstTranslation", ...args]), "requested"),
		commitReceivedDisplayResult: (...args) => (calls.push(["commitReceivedDisplayResult", ...args]), "committed"),
		createReceivedDisplayCommitResult: (...args) => (calls.push(["createReceivedDisplayCommitResult", ...args]), {commit: args}),
		refreshTranslationDisplay: translation => (calls.push(["refreshTranslationDisplay", translation]), translation),
		translateMessage: (...args) => (calls.push(["translateSingleItem", ...args]), "single")
	}, overrides.plugin || {});
	const BDFDB = {TimeUtils: {
		timeout: (callback, delay) => (calls.push(["setTimeout", callback, delay]), "managed-timer"),
		clear: timer => calls.push(["clearTimeout", timer])
	}};
	const statusStore = {resetSeen: channelId => calls.push(["resetSeen", channelId])};
	let captured = null;
	const queue = {tag: "live-queue"};
	const result = createPluginLiveTranslationQueue({
		plugin,
		BDFDB,
		loadedTranslationStatusStore: statusStore,
		historicalBatchPerformance: {recordLiveDemand: () => calls.push(["historicalLiveDemand"]), recordLiveTurnStarted: () => calls.push(["historicalLiveTurn"])},
		getRuntimeActive: () => false,
		languageTypes: {INPUT: "input", OUTPUT: "output"},
		messageTypes: {RECEIVED: "received"},
		createQueue: ports => (captured = ports, queue)
	});
	return {result, queue, captured, calls, plugin, BDFDB};
}

test("live translation queue wiring supplies the complete port list and managed retry timers", () => {
	const {result, queue, captured, calls} = createHarness();
	// The wiring hands back the queue's own ports augmented with the F0 trace; the
	// queue instance itself stays untouched.
	assert.equal(result.tag, queue.tag);
	assert.ok(result.performanceTrace, "wiring exposes the F0 performance trace");
	assert.notEqual(captured.observer, result.performanceTrace.queueObserver);
	captured.observer.notify("enqueued", {channelId: "observer", messageId: "forwarded", queueDepth: 1});
	assert.equal(result.performanceTrace.getSnapshot().enqueuedCount, 1);
	assert.deepEqual(Object.keys(captured).sort(), EXPECTED_PORTS);
	const callback = () => {};
	assert.equal(captured.setTimeout(callback, 900), "managed-timer");
	captured.clearTimeout("managed-timer");
	assert.equal(captured.isRuntimeActive(), false);
	assert.deepEqual(captured.createBurstContext("channel-a"), {
		engineKey: "engine",
		input: {choice: "input"},
		output: {choice: "output"}
	});
	assert.deepEqual(calls, [
		["setTimeout", callback, 900],
		["clearTimeout", "managed-timer"],
		["getBatchEngineKey", "channel-a"],
		["getLanguageChoice", "input", "received", "channel-a"],
		["getLanguageChoice", "output", "received", "channel-a"]
	]);
});

test("live queue wiring preserves session, display, historical handoff and single-item arguments", () => {
	const {captured, calls} = createHarness();
	const message = {id: "message-a", channel_id: "channel-a", content: "hello"};
	const channel = {id: "channel-a"};
	const original = {content: "hello"};
	const request = {id: "request-a"};
	captured.scheduleDisplayFlush("channel-a", "message-a");
	captured.onLiveMessageQueued("channel-a");
	captured.resetLoadedMessageTracking("channel-a");
	captured.onChannelSessionLeft("channel-a");
	captured.onChannelSessionStarted("channel-a");
	captured.onLiveTurnStarted("channel-a");
	captured.onReservedLiveRequestConsumed("channel-a", "ticket-a");
	captured.onReservedLiveRequestRetired("channel-a", "ticket-b");
	assert.equal(captured.prepareBurstItem({message}, "channel-a", {input: {input: 1}, output: {output: 2}}), "prepared");
	const prepared = {protectedText: "prepared"};
	assert.equal(captured.requestBurstTranslation({engineKey: "engine-a", queueWaitMs: 25, messageCount: 1}, [prepared]), "requested");
	assert.equal(captured.translateSingleItem({message, channel, originalContentData: original, liveRequest: request}), "single");
	assert.deepEqual(calls, [
		["scheduleDisplayFlush", "channel-a", "message-a", null, null, "live"],
		["preserveHistoryOnLiveMessage", "channel-a"],
		["historicalLiveDemand"],
		["resetSeen", "channel-a"],
		["pruneChannel", "channel-a"],
		["clearDisplayedAutoTranslations", "channel-a"],
		["historicalLiveTurn"],
		["resumeHistorical", "channel-a", "ticket-a"],
		["resumeHistorical", "channel-a", "ticket-b", {retired: true}],
		["prepareBurstItem", {message}, "channel-a", {input: 1}, {output: 2}],
		["beginLatencyRequest", {kind: "live", lane: "live-burst", queueWaitMs: 25, messageCount: 1, inputChars: 8}],
		["requestBurstTranslation", "engine-a", [prepared], {token: {requestId: 1, generation: 0, kind: "live", queueWaitMs: 25, messageCount: 1, inputChars: 8}, role: "primary", observationRole: "primary", engineKey: "engine-a", messageCount: 1}],
		["beginLatencyRequest", {kind: "live", lane: "auto-single", queueWaitMs: undefined, messageCount: 1, inputChars: 5}],
		["translateSingleItem", message, channel, {auto: true, silent: true, trackBusy: false, originalContentData: original, liveSingleSource: "direct-single", liveRequest: request, latencyKind: "live", queueWaitMs: undefined, messageCount: 1, latencyToken: {requestId: 1, generation: 0, kind: "live", queueWaitMs: null, messageCount: 1, inputChars: 5}}]
	]);
});

test("live queue wiring keeps skip, retry, valid-cache and cached-commit result policy intact", () => {
	const persisted = [];
	const translation = {content: "translated"};
	const harness = createHarness({plugin: {
		isSkipTranslationSignal: value => value === "SKIP",
		persistReceivedSkipDecision: (...args) => persisted.push(["skip", ...args]),
		validateHistoricalTranslationJobResult: (_item, value) => value === "VALID" ? {ok: true, translation} : {ok: false},
		persistTranslationCacheEntry: (...args) => persisted.push(["cache", ...args])
	}});
	const prepared = {message: {id: "message-a"}, signature: "signature-a", protectedText: "preview"};
	assert.deepEqual(harness.captured.resolveBurstItemResult(prepared, {"message-a": "SKIP"}, "channel-a"), {status: "skipped", result: {sourceSignature: "signature-a", status: "skipped", reason: "ai_skip_signal"}});
	assert.deepEqual(harness.captured.resolveBurstItemResult(prepared, {"message-a": "BAD"}, "channel-a"), {status: "retry"});
	assert.deepEqual(harness.captured.resolveBurstItemResult(prepared, {"message-a": "VALID"}, "channel-a"), {status: "translated", result: {sourceSignature: "signature-a", status: "translated", translation}});
	assert.deepEqual(persisted, [
		["skip", "message-a", "signature-a", "ai_skip_signal", "preview"],
		["cache", "message-a", "signature-a", translation]
	]);

	const queueItem = {message: {id: "message-b"}, originalContentData: {content: "source"}, cachedTranslation: {signature: "cached-signature", content: "cached"}, liveRequest: {id: "request-b"}};
	assert.equal(harness.captured.commitCachedResult(queueItem, "channel-b"), "committed");
	const storedTranslation = {channelId: "channel-b", auto: true, signature: "cached-signature", content: "cached"};
	assert.deepEqual(harness.calls.slice(-3), [
		["refreshTranslationDisplay", storedTranslation],
		["createReceivedDisplayCommitResult", queueItem.message, "channel-b", {sourceSignature: "cached-signature", requestIdentity: "request-b", status: "translated", translation: storedTranslation}],
		["commitReceivedDisplayResult", {commit: [queueItem.message, "channel-b", {sourceSignature: "cached-signature", requestIdentity: "request-b", status: "translated", translation: storedTranslation}]}, {refresh: false}]
	]);
});

test("S8b M0a live burst, stale, repair and cache-hit routes share one terminal ledger", () => {
	const ledger = createTranslationTerminalLedger(); ledger.start();
	const harness = createHarness({plugin: {
		beginTranslationTerminalRoute: metadata => ledger.begin(metadata),
		updateTranslationTerminalRoute: (routeId, fields) => ledger.update(routeId, fields),
		recordTranslationTerminalStage: (routeId, stage, reason, fields) => ledger.stage(routeId, stage, reason, fields),
		finishTranslationTerminalRoute: (routeId, terminal) => ledger.terminal(routeId, terminal),
		isSkipTranslationSignal: () => false,
		validateHistoricalTranslationJobResult: (_item, value) => value === "VALID" ? {ok: true, translation: {content: "translated"}} : {ok: false},
		persistTranslationCacheEntry: () => {}
	}});
	const context = {input: {}, output: {}}, makeItem = id => ({message: {id, channel_id: "channel-ledger", content: "source"}, channel: {id: "channel-ledger"}, originalContentData: {content: "source", embeds: []}});
	const translated = makeItem("translated"); harness.captured.prepareBurstItem(translated, "channel-ledger", context); harness.captured.commitBurstResult(translated, "channel-ledger", {status: "translated"});
	const stale = makeItem("stale"); harness.captured.prepareBurstItem(stale, "channel-ledger", context); harness.captured.observer.notify("stale-drop", {channelId: "channel-ledger", messageId: "stale", site: "burst-post"});
	const repair = makeItem("repair"); harness.captured.prepareBurstItem(repair, "channel-ledger", context); assert.deepEqual(harness.captured.resolveBurstItemResult({message: repair.message, queueItem: repair, signature: "sig", protectedText: "source"}, {repair: "BAD"}, "channel-ledger"), {status: "retry"});
	const cached = Object.assign(makeItem("cached"), {cachedTranslation: {signature: "cached", content: "译文"}, liveRequest: {id: "request"}}); harness.captured.commitCachedResult(cached, "channel-ledger");
	const snapshot = ledger.getSnapshot();
	assert.deepEqual(snapshot.recent.map(item => [item.lane, item.outcome, item.stage, item.reason]), [
		["live-burst", "translated", "display-currentness", "committed"],
		["live-burst", "stale", "display-currentness", "burst-post"],
		["live-burst", "failed", "repair", "requeue_single"],
		["cache-hit", "translated", "cache", "translation_hit"]
	]);
	assert.equal(snapshot.recent[2].laneTags["item-repair"], 1);
	assert.equal(snapshot.activeRouteCount, 0);
});

test("W4 actual live queue wiring carries sticky burst provenance even after terminal route was cleared", () => {
 const h = createHarness(), message = {id: "provenance", channel_id: "channel-a", content: "Hello"}, channel = {id: "channel-a"};
 h.captured.translateSingleItem({message, channel});
 h.captured.translateSingleItem({message, channel, skipLiveBatch: true, terminalRouteId: null});
 h.captured.translateSingleItem({message, channel, historicalLoad: true});
 const options = h.calls.filter(row => row[0] === "translateSingleItem").map(row => row[3]);
 assert.deepEqual(options.map(row => row.liveSingleSource), ["direct-single", "burst-requeue", "historical"]);
});
