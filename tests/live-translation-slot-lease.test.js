const test = require("node:test");
const assert = require("node:assert/strict");
const {createLiveTranslationQueue} = require("../src/orchestrator/live-translation-queue");

function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return {promise, resolve, reject};
}

function permutations(values) {
	if (values.length < 2) return [values.slice()];
	return values.flatMap((value, index) => permutations(values.slice(0, index).concat(values.slice(index + 1))).map(rest => [value, ...rest]));
}

function assertExactTurns(active, turnCount, label) {
	assert.deepEqual(active, Array.from({length: turnCount}, () => [1, 0]).flat(), `${label}: every physical turn owns exactly one lease`);
	assert.ok(active.every(count => count === 0 || count === 1), `${label}: active is always 0/1`);
	assert.equal(Math.max(0, ...active), turnCount ? 1 : 0, `${label}: high-water is one`);
}

async function drainControlledSingles(harness, outcome) {
	let completed = 0;
	while (harness.queue.getLiveSlotActiveCount() || !harness.queue.isQueueEmpty()) {
		assert.ok(harness.deferrals[completed], `turn ${completed + 1} was dispatched`);
		if (outcome === "success") harness.deferrals[completed].resolve("ok");
		else harness.deferrals[completed].reject(new Error("expected provider rejection"));
		completed++;
		await settle();
	}
	return completed;
}

function createHarness(overrides = {}) {
	const state = {runtimeActive: true, manual: false, backoff: false, batch: false};
	const calls = {single: [], burst: [], commits: [], active: [], blocked: [], consumed: []};
	const deferrals = [];
	const timers = [];
	let queue;
	const dependencies = Object.assign({
		setTimeout: (callback, delay) => {
			timers.push({callback, delay});
			return timers.length;
		},
		clearTimeout: () => {},
		isRuntimeActive: () => state.runtimeActive,
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
		getMessageChannelId: message => message.channelId,
		isProviderBackoffActive: () => state.backoff,
		shouldAutoTranslateMessage: () => true,
		getBatchEngineKey: () => state.batch ? "ai" : null,
		createBurstContext: channelId => ({channelId}),
		prepareBurstItem: (queueItem, channelId) => ({
			queueItem,
			message: queueItem.message,
			signature: `${channelId}|${queueItem.message.content}`,
			protectedText: queueItem.message.content
		}),
		requestBurstTranslation: (_context, prepared) => {
			calls.burst.push(prepared.map(item => String(item.message.id)));
			return Promise.resolve(Object.fromEntries(prepared.map(item => [String(item.message.id), `translated-${item.message.content}`])));
		},
		resolveBurstItemResult: preparedItem => ({
			status: "translated",
			result: {status: "translated", sourceSignature: preparedItem.signature, translation: `translated-${preparedItem.message.content}`}
		}),
		commitBurstResult: queueItem => {
			calls.commits.push(String(queueItem.message.id));
			return Promise.resolve({confirmedIds: [String(queueItem.message.id)]});
		},
		translateSingleItem: queueItem => {
			calls.single.push(String(queueItem.message.id));
			const deferred = createDeferred();
			deferrals.push(deferred);
			return deferred.promise;
		},
		onReservedLiveRequestConsumed: (_channelId, ticket, reason) => calls.consumed.push([String(ticket), reason]),
		observer: {notify: (type, payload) => {
			if (type === "lane-active") calls.active.push(payload.active);
			if (type === "blocked") calls.blocked.push(payload.reason);
		}}
	}, overrides);
	queue = createLiveTranslationQueue(dependencies);

	function add(id, channelId = "c1", options = {}) {
		const message = {id: String(id), channelId, content: `content-${id}`};
		return queue.queueMessage(message, {id: channelId}, null, options);
	}

	return {queue, state, calls, deferrals, timers, add};
}

test("compatibility false never releases or resumes a provider-owned lease", async () => {
	const harness = createHarness();
	harness.add("m1");
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1);
	assert.equal(harness.queue.getLiveSlotCapacity(), 1);

	harness.queue.setLiveAutoTranslating(false);
	harness.queue.setLiveAutoTranslating(true);
	harness.queue.setLiveAutoTranslating(false);
	harness.add("m2");
	assert.deepEqual(harness.calls.single, ["m1"], "compatibility calls cannot open a parallel provider turn");
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1);

	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.single, ["m1", "m2"], "the exact provider release resumes the queue once");
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1);
	harness.deferrals[1].resolve();
	await settle();

	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
});

test("the compatibility surface owns only its idempotent compatibility lease", async () => {
	const harness = createHarness();
	harness.queue.setLiveAutoTranslating(true);
	harness.queue.setLiveAutoTranslating(true);
	harness.add("m1");

	assert.equal(harness.queue.isLiveAutoTranslating(), true);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1);
	assert.deepEqual(harness.calls.single, []);
	assert.deepEqual(harness.calls.active, [1], "repeated true has no second transition");

	harness.queue.setLiveAutoTranslating(false);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	harness.queue.processQueue();
	assert.deepEqual(harness.calls.single, ["m1"]);
	harness.queue.setLiveAutoTranslating(false);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1, "a compatibility false does not borrow the provider token");

	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
});

test("a stale compatibility acquisition never blocks the next true request", async () => {
	let queue;
	let restartOnFirstAcquire = true;
	const calls = [];
	const active = [];
	const deferrals = [];
	queue = createLiveTranslationQueue({
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
		shouldAutoTranslateMessage: () => true,
		translateSingleItem: item => {
			calls.push(String(item.message.id));
			const deferred = createDeferred();
			deferrals.push(deferred);
			return deferred.promise;
		},
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 1 || !restartOnFirstAcquire) return;
			restartOnFirstAcquire = false;
			queue.restartRequestGeneration();
			queue.queueMessage({id: "new", channelId: "c1", content: "new"}, {id: "c1"});
		}}
	});

	queue.setLiveAutoTranslating(true);
	assert.deepEqual(calls, ["new"]);
	deferrals[0].resolve();
	await settle();
	assert.deepEqual(active, [1, 0, 1, 0], "the replacement provider turn completes normally");
	assert.equal(queue.getLiveSlotActiveCount(), 0);

	queue.setLiveAutoTranslating(true);
	assert.equal(queue.getLiveSlotActiveCount(), 1, "the stale outer token is not retained as the compatibility pointer");
	queue.setLiveAutoTranslating(false);
	assert.deepEqual(active, [1, 0, 1, 0, 1, 0]);
});

