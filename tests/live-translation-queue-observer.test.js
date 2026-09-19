const test = require("node:test");
const assert = require("node:assert/strict");
const {createLiveTranslationQueue} = require("../src/orchestrator/live-translation-queue");
const {createPluginLiveTranslationQueue} = require("../src/orchestrator/live-translation-queue-wiring");

function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

// Purpose-built minimal harness: the observer contract is additive, so this file
// only wires the dependencies each observed path actually touches. Behavioural
// coverage of the queue itself stays in live-translation-queue.test.js.
function createObservedHarness(overrides = {}) {
	const events = [];
	const timers = [];
	const singleDeferrals = [];
	const state = {clock: 1000, backoff: false, batchEngine: null};
	const queue = createLiveTranslationQueue(Object.assign({
		now: () => state.clock,
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {},
		isTranslationEnabled: () => true,
		shouldAutoTranslateMessage: () => true,
		extractOriginalContentData: message => ({content: message && message.content || ""}),
		createTranslationSignature: (message, channelId, originalContentData) => `${channelId}|${originalContentData && originalContentData.content}`,
		getMessageChannelId: message => message && message.channelId || null,
		isProviderBackoffActive: () => state.backoff,
		getBatchEngineKey: () => state.batchEngine,
		createBurstContext: channelId => ({channelId, engineKey: state.batchEngine}),
		prepareBurstItem: (queueItem, channelId) => ({
			queueItem,
			message: queueItem.message,
			signature: `${channelId}|${queueItem.message.content}`,
			protectedText: queueItem.message.content
		}),
		requestBurstTranslation: (context, prepared) => {
			const resultMap = {};
			for (const preparedItem of prepared) resultMap[String(preparedItem.message.id)] = `translated-${preparedItem.message.content}`;
			return Promise.resolve(resultMap);
		},
		resolveBurstItemResult: preparedItem => ({
			status: "translated",
			result: {sourceSignature: preparedItem.signature, status: "translated", translation: `translated-${preparedItem.message.content}`}
		}),
		commitBurstResult: queueItem => Promise.resolve({confirmedIds: [String(queueItem.message.id)]}),
		observer: {notify: (type, payload) => events.push(Object.assign({type}, payload))}
	}, overrides));
	return {
		queue,
		events,
		timers,
		state,
		singleDeferrals,
		ofType(type) {
			return events.filter(event => event.type === type);
		}
	};
}

test("the single path reports enqueue depth, per-message wait and lane activity", async () => {
	const harness = createObservedHarness({
		translateSingleItem: () => new Promise(resolve => harness.singleDeferrals.push(resolve))
	});
	harness.queue.queueMessage({id: "m1", content: "hello"}, {id: "c1"});

	const [enqueued] = harness.ofType("enqueued");
	assert.equal(enqueued.channelId, "c1");
	assert.equal(enqueued.messageId, "m1");
	assert.equal(enqueued.queueDepth, 1);

	const [dispatched] = harness.ofType("dispatched");
	assert.equal(dispatched.mode, "single");
	assert.equal(dispatched.messageId, "m1");
	assert.equal(dispatched.queueWaitMs, 0);

	assert.deepEqual(harness.ofType("lane-active").map(event => event.active), [1]);
	harness.singleDeferrals.shift()();
	await settle();
	assert.deepEqual(harness.ofType("lane-active").map(event => event.active), [1, 0]);
});

test("a message queued behind the live lock reports its real wait on dispatch", async () => {
	const harness = createObservedHarness({
		translateSingleItem: () => new Promise(resolve => harness.singleDeferrals.push(resolve))
	});
	harness.queue.queueMessage({id: "m1", content: "one"}, {id: "c1"});
	harness.queue.queueMessage({id: "m2", content: "two"}, {id: "c1"});

	const blocked = harness.ofType("blocked");
	assert.equal(blocked.length, 1);
	assert.equal(blocked[0].reason, "live-lock");

	harness.state.clock = 1600;
	harness.singleDeferrals.shift()();
	await settle();

	const dispatched = harness.ofType("dispatched");
	assert.equal(dispatched.length, 2);
	assert.equal(dispatched[1].messageId, "m2");
	assert.equal(dispatched[1].queueWaitMs, 600);
});

test("a provider backoff reports a blocked reason next to the armed retry", () => {
	const harness = createObservedHarness();
	harness.state.backoff = true;
	harness.queue.queueMessage({id: "m1", content: "one"}, {id: "c1"});

	const blocked = harness.ofType("blocked");
	assert.equal(blocked.length, 1);
	assert.equal(blocked[0].reason, "backoff");
	assert.equal(harness.ofType("dispatched").length, 0);
	assert.equal(harness.timers.length, 1);
});