test("a reentrant compatibility false is the last intent and releases the outer acquisition", () => {
	let queue;
	let releaseOnAcquire = true;
	const active = [];
	queue = createLiveTranslationQueue({
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 1 || !releaseOnAcquire) return;
			releaseOnAcquire = false;
			queue.setLiveAutoTranslating(false);
		}}
	});

	queue.setLiveAutoTranslating(true);
	assert.equal(queue.isLiveAutoTranslating(), false);
	assert.equal(queue.getLiveSlotActiveCount(), 0);
	assert.deepEqual(active, [1, 0], "the still-current outer token is released after notification returns");
});

test("a restart-time nested compatibility true owns the replacement lease", () => {
	let queue;
	let restartOnFirstAcquire = true;
	const active = [];
	queue = createLiveTranslationQueue({
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 1 || !restartOnFirstAcquire) return;
			restartOnFirstAcquire = false;
			queue.restartRequestGeneration();
			queue.setLiveAutoTranslating(true);
		}}
	});

	queue.setLiveAutoTranslating(true);
	assert.equal(queue.getLiveSlotActiveCount(), 1);
	assert.deepEqual(active, [1, 0, 1]);

	queue.setLiveAutoTranslating(false);
	assert.equal(queue.getLiveSlotActiveCount(), 0, "false releases the nested replacement rather than the stale outer token");
	assert.deepEqual(active, [1, 0, 1, 0]);
});

test("an acquisition race restores a reserved selection at its exact prior index", () => {
	let harness;
	let armRace = false;
	let injectArrival = false;
	harness = createHarness({
		shouldAutoTranslateMessage: (_message, _channel, _data, finalGuard) => {
			if (armRace && finalGuard) {
				harness.queue.setLiveAutoTranslating(true);
				if (injectArrival) {
					injectArrival = false;
					harness.add("arrived", "c3");
				}
			}
			return true;
		}
	});
	harness.queue.setBusyTranslating(true);
	harness.add("reserved", "c1");
	const reservedItem = harness.queue.getQueueSnapshot()[0];
	harness.queue.reserveQueuedLiveRequest("c1");
	harness.add("newest", "c2");
	armRace = true;
	injectArrival = true;
	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();

	assert.deepEqual(harness.queue.getQueueSnapshot().map(item => item.message.id), ["arrived", "newest", "reserved"]);
	assert.equal(harness.queue.getQueueSnapshot()[2], reservedItem, "the selection returns after its prior neighbour, behind a newer arrival");
	assert.deepEqual(harness.calls.single, []);
	harness.queue.setLiveAutoTranslating(false);
});

test("a reentrant restart from the acquisition observer invalidates the outer selection before provider dispatch", async () => {
	let queue;
	let restartOnFirstAcquire = true;
	const calls = [];
	const deferrals = [];
	const active = [];
	const dependencies = {
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
		shouldAutoTranslateMessage: () => true,
		translateSingleItem: item => {
			calls.push(String(item.message.id));
			const deferred = createDeferred();
			deferrals.push(deferred);
			return deferred.promise;
		},
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 1 || !restartOnFirstAcquire) return;
			restartOnFirstAcquire = false;
			queue.restartRequestGeneration();
			queue.queueMessage({id: "new", channelId: "c1", content: "new"}, {id: "c1"});
		}}
	};
	queue = createLiveTranslationQueue(dependencies);

	queue.queueMessage({id: "old", channelId: "c1", content: "old"}, {id: "c1"});

	assert.deepEqual(calls, ["new"], "the stale outer token never reaches its provider callback");
	assert.equal(deferrals.length, 1, "only the new generation has a physical provider turn");
	assert.equal(queue.getLiveSlotActiveCount(), 1, "the stale outer selection does not release the new lease");
	assert.equal(queue.isMessageQueued("old"), false, "the stale request is discarded rather than restored");
	assert.equal(queue.isQueueEmpty(), true);

	deferrals[0].resolve();
	await settle();
	assert.equal(queue.getLiveSlotActiveCount(), 0);
	assertExactTurns(active, 2, "restart invalidation includes the reset transition and the new physical turn");
});

test("restart publishes lane zero only after old generation state is retired", async () => {
	let queue;
	let reentered = false;
	const calls = [];
	const active = [];
	const deferrals = [];
	queue = createLiveTranslationQueue({
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
		shouldAutoTranslateMessage: () => true,
		translateSingleItem: item => {
			calls.push(String(item.message.id));
			const deferred = createDeferred();
			deferrals.push(deferred);
			return deferred.promise;
		},
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 0 || reentered) return;
			reentered = true;
			queue.processQueue();
			queue.queueMessage({id: "new", channelId: "c1", content: "new"}, {id: "c1"});
		}}
	});

	queue.setLiveAutoTranslating(true);
	queue.queueMessage({id: "old", channelId: "c1", content: "old"}, {id: "c1"});
	assert.equal(queue.isMessageQueued("old"), true);

	queue.restartRequestGeneration();

	assert.deepEqual(calls, ["new"], "lane-zero reentry observes only the new request generation");
	assert.deepEqual(active, [1, 0, 1]);
	assert.equal(queue.getRuntimeGeneration(), 1);
	assert.equal(queue.isMessageQueued("old"), false, "the exact old queued marker is retired");
	assert.equal(queue.isMessageQueued("new"), true, "the nested generation marker survives the outer restart");
	assert.equal(queue.getLastConsumedLiveRequestTicket("c1"), "2", "outer cleanup does not erase nested consumption state");
	assert.equal(queue.isQueueEmpty(), true);

	deferrals[0].resolve();
	await settle();
	assert.equal(queue.isMessageQueued("new"), false);
	assert.deepEqual(active, [1, 0, 1, 0]);
});

test("restart during burst collection drops the frozen old plan before dispatch", async () => {
	let harness;
	let restartDuringCollection = true;
	let nestedEnqueued = false;
	harness = createHarness({
		getBatchEngineKey: () => {
			if (restartDuringCollection) {
				restartDuringCollection = false;
				harness.queue.restartRequestGeneration();
			}
			return "ai";
		},
		observer: {notify(type, payload) {
			if (type === "lane-active") harness.calls.active.push(payload.active);
			if (type !== "lane-active" || payload.active !== 0 || restartDuringCollection || nestedEnqueued) return;
			nestedEnqueued = true;
			harness.add("nested", "c1");
		}}
	});
	harness.queue.setBusyTranslating(true);
	harness.add("old", "c1");
	harness.add("new", "c1");
	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();

	assert.deepEqual(harness.calls.burst, [], "the invalidated selected/drained plan never reaches the burst provider");
	assert.deepEqual(harness.calls.single, ["nested"], "pending nested work resumes after planning exits");
	assert.deepEqual(harness.calls.active, [1, 0, 1]);
	assert.equal(harness.queue.isMessageQueued("old"), false);
	assert.equal(harness.queue.isMessageQueued("new"), false);
	assert.equal(harness.queue.isMessageQueued("nested"), true);
	assert.equal(harness.queue.getLastConsumedLiveRequestTicket("c1"), "3", "outer stale-plan cleanup preserves nested consumption");
	assert.equal(harness.queue.isQueueEmpty(), true);

	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
	assert.equal(harness.queue.isMessageQueued("nested"), false);
});

test("a running request restart forgets its exact marker immediately and after late completion", async () => {
	const displayReleases = [];
	const harness = createHarness({releaseDisplayPending: request => displayReleases.push(request)});
	harness.add("running", "c1");
	assert.equal(harness.queue.isMessageQueued("running"), true);

	harness.queue.restartRequestGeneration();

	assert.equal(harness.queue.isMessageQueued("running"), false, "restart retires the running request's exact marker synchronously");
	assert.deepEqual(displayReleases, [], "restart leaves display-pending cleanup to the start/display reset");
	harness.deferrals[0].resolve();
	await settle();
	assert.equal(harness.queue.isMessageQueued("running"), false, "the old physical completion stays marker-idempotent");
	assert.deepEqual(displayReleases, [], "late completion of a restart-finished identity cannot release display state");
});

test("restart preserves an identity-mismatched replacement marker for the same message id", async () => {
	const harness = createHarness();
	harness.add("same", "c1");
	const oldRequest = harness.queue.getQueuedMarker("same");
	const replacementMarker = Object.freeze({type: "historical", jobId: "replacement"});
	assert.notEqual(oldRequest, replacementMarker);
	harness.queue.markMessageQueued("same", replacementMarker);

	harness.queue.restartRequestGeneration();

	assert.equal(harness.queue.getQueuedMarker("same"), replacementMarker, "restart forgets only the request identity it owns");
	harness.deferrals[0].resolve();
	await settle();
	assert.equal(harness.queue.getQueuedMarker("same"), replacementMarker, "late finish cannot steal the same-ID replacement marker");
});

test("lane-active acquisition invalidations fence generation channel source and runtime work before provider dispatch", async t => {
	for (const scenario of ["global", "channel-clear", "channel-identity", "source", "runtime"]) {
		await t.test(scenario, async () => {
			let queue;
			let sourceMessage;
			let sourceChannel;
			let runtimeActive = true;
			let invalidateOnAcquire = true;
			const active = [];
			const providerCalls = [];
			queue = createLiveTranslationQueue({
				isRuntimeActive: () => runtimeActive,
				isTranslationEnabled: () => true,
				extractOriginalContentData: message => ({content: message.content}),
				createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
				shouldAutoTranslateMessage: () => true,
				translateSingleItem: item => {
					providerCalls.push(String(item.message.id));
					return Promise.resolve();
				},
				observer: {notify(type, payload) {
					if (type !== "lane-active") return;
					active.push(payload.active);
					if (payload.active !== 1 || !invalidateOnAcquire) return;
					invalidateOnAcquire = false;
					if (scenario === "global") queue.clearQueue();
					else if (scenario === "channel-clear") queue.clearQueue("c1");
					else if (scenario === "channel-identity") sourceChannel.id = "c2";
					else if (scenario === "source") sourceMessage.content = "edited";
					else runtimeActive = false;
				}}
			});
			sourceMessage = {id: "planned", channelId: "c1", content: "original"};
			sourceChannel = {id: "c1"};

			queue.queueMessage(sourceMessage, sourceChannel);
			await settle();

			assert.deepEqual(providerCalls, [], `${scenario} invalidation issues zero provider calls`);
			assert.deepEqual(active, [1, 0], `${scenario} invalidation releases the exact owned token once`);
			assert.equal(queue.getLiveSlotActiveCount(), 0);
			assert.equal(queue.isMessageQueued("planned"), false, `${scenario} invalidation clears the exact marker`);
			assert.equal(queue.isQueueEmpty(), true);
		});
	}
});

test("a mixed post-collect plan restores every current item in order and drops only stale work", async t => {
	for (const invalidatedId of ["new", "middle"]) {
		await t.test(`invalidate-${invalidatedId}`, async () => {
			let harness;
			let invalidateDuringCollection = true;
			harness = createHarness({
				getBatchEngineKey: channelId => {
					if (invalidateDuringCollection) {
						invalidateDuringCollection = false;
						harness.queue.setBusyTranslating(true);
						harness.queue.invalidateRequestForMessage(invalidatedId, channelId, `${channelId}|edited-${invalidatedId}`);
					}
					return "ai";
				}
			});
			harness.queue.setBusyTranslating(true);
			harness.add("old", "c1");
			harness.add("middle", "c1");
			harness.add("new", "c1");
			harness.queue.setBusyTranslating(false);

			harness.queue.processQueue();

			const expectedCurrentOrder = invalidatedId === "new" ? ["middle", "old"] : ["new", "old"];
			const restoredItems = harness.queue.getQueueSnapshot();
			assert.deepEqual(harness.calls.burst, [], "the mixed stale plan performs no provider request");
			assert.deepEqual(harness.calls.single, []);
			assert.deepEqual(restoredItems.map(item => item.message.id), expectedCurrentOrder, "current selected/drained items return in exact newest-first order");
			assert.deepEqual(restoredItems.map(item => item.resumeLiveBatch), [true, false], "one frozen burst intent has one replan driver and never leaks to candidates");
			assert.equal(harness.queue.isMessageQueued(invalidatedId), false, "only the stale request marker is terminal");
			for (const id of expectedCurrentOrder) assert.equal(harness.queue.isMessageQueued(id), true, `current marker ${id} survives replanning`);
			assert.deepEqual(harness.calls.active, [1, 0], "the aborted plan releases its exact lease once");

			harness.queue.setBusyTranslating(false);
			harness.queue.processQueue();
			await settle();

			assert.deepEqual(harness.calls.burst, [expectedCurrentOrder], "the restored current items dispatch once in their original order");
			assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
			assert.ok(restoredItems.every(item => item.resumeLiveBatch === false), "the one-shot transport flag is consumed by replan");
			assert.equal(harness.queue.isQueueEmpty(), true);
			for (const id of ["old", "middle", "new"]) assert.equal(harness.queue.isMessageQueued(id), false, `final marker ${id} cleared`);
		});
	}
});