test("a burst reports one physical request and a real wait for every drained item", async () => {
	const harness = createObservedHarness();
	harness.state.batchEngine = "ai";
	harness.queue.setLiveAutoTranslating(true);
	harness.queue.queueMessage({id: "m1", content: "one"}, {id: "c1"});
	harness.state.clock = 1200;
	harness.queue.queueMessage({id: "m2", content: "two"}, {id: "c1"});
	harness.state.clock = 1500;
	harness.queue.queueMessage({id: "m3", content: "three"}, {id: "c1"});
	harness.queue.setLiveAutoTranslating(false);
	harness.state.clock = 2000;
	harness.queue.processQueue();
	await settle();

	const burstRequests = harness.ofType("burst-request");
	assert.equal(burstRequests.length, 1);
	assert.equal(burstRequests[0].messageCount, 3);

	const dispatched = harness.ofType("dispatched").filter(event => event.mode === "burst");
	assert.equal(dispatched.length, 3);
	const waits = Object.fromEntries(dispatched.map(event => [event.messageId, event.queueWaitMs]));
	assert.deepEqual(waits, {m3: 500, m2: 800, m1: 1000});
	for (const event of dispatched) assert.equal(event.batchSize, 3);
});

test("a stale queue head reports the drop site instead of dispatching", async () => {
	const harness = createObservedHarness({
		translateSingleItem: () => new Promise(resolve => harness.singleDeferrals.push(resolve))
	});
	harness.queue.setLiveAutoTranslating(true);
	const message = {id: "m1", content: "original"};
	harness.queue.queueMessage(message, {id: "c1"});
	message.content = "edited";
	harness.queue.setLiveAutoTranslating(false);
	harness.queue.processQueue();
	await settle();

	const drops = harness.ofType("stale-drop");
	assert.equal(drops.length, 1);
	assert.equal(drops[0].site, "queue-head");
	assert.equal(drops[0].messageId, "m1");
	assert.equal(harness.ofType("dispatched").length, 0);
});

test("the plugin wiring attaches a connected performance trace to the queue", async () => {
	const plugin = {
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message && message.content || ""}),
		createReceivedTranslationSignature: (message, channelId) => `${channelId}|${message && message.content}`,
		getMessageChannelId: message => message && message.channelId || null,
		ensureProviderClient: () => ({isBackoffActive: () => false}),
		shouldAutoTranslateReceivedMessage: () => true,
		isMessageWithinLoadedRange: () => true,
		getReceivedDisplayCommitGeneration: () => 0,
		markReceivedDisplayPending: () => null,
		releaseReceivedDisplayPending: () => {},
		scheduleReceivedDisplayFlush: () => {},
		ensureMessageViewportStore: () => ({preserveHistoryOnLiveMessage: () => {}}),
		getHistoricalAiBatchEngineKey: () => null,
		translateMessage: () => Promise.resolve()
	};
	const BDFDB = {TimeUtils: {timeout: (callback, delay) => setTimeout(callback, delay), clear: timer => clearTimeout(timer)}};
	const wired = createPluginLiveTranslationQueue({plugin, BDFDB, loadedTranslationStatusStore: {resetSeen: () => {}}});

	assert.ok(wired.performanceTrace, "wiring must expose the performance trace");
	wired.queueMessage({id: "m1", content: "hello"}, {id: "c1"});
	await settle();

	let snapshot = wired.performanceTrace.getSnapshot();
	assert.equal(snapshot.enqueuedCount, 1);
	assert.equal(snapshot.dispatchedSingleCount, 1);

	wired.performanceTrace.onRenderOutcome({channelId: "c1", messageIds: ["m1"], outcome: {confirmedIds: ["m1"]}});
	snapshot = wired.performanceTrace.getSnapshot();
	assert.equal(snapshot.enqueueToDom.count, 1);
});

test("a throwing observer never breaks queue processing", async () => {
	const singles = [];
	const harness = createObservedHarness({
		observer: {notify: () => {throw new Error("observer exploded");}},
		translateSingleItem: queueItem => {
			singles.push(String(queueItem.message.id));
			return Promise.resolve();
		}
	});
	assert.doesNotThrow(() => harness.queue.queueMessage({id: "m1", content: "one"}, {id: "c1"}));
	await settle();
	assert.deepEqual(singles, ["m1"]);
});