test("a mixed plan reduced to one current item preserves its frozen burst transport on replan", async () => {
	let harness;
	let invalidateDuringCollection = true;
	harness = createHarness({
		getBatchEngineKey: channelId => {
			if (invalidateDuringCollection) {
				invalidateDuringCollection = false;
				harness.queue.setBusyTranslating(true);
				harness.queue.invalidateRequestForMessage("stale", channelId, `${channelId}|edited-stale`);
			}
			return "ai";
		}
	});
	harness.queue.setBusyTranslating(true);
	harness.add("stale", "c1");
	harness.add("current", "c1");
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();
	assert.deepEqual(harness.queue.getQueueSnapshot().map(item => item.message.id), ["current"]);
	assert.deepEqual(harness.calls.burst, []);
	assert.deepEqual(harness.calls.single, []);

	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();
	await settle();

	assert.deepEqual(harness.calls.burst, [["current"]], "replanning does not change the established burst provider path or request count");
	assert.deepEqual(harness.calls.single, []);
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
	assert.equal(harness.queue.isMessageQueued("stale"), false);
	assert.equal(harness.queue.isMessageQueued("current"), false);
});

test("round-five fixed-point fence catches a later currentness hook invalidating an earlier planned item", async () => {
	let harness;
	let collectionStarted = false;
	let invalidateEarlier = true;
	harness = createHarness({
		getBatchEngineKey: () => {
			collectionStarted = true;
			return "ai";
		},
		createTranslationSignature: (message, channelId) => {
			if (collectionStarted && invalidateEarlier && String(message.id) === "old") {
				invalidateEarlier = false;
				harness.queue.setBusyTranslating(true);
				harness.queue.invalidateRequestForMessage("new", channelId, `${channelId}|edited-new`);
			}
			return `${channelId}|${message.content}`;
		}
	});
	harness.state.batch = true;
	harness.queue.setBusyTranslating(true);
	harness.add("old", "c1");
	harness.add("new", "c1");
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();

	assert.deepEqual(harness.calls.burst, [], "a later check cannot authorize a partial physical request before restore/replan");
	assert.deepEqual(harness.calls.single, []);
	assert.deepEqual(harness.queue.getQueueSnapshot().map(item => item.message.id), ["old"], "the stable current snapshot is restored in frozen order");
	assert.equal(harness.queue.isMessageQueued("new"), false, "the newly stale exact identity is retired");
	assert.equal(harness.queue.isMessageQueued("old"), true, "the stable identity remains queued for replan");
	assert.deepEqual(harness.calls.active, [1, 0], "the aborted plan releases its token exactly once");

	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();
	await settle();

	assert.deepEqual(harness.calls.burst, [["old"]], "replan preserves the one-shot burst path without the stale payload");
	assert.deepEqual(harness.calls.single, []);
	assert.ok(harness.calls.burst.flat().every(id => id !== "new"), "no provider payload contains the invalidated earlier item");
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
	assert.equal(harness.queue.isQueueEmpty(), true);
});

test("round-five final burst fence catches the second prepare callback invalidating the first payload", async () => {
	let harness;
	let invalidateFirstPrepared = true;
	const diagnostics = [];
	harness = createHarness({
		prepareBurstItem: (queueItem, channelId) => {
			if (invalidateFirstPrepared && String(queueItem.message.id) === "old") {
				invalidateFirstPrepared = false;
				harness.queue.setBusyTranslating(true);
				harness.queue.invalidateRequestForMessage("new", channelId, `${channelId}|edited-new`);
			}
			return {
				queueItem,
				message: queueItem.message,
				signature: `${channelId}|${queueItem.message.content}`,
				protectedText: queueItem.message.content
			};
		},
		observer: {notify(type, payload) {
			if (type === "lane-active") harness.calls.active.push(payload.active);
			if (type === "burst-request" || type === "dispatched") diagnostics.push({type, payload});
		}}
	});
	harness.state.batch = true;
	harness.queue.setBusyTranslating(true);
	harness.add("old", "c1");
	harness.add("new", "c1");
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();

	assert.deepEqual(harness.calls.burst, [], "all preparation callbacks complete before a zero-stale physical-request fence");
	assert.deepEqual(diagnostics, [], "an aborted provider turn emits no dispatched/request diagnostics");
	assert.deepEqual(harness.queue.getQueueSnapshot().map(item => item.message.id), ["old"]);
	assert.equal(harness.queue.isMessageQueued("new"), false);
	assert.equal(harness.queue.isMessageQueued("old"), true);
	assert.deepEqual(harness.calls.active, [1, 0]);

	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();
	await settle();

	assert.deepEqual(harness.calls.burst, [["old"]], "the restored payload is the only physical request");
	assert.deepEqual(harness.calls.single, []);
	assert.ok(harness.calls.burst.flat().every(id => id !== "new"), "the invalidated prepared item never reaches the provider");
	assert.equal(diagnostics.filter(event => event.type === "burst-request").length, 1);
	assert.deepEqual(diagnostics.filter(event => event.type === "dispatched").map(event => event.payload.messageId), ["old"]);
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
	assert.equal(harness.queue.isQueueEmpty(), true);
});

test("round-five adjudicated burst abort preserves reservation and publishes consumption only on physical replan", async () => {
	let harness;
	let invalidateDuringPrepare = true;
	harness = createHarness({
		prepareBurstItem: (queueItem, channelId) => {
			if (invalidateDuringPrepare && String(queueItem.message.id) === "companion") {
				invalidateDuringPrepare = false;
				harness.queue.setBusyTranslating(true);
				harness.queue.invalidateRequestForMessage("companion", channelId, `${channelId}|edited-companion`);
			}
			return {
				queueItem,
				message: queueItem.message,
				signature: `${channelId}|${queueItem.message.content}`,
				protectedText: queueItem.message.content
			};
		}
	});
	harness.state.batch = true;
	harness.queue.setBusyTranslating(true);
	harness.add("reserved", "c1");
	const reservedTicket = harness.queue.reserveQueuedLiveRequest("c1");
	harness.add("companion", "c1");
	harness.add("newer", "c2");
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();

	assert.deepEqual(harness.calls.burst, [], "the invalid prepared plan aborts before a physical provider");
	assert.deepEqual(harness.calls.single, []);
	assert.deepEqual(harness.queue.getQueueSnapshot().map(item => item.message.id), ["newer", "reserved"], "the exact frozen order is restored");
	assert.equal(harness.queue.isMessageQueued("companion"), false);
	assert.equal(harness.queue.isMessageQueued("reserved"), true);
	assert.deepEqual(harness.calls.consumed, [], "an aborted plan does not publish historical handoff consumption");
	assert.equal(harness.queue.getLastConsumedLiveRequestTicket("c1"), null, "an aborted plan does not advance lastConsumed");
	assert.equal(harness.queue.getStartedLiveTurnCount("c1"), 0, "an aborted plan does not publish a started turn");
	assert.deepEqual(harness.calls.active, [1, 0]);

	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();
	await settle();

	assert.deepEqual(harness.calls.burst, [["reserved"]], "the retained reservation dispatches before the newer unrelated head");
	assert.deepEqual(harness.calls.single, ["newer"]);
	assert.deepEqual(harness.calls.consumed, [[String(reservedTicket), "burst"]], "the physical replan consumes the reservation exactly once");
	assert.equal(harness.queue.getLastConsumedLiveRequestTicket("c1"), String(reservedTicket));
	assert.equal(harness.queue.getStartedLiveTurnCount("c1"), 1);
	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0, 1, 0]);
	assert.equal(harness.queue.isQueueEmpty(), true);
});

test("round-five adjudicated single abort publishes neither turn nor consumption before its final fence", async () => {
	let harness;
	let invalidateOnClockRead = false;
	harness = createHarness({
		now: () => {
			if (invalidateOnClockRead) {
				invalidateOnClockRead = false;
				harness.queue.setBusyTranslating(true);
				harness.queue.invalidateRequestForMessage("reserved", "c1", "c1|edited-reserved");
			}
			return 100;
		}
	});
	harness.queue.setBusyTranslating(true);
	harness.add("reserved", "c1");
	harness.queue.reserveQueuedLiveRequest("c1");
	harness.add("newer", "c2");
	invalidateOnClockRead = true;
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();

	assert.deepEqual(harness.calls.single, []);
	assert.equal(harness.queue.getLastConsumedLiveRequestTicket("c1"), null);
	assert.equal(harness.queue.getStartedLiveTurnCount("c1"), 0, "a final-fence abort is not a started physical turn");
	assert.deepEqual(harness.calls.consumed, []);
	assert.deepEqual(harness.queue.getQueueSnapshot().map(item => item.message.id), ["newer"]);
	assert.deepEqual(harness.calls.active, [1, 0]);

	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();
	assert.deepEqual(harness.calls.single, ["newer"]);
	assert.equal(harness.queue.getStartedLiveTurnCount("c2"), 1);
	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
	assert.equal(harness.queue.isQueueEmpty(), true);
});

test("round-five adjudicated throwing post-invocation hooks cannot orphan a started provider promise", async () => {
	let harness;
	const provider = createDeferred();
	const order = [];
	harness = createHarness({
		translateSingleItem: queueItem => {
			harness.calls.single.push(String(queueItem.message.id));
			order.push("provider");
			return provider.promise;
		},
		onLiveTurnStarted: () => {
			order.push("turn");
			throw new Error("turn hook exploded after invocation");
		},
		onReservedLiveRequestConsumed: (_channelId, ticket, reason) => {
			harness.calls.consumed.push([String(ticket), reason]);
			order.push("handoff");
			throw new Error("handoff hook exploded after invocation");
		}
	});
	harness.queue.setBusyTranslating(true);
	harness.add("hooked", "c1");
	const ticket = harness.queue.reserveQueuedLiveRequest("c1");
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();

	assert.deepEqual(order, ["provider", "turn", "handoff"], "the physical callback is first and each publication hook is independently guarded");
	assert.deepEqual(harness.calls.single, ["hooked"]);
	assert.deepEqual(harness.calls.consumed, [[String(ticket), "single"]]);
	assert.equal(harness.queue.getLastConsumedLiveRequestTicket("c1"), String(ticket));
	assert.equal(harness.queue.getStartedLiveTurnCount("c1"), 1);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1, "the lease remains held while the started provider promise is pending");
	assert.equal(harness.queue.isMessageQueued("hooked"), true);

	provider.resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0]);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	assert.equal(harness.queue.isMessageQueued("hooked"), false);
});

test("round-five adjudicated synchronous provider throw still publishes one attempted turn and handoff", async () => {
	let harness;
	const order = [];
	harness = createHarness({
		translateSingleItem: queueItem => {
			harness.calls.single.push(String(queueItem.message.id));
			order.push("provider");
			throw new Error("synchronous provider throw");
		},
		onLiveTurnStarted: () => order.push("turn"),
		onReservedLiveRequestConsumed: (_channelId, ticket, reason) => {
			harness.calls.consumed.push([String(ticket), reason]);
			order.push("handoff");
		}
	});
	harness.queue.setBusyTranslating(true);
	harness.add("sync-throw", "c1");
	const ticket = harness.queue.reserveQueuedLiveRequest("c1");
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();
	await settle();

	assert.deepEqual(order, ["provider", "turn", "handoff"]);
	assert.deepEqual(harness.calls.single, ["sync-throw"]);
	assert.deepEqual(harness.calls.consumed, [[String(ticket), "single"]]);
	assert.equal(harness.queue.getLastConsumedLiveRequestTicket("c1"), String(ticket));
	assert.equal(harness.queue.getStartedLiveTurnCount("c1"), 1);
	assert.deepEqual(harness.calls.active, [1, 0]);
	assert.equal(harness.queue.isMessageQueued("sync-throw"), false);
});

test("round-five turn hook runs only after the final single fence and physical invocation", async () => {
	let harness;
	let invalidateAtTurn = true;
	const diagnostics = [];
	harness = createHarness({
		onLiveTurnStarted: channelId => {
			if (!invalidateAtTurn) return;
			invalidateAtTurn = false;
			harness.queue.setBusyTranslating(true);
			harness.queue.invalidateRequestForMessage("single", channelId, `${channelId}|edited-single`);
		},
		observer: {notify(type, payload) {
			if (type === "lane-active") harness.calls.active.push(payload.active);
			if (type === "dispatched") diagnostics.push(payload);
		}}
	});

	harness.add("single", "c1");
	await settle();

	assert.deepEqual(harness.calls.single, ["single"], "the stable provider payload is invoked before turn publication");
	assert.deepEqual(diagnostics.map(payload => payload.messageId), ["single"], "the physical attempt remains truthfully dispatched");
	assert.deepEqual(harness.calls.active, [1]);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1, "turn-hook invalidation does not release a physically running lease");
	assert.equal(harness.queue.isMessageQueued("single"), false);
	assert.equal(harness.queue.isQueueEmpty(), true);
	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0]);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
});

test("round-five currentness instability is bounded and fails closed without stranding planning", () => {
	let harness;
	let mutationCount = 0;
	harness = createHarness({
		createTranslationSignature: (message, channelId) => {
			if (String(message.id) === "unstable") {
				mutationCount++;
				harness.queue.invalidateRequests(`noise-${mutationCount}`);
			}
			return `${channelId}|${message.content}`;
		}
	});

	assert.doesNotThrow(() => harness.add("unstable", "c1"));

	assert.ok(mutationCount > 2, "the hook kept mutating across the required stable passes");
	assert.ok(mutationCount < 20, "classification terminates at a plan-sized bound");
	assert.deepEqual(harness.calls.burst, []);
	assert.deepEqual(harness.calls.single, [], "an unstable classifier never reaches a physical provider");
	assert.deepEqual(harness.calls.active, [1, 0]);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	assert.equal(harness.queue.isMessageQueued("unstable"), false);
	assert.equal(harness.queue.isQueueEmpty(), true);
});

test("round-five retirement hooks repeat the fixed point until no current identity becomes stale", () => {
	let harness;
	let selectedItem = null;
	let editSelected = true;
	let invalidateRemaining = true;
	harness = createHarness({
		getBatchEngineKey: () => {
			if (editSelected) {
				editSelected = false;
				selectedItem.message.content = "edited-new";
			}
			return "ai";
		},
		releaseDisplayPending: record => {
			if (!invalidateRemaining || record.messageId !== "new") return;
			invalidateRemaining = false;
			harness.queue.invalidateRequestForMessage("old", "c1", "c1|edited-old");
		}
	});
	harness.state.batch = true;
	harness.queue.setBusyTranslating(true);
	harness.add("old", "c1");
	harness.add("new", "c1");
	selectedItem = harness.queue.getQueueSnapshot()[0];
	harness.queue.setBusyTranslating(false);

	harness.queue.processQueue();

	assert.deepEqual(harness.calls.burst, []);
	assert.deepEqual(harness.calls.single, [], "retirement-invalidated remaining work is reclassified before provider dispatch");
	assert.deepEqual(harness.calls.active, [1, 0]);
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	assert.equal(harness.queue.isMessageQueued("new"), false);
	assert.equal(harness.queue.isMessageQueued("old"), false);
	assert.equal(harness.queue.isQueueEmpty(), true, "no stale identity is restored after retirement callbacks");
});

test("a throwing post-acquire current fence fails closed and resumes lane-zero nested work once", async () => {
	let queue;
	let currentChecks = 0;
	let enqueueNested = true;
	const active = [];
	const providerCalls = [];
	const deferrals = [];
	queue = createLiveTranslationQueue({
		isTranslationEnabled: () => {
			currentChecks++;
			if (currentChecks === 2) throw new Error("current fence exploded");
			return true;
		},
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
		shouldAutoTranslateMessage: () => true,
		translateSingleItem: item => {
			providerCalls.push(String(item.message.id));
			const deferred = createDeferred();
			deferrals.push(deferred);
			return deferred.promise;
		},
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 0 || !enqueueNested) return;
			enqueueNested = false;
			queue.queueMessage({id: "nested", channelId: "c1", content: "nested"}, {id: "c1"});
		}}
	});

	assert.doesNotThrow(() => queue.queueMessage({id: "throwing", channelId: "c1", content: "throwing"}, {id: "c1"}));

	assert.deepEqual(providerCalls, ["nested"], "the failed plan is terminal and only nested current work dispatches");
	assert.deepEqual(active, [1, 0, 1], "release publication reentry resumes after planning without duplicate acquisition");
	assert.equal(queue.isMessageQueued("throwing"), false);
	assert.equal(queue.isMessageQueued("nested"), true);
	assert.equal(queue.getLiveSlotActiveCount(), 1);
	assert.equal(deferrals.length, 1);

	deferrals[0].resolve();
	await settle();
	assert.deepEqual(active, [1, 0, 1, 0]);
	assert.equal(queue.isMessageQueued("nested"), false);
	assert.equal(queue.isQueueEmpty(), true);
});

test("inactive clear resets after throwing release cleanup and preserves lane-zero nested state", async () => {
	let queue;
	let runtimeActive = true;
	let reentered = false;
	const nestedMessage = {id: "new", channelId: "c1", content: "new"};
	const calls = [];
	const active = [];
	const deferrals = [];
	queue = createLiveTranslationQueue({
		isRuntimeActive: () => runtimeActive,
		isTranslationEnabled: () => true,
		extractOriginalContentData: message => ({content: message.content}),
		createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
		shouldAutoTranslateMessage: () => true,
		releaseDisplayPending: request => {
			if (request.messageId === "old") throw new Error("release exploded");
		},
		translateSingleItem: item => {
			calls.push(String(item.message.id));
			const deferred = createDeferred();
			deferrals.push(deferred);
			return deferred.promise;
		},
		observer: {notify(type, payload) {
			if (type !== "lane-active") return;
			active.push(payload.active);
			if (payload.active !== 0 || reentered) return;
			reentered = true;
			runtimeActive = true;
			queue.processQueue();
			queue.queueMessage(nestedMessage, {id: "c1"});
		}}
	});

	queue.setLiveAutoTranslating(true);
	queue.queueMessage({id: "old", channelId: "c1", content: "old"}, {id: "c1"});
	runtimeActive = false;
	assert.throws(() => queue.clearQueue(), /release exploded/);

	assert.deepEqual(calls, ["new"], "the cleared old request never reaches provider dispatch");
	assert.deepEqual(active, [1, 0, 1], "stop reset still publishes after the throwing release hook");
	assert.equal(queue.getRuntimeGeneration(), 1);
	assert.equal(queue.isMessageQueued("old"), false);
	assert.equal(queue.isMessageQueued("new"), true, "outer stop cleanup does not erase nested new state");
	assert.equal(queue.isRequestCurrent(queue.getQueuedMarker("new"), nestedMessage), true, "nested work belongs to the published generation");
	assert.equal(queue.getLastConsumedLiveRequestTicket("c1"), "2");

	deferrals[0].resolve();
	await settle();
	assert.deepEqual(active, [1, 0, 1, 0]);
});

test("private provider runners are not exposed on the queue compatibility surface", () => {
	const harness = createHarness();
	assert.equal(Object.prototype.hasOwnProperty.call(harness.queue, "translateSingle"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(harness.queue, "translateBurst"), false);
	assert.equal(harness.queue.translateSingle, undefined, "the old one-argument single runner cannot bypass acquisition");
	assert.equal(harness.queue.translateBurst, undefined, "the old one-argument burst runner cannot bypass acquisition");
});

test("a throwing post-invocation single-turn hook cannot orphan its acquired lease", async () => {
	const harness = createHarness({
		onLiveTurnStarted: () => {throw new Error("turn hook exploded");}
	});

	assert.doesNotThrow(() => harness.add("m1"));
	assert.deepEqual(harness.calls.single, ["m1"], "the provider starts before the guarded publication hook");
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1, "the hook throw cannot release a still-running provider");
	harness.deferrals[0].resolve();
	await settle();
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	assert.deepEqual(harness.calls.active, [1, 0], "the physical completion releases exactly once");
});

test("inactive global clear and generation restart make late completion stale against a new lease", async () => {
	const harness = createHarness();
	harness.add("old");
	harness.state.runtimeActive = false;
	harness.queue.clearQueue();
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0, "stop-only global clear resets logical ownership");

	harness.state.runtimeActive = true;
	harness.queue.restartRequestGeneration();
	harness.add("new");
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1);
	harness.deferrals[0].resolve();
	await settle();
	assert.equal(harness.queue.getLiveSlotActiveCount(), 1, "the old provider completion cannot unlock the new generation");
	assert.deepEqual(harness.calls.single, ["old", "new"]);

	harness.deferrals[1].resolve();
	await settle();
	assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0], "stale release emits no duplicate zero");
});

test("active global and channel clear retain the physical provider lease", async () => {
	for (const clear of [queue => queue.clearQueue(), queue => queue.clearQueue("c1")]) {
		const harness = createHarness();
		harness.add("running", "c1");
		harness.add("waiting", "c1");
		clear(harness.queue);
		harness.queue.setLiveAutoTranslating(false);

		assert.equal(harness.queue.getLiveSlotActiveCount(), 1);
		assert.deepEqual(harness.calls.single, ["running"]);
		harness.deferrals[0].resolve();
		await settle();
		assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
		assert.deepEqual(harness.calls.active, [1, 0]);
	}
});

test("single success, rejection, synchronous throw and scalar return each release exactly once", async () => {
	for (const outcome of ["success", "rejection", "sync-throw", "scalar"]) {
		const active = [];
		const queue = createLiveTranslationQueue({
			isTranslationEnabled: () => true,
			extractOriginalContentData: message => ({content: message.content}),
			createTranslationSignature: (message, channelId) => `${channelId}|${message.content}`,
			shouldAutoTranslateMessage: () => true,
			translateSingleItem: () => {
				if (outcome === "rejection") return Promise.reject(new Error("provider rejected"));
				if (outcome === "sync-throw") throw new Error("provider threw");
				if (outcome === "scalar") return 42;
				return Promise.resolve("ok");
			},
			observer: {notify: (type, payload) => {if (type === "lane-active") active.push(payload.active);}}
		});

		assert.doesNotThrow(() => queue.queueMessage({id: outcome, content: outcome}, {id: "c1"}), outcome);
		await settle();
		assert.equal(queue.getLiveSlotActiveCount(), 0, outcome);
		assert.deepEqual(active, [1, 0], outcome);
	}
});

test("burst success and thrown preparation, request, or commit release one lease", async () => {
	for (const outcome of ["success", "prepare-throw", "request-reject", "commit-throw"]) {
		let harness;
		harness = createHarness({
			createBurstContext: channelId => {
				if (outcome === "prepare-throw") throw new Error("prepare exploded");
				return {channelId};
			},
			requestBurstTranslation: (_context, prepared) => {
				harness.calls.burst.push(prepared.map(item => String(item.message.id)));
				if (outcome === "request-reject") {
					harness.queue.setBusyTranslating(true);
					return Promise.reject(new Error("request exploded"));
				}
				return Promise.resolve(Object.fromEntries(prepared.map(item => [String(item.message.id), "translated"])));
			},
			commitBurstResult: queueItem => {
				if (outcome === "commit-throw") {
					harness.queue.setBusyTranslating(true);
					throw new Error("commit exploded");
				}
				harness.calls.commits.push(String(queueItem.message.id));
				return Promise.resolve();
			}
		});
		harness.state.batch = true;
		harness.queue.setBusyTranslating(true);
		harness.add(`${outcome}-1`);
		harness.add(`${outcome}-2`);
		harness.queue.setBusyTranslating(false);
		harness.queue.processQueue();
		await settle();

		assert.equal(harness.queue.getLiveSlotActiveCount(), 0, outcome);
		assert.deepEqual(harness.calls.active, [1, 0], outcome);
	}
});

test("lane-active late arrival is excluded from the frozen burst and runs next", async () => {
	let harness;
	let injectLate = true;
	harness = createHarness({
		observer: {notify(type, payload) {
			if (type === "lane-active") harness.calls.active.push(payload.active);
			if (type !== "lane-active" || payload.active !== 1 || !injectLate) return;
			injectLate = false;
			harness.add("late", "c1");
		}}
	});
	harness.state.batch = true;
	harness.queue.setBusyTranslating(true);
	harness.add("old", "c1");
	harness.add("new", "c1");
	harness.queue.setBusyTranslating(false);
	harness.queue.processQueue();
	await settle();

	assert.deepEqual(harness.calls.burst, [["new", "old"]], "acquisition observers cannot widen the frozen burst membership");
	assert.deepEqual(harness.calls.single, ["late"], "the late arrival stays queued for the next physical turn");
	assert.equal(harness.calls.burst.length, 1);
	assert.equal(harness.calls.single.length, 1);
	assert.deepEqual(harness.calls.active, [1, 0, 1]);

	harness.deferrals[0].resolve();
	await settle();
	assert.deepEqual(harness.calls.active, [1, 0, 1, 0]);
	assert.equal(harness.queue.isQueueEmpty(), true);
	for (const id of ["old", "new", "late"]) assert.equal(harness.queue.isMessageQueued(id), false, `marker ${id} cleared`);
});

test("deterministic equivalence matrix preserves ordering and never exceeds cap=1", async t => {
	const cases = [
		{
			name: "arrival-newest-first",
			setup(h) {h.queue.setBusyTranslating(true); h.add("old"); h.add("new"); h.queue.setBusyTranslating(false); h.queue.processQueue();},
			expected: ["new", "old"]
		},
		{
			name: "rejection-resume",
			firstRejects: true,
			setup(h) {h.queue.setBusyTranslating(true); h.add("old"); h.add("new"); h.queue.setBusyTranslating(false); h.queue.processQueue();},
			expected: ["new", "old"]
		},
		{
			name: "manual-lock",
			setup(h) {h.queue.setBusyTranslating(true); h.add("only"); assert.deepEqual(h.calls.single, []); h.queue.setBusyTranslating(false); h.queue.processQueue();},
			expected: ["only"]
		},
		{
			name: "backoff",
			setup(h) {h.state.backoff = true; h.add("old"); h.add("new"); assert.deepEqual(h.calls.single, []); h.state.backoff = false; h.timers.shift().callback();},
			expected: ["new", "old"]
		},
		{
			name: "handoff-reservation",
			setup(h) {h.queue.setBusyTranslating(true); h.add("reserved", "c1"); h.queue.reserveQueuedLiveRequest("c1"); h.add("new", "c2"); h.queue.setBusyTranslating(false); h.queue.processQueue();},
			expected: ["reserved", "new"]
		}
	];

	for (const matrixCase of cases) {
		await t.test(matrixCase.name, async () => {
			let callCount = 0;
			const harness = createHarness({
				translateSingleItem: queueItem => {
					harness.calls.single.push(String(queueItem.message.id));
					callCount++;
					return matrixCase.firstRejects && callCount === 1 ? Promise.reject(new Error("expected")) : Promise.resolve();
				}
			});
			matrixCase.setup(harness);
			await settle();
			await settle();
			assert.deepEqual(harness.calls.single, matrixCase.expected);
			assert.ok(harness.calls.active.every(count => count === 0 || count === 1));
			assert.equal(Math.max(0, ...harness.calls.active), 1);
			assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
		});
	}

	await t.test("burst grouping", async () => {
		const harness = createHarness();
		harness.state.batch = true;
		harness.queue.setBusyTranslating(true);
		harness.add("old");
		harness.add("middle");
		harness.add("new");
		harness.queue.setBusyTranslating(false);
		harness.queue.processQueue();
		await settle();
		assert.deepEqual(harness.calls.burst, [["new", "middle", "old"]]);
		assert.deepEqual(harness.calls.active, [1, 0]);
		assert.equal(Math.max(...harness.calls.active), 1);
		assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
	});
});

test("full 3! single-arrival matrix preserves reverse order through success/rejection and every gate", async t => {
	const arrivals = permutations(["a", "b", "c"]);
	for (const arrival of arrivals) {
		for (const outcome of ["success", "rejection"]) {
			for (const gate of ["none", "manual", "backoff"]) {
				const label = `${arrival.join("")}/${outcome}/${gate}`;
				await t.test(label, async () => {
					const harness = createHarness();
					// A deterministic arrival barrier lets all six arrival permutations reach
					// the same gate with identical queue state; it is removed before the gate.
					harness.queue.setBusyTranslating(true);
					for (const id of arrival) harness.add(id);
					if (gate === "backoff") harness.state.backoff = true;
					if (gate === "manual") {
						harness.queue.processQueue();
						assert.deepEqual(harness.calls.single, [], `${label}: manual lock blocks`);
					}
					harness.queue.setBusyTranslating(false);
					harness.queue.processQueue();
					if (gate === "backoff") {
						assert.deepEqual(harness.calls.single, [], `${label}: backoff blocks without a lease`);
						assert.equal(harness.timers.length, 1, `${label}: exactly one retry is armed`);
						harness.state.backoff = false;
						harness.timers.shift().callback();
					}

					const turns = await drainControlledSingles(harness, outcome);
					assert.deepEqual(harness.calls.single, arrival.slice().reverse(), `${label}: newest-first is reverse arrival`);
					assertExactTurns(harness.calls.active, turns, label);
					assert.equal(turns, 3);
					assert.equal(harness.queue.isQueueEmpty(), true);
					for (const id of arrival) assert.equal(harness.queue.isMessageQueued(id), false, `${label}: marker ${id} cleared`);
					assert.equal(harness.queue.hasPendingQueueRetry(), false);
				});
			}
		}
	}
});

test("full 3! same-channel burst matrix preserves reverse order on success and request failure", async t => {
	for (const arrival of permutations(["a", "b", "c"])) {
		for (const outcome of ["success", "request-failure"]) {
			const label = `${arrival.join("")}/${outcome}`;
			await t.test(label, async () => {
				let harness;
				harness = createHarness({
					requestBurstTranslation: (_context, prepared) => {
						harness.calls.burst.push(prepared.map(item => String(item.message.id)));
						if (outcome === "request-failure") return Promise.reject(new Error("expected burst rejection"));
						return Promise.resolve(Object.fromEntries(prepared.map(item => [String(item.message.id), `translated-${item.message.content}`])));
					},
					resolveBurstItemResult: (preparedItem, resultMap) => resultMap
						? {status: "translated", result: {translation: resultMap[String(preparedItem.message.id)]}}
						: {status: "skipped", result: {status: "skipped"}}
				});
				harness.state.batch = true;
				harness.queue.setBusyTranslating(true);
				for (const id of arrival) harness.add(id, "same");
				harness.queue.setBusyTranslating(false);
				harness.queue.processQueue();
				await settle();
				await settle();

				assert.deepEqual(harness.calls.burst, [arrival.slice().reverse()], `${label}: burst is reverse arrival`);
				assertExactTurns(harness.calls.active, 1, label);
				assert.equal(harness.queue.isQueueEmpty(), true);
				for (const id of arrival) assert.equal(harness.queue.isMessageQueued(id), false, `${label}: marker ${id} cleared`);
			});
		}
	}
});

test("all handoff/compatibility/restart interleavings preserve identity, ordering, and cleanup", async t => {
	for (const order of permutations(["handoff", "compat", "restart"])) {
		const label = order.join("-");
		await t.test(label, async () => {
			const harness = createHarness();
			harness.queue.setBusyTranslating(true);
			for (const operation of order) {
				if (operation === "handoff") {
					harness.add("handoff", "c1");
					harness.queue.reserveQueuedLiveRequest("c1");
				}
				else if (operation === "compat") harness.queue.setLiveAutoTranslating(true);
				else harness.queue.restartRequestGeneration();
			}
			harness.add("tail", "c2");
			harness.queue.setLiveAutoTranslating(false);
			harness.queue.setBusyTranslating(false);
			harness.queue.processQueue();

			const handoffSurvives = order.indexOf("handoff") > order.indexOf("restart");
			const turns = await drainControlledSingles(harness, "success");
			assert.deepEqual(harness.calls.single, handoffSurvives ? ["handoff", "tail"] : ["tail"], `${label}: only current-generation handoff can outrank the newer tail`);
			assertExactTurns(harness.calls.active, turns + 1, `${label}: compatibility plus provider ownership`);
			assert.equal(harness.queue.isQueueEmpty(), true);
			assert.equal(harness.queue.isMessageQueued("handoff"), false, `${label}: stale/current handoff marker cleared`);
			assert.equal(harness.queue.isMessageQueued("tail"), false, `${label}: tail marker cleared`);
			assert.equal(harness.queue.getLiveSlotActiveCount(), 0);
		});
	}
});
