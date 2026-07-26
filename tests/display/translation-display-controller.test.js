const test = require("node:test");
const assert = require("node:assert/strict");
const {createMessageStateStore} = require("../../src/display/message-state-store");
const {
	createDisplayView,
	createTranslationDisplayController
} = require("../../src/display/translation-display-controller");

function getSourceSignature(messageId, channelId) {
	return `${channelId}:${messageId}`;
}

function capture(store, messageId, channelId = "c1") {
	return store.captureSource({
		messageId,
		channelId,
		generation: 1,
		sourceSignature: getSourceSignature(messageId, channelId),
		source: {content: `${messageId} source`, embeds: []}
	});
}

function pendingRequest(messageId, channelId = "c1", requestIdentity = `${channelId}:${messageId}:request`, origin = "automatic") {
	return {messageId, channelId, generation: 1, origin, requestIdentity};
}

function result(messageId, channelId = "c1", origin = "automatic", requestIdentity = null) {
	return {
		messageId,
		channelId,
		generation: 1,
		sourceSignature: getSourceSignature(messageId, channelId),
		origin,
		requestIdentity,
		status: "translated",
		translation: {content: `${messageId} translated`}
	};
}

function createHarness(renderOutcome) {
	const refreshes = [];
	const store = createMessageStateStore();
	const renderAdapter = {
		async refreshMessages(request) {
			refreshes.push(request);
			return renderOutcome ? renderOutcome(request) : {
				confirmedIds: request.messageIds,
				missingIds: [],
				fallbackUsed: false
			};
		}
	};
	return {store, refreshes, controller: createTranslationDisplayController({store, renderAdapter})};
}

function createDeferred() {
	let resolve;
	const promise = new Promise(resolvePromise => {resolve = resolvePromise;});
	return {promise, resolve};
}

function emptyOutcome() {
	return {confirmedIds: [], missingIds: [], fallbackUsed: false};
}

test("createDisplayView returns null for missing state", () => {
	assert.equal(createDisplayView(null), null);
});

test("createDisplayView freezes the complete translated projection", () => {
	const store = createMessageStateStore();
	capture(store, "m1");
	const state = store.commitResult(result("m1"));

	const view = createDisplayView(state);

	assert.deepEqual(Object.keys(view), [
		"messageId",
		"channelId",
		"revision",
		"status",
		"content",
		"translated",
		"showWatermark",
		"showLoading",
		"reason",
		"renderStatus",
		"renderReason",
		"translation",
		"source",
		"origin",
		"generation",
		"sourceSignature",
		"requestIdentity"
	]);
	assert.equal(Object.isFrozen(view), true);
	assert.equal(view.messageId, "m1");
	assert.equal(view.channelId, "c1");
	assert.equal(view.revision, state.revision);
	assert.equal(view.status, "translated");
	assert.equal(view.content, "m1 translated");
	assert.equal(view.translated, true);
	assert.equal(view.showWatermark, true);
	assert.equal(view.showLoading, false);
	assert.equal(view.reason, null);
	assert.equal(view.renderStatus, "pending");
	assert.equal(view.renderReason, null);
	assert.equal(view.translation, state.translation);
	assert.equal(view.source, state.source);
	assert.equal(view.origin, "automatic");
});

test("createDisplayView uses translated content only for a translated state with a translation", () => {
	const source = Object.freeze({content: "immutable source"});
	const translation = Object.freeze({content: "translated content"});
	const baseState = {
		messageId: "m1",
		channelId: "c1",
		revision: 7,
		reason: null,
		renderStatus: "pending",
		renderReason: null,
		source,
		origin: "automatic"
	};
	const cases = [
		["translated", translation, true, false],
		["translated", null, false, false],
		["pending", translation, false, true],
		["translating", translation, false, true],
		["idle", translation, false, false],
		["failed", null, false, false]
	];

	for (const [status, stateTranslation, translated, showLoading] of cases) {
		const view = createDisplayView({...baseState, status, translation: stateTranslation});
		assert.equal(view.content, translated ? "translated content" : "immutable source", status);
		assert.equal(view.translated, translated, status);
		assert.equal(view.showWatermark, translated, status);
		assert.equal(view.showLoading, showLoading, status);
		assert.equal(view.source, source, status);
	}
});

test("one result refreshes text and decoration under one revision", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");

	const outcome = await controller.commitMessageResult(result("m1"));

	assert.deepEqual(outcome, {confirmedIds: ["m1"], missingIds: [], fallbackUsed: false});
	assert.equal(refreshes.length, 1);
	assert.equal(refreshes[0].transactionId, 1);
	assert.equal(refreshes[0].channelId, "c1");
	assert.deepEqual(refreshes[0].messageIds, ["m1"]);
	assert.equal(refreshes[0].views.length, 1);
	assert.equal(refreshes[0].views[0].content, "m1 translated");
	assert.equal(refreshes[0].views[0].translated, true);
	assert.equal(refreshes[0].views[0].showWatermark, true);
	assert.equal(refreshes[0].views[0].revision, store.getDisplayState("m1").revision);
	assert.equal(store.getDisplayState("m1").renderStatus, "confirmed");
});

test("one historical three-message batch creates exactly one coherent refresh", async () => {
	const {store, refreshes, controller} = createHarness();
	for (const messageId of ["m1", "m2", "m3"]) capture(store, messageId);

	await controller.commitHistoricalBatch([result("m1"), result("m2"), result("m3")]);

	assert.equal(refreshes.length, 1);
	assert.equal(refreshes[0].transactionId, 1);
	assert.equal(refreshes[0].channelId, "c1");
	assert.deepEqual(refreshes[0].messageIds, ["m1", "m2", "m3"]);
	assert.deepEqual(refreshes[0].views.map(view => view.messageId), ["m1", "m2", "m3"]);
	assert.deepEqual(refreshes[0].views.map(view => view.content), ["m1 translated", "m2 translated", "m3 translated"]);
	assert.equal(refreshes[0].views.every(view => view.channelId === "c1" && view.translated && view.showWatermark), true);
});

test("restoreChannel refreshes original automatic content once and leaves manual translation", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "automatic");
	capture(store, "manual");
	store.commitResult(result("automatic"));
	store.commitResult(result("manual", "c1", "manual"));

	await controller.restoreChannel("c1");

	assert.equal(refreshes.length, 1);
	assert.deepEqual(refreshes[0].messageIds, ["automatic"]);
	assert.equal(refreshes[0].views[0].content, "automatic source");
	assert.equal(refreshes[0].views[0].translated, false);
	assert.equal(refreshes[0].views[0].showWatermark, false);
	assert.equal(refreshes[0].views[0].showLoading, false);
	assert.equal(controller.getDisplayView("manual").content, "manual translated");
	assert.equal(controller.getDisplayView("manual").translated, true);
});

test("missing acknowledgement remains inspectable without changing the display revision", async () => {
	const {store, refreshes, controller} = createHarness(request => ({
		confirmedIds: [],
		missingIds: request.messageIds,
		fallbackUsed: true
	}));
	capture(store, "m1");

	const outcome = await controller.commitMessageResult(result("m1"));
	const view = controller.getDisplayView("m1");

	assert.deepEqual(outcome, {confirmedIds: [], missingIds: ["m1"], fallbackUsed: true});
	assert.equal(view.revision, refreshes[0].views[0].revision);
	assert.equal(view.renderStatus, "unconfirmed");
	assert.equal(view.renderReason, "render-unconfirmed");
	assert.equal(view.translated, true);
});

test("markPending refreshes a loading source view", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");

	const outcome = await controller.markPending(pendingRequest("m1"));

	assert.deepEqual(outcome, {confirmedIds: ["m1"], missingIds: [], fallbackUsed: false});
	assert.equal(refreshes.length, 1);
	assert.deepEqual(refreshes[0].messageIds, ["m1"]);
	assert.equal(refreshes[0].views[0].status, "pending");
	assert.equal(refreshes[0].views[0].content, "m1 source");
	assert.equal(refreshes[0].views[0].translated, false);
	assert.equal(refreshes[0].views[0].showLoading, true);
	assert.equal(store.getDisplayState("m1").requestIdentity, "c1:m1:request");
});

test("commitMessageResult can defer refresh without losing the committed translation", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");

	const outcome = await controller.commitMessageResult(result("m1"), {refresh: false});

	assert.deepEqual(outcome, {
		confirmedIds: [],
		missingIds: [],
		fallbackUsed: false,
		deferredIds: ["m1"]
	});
	assert.equal(refreshes.length, 0);
	assert.equal(store.getDisplayState("m1").status, "translated");
	assert.equal(store.getDisplayState("m1").renderStatus, "pending");
});

test("markPending can defer refresh without losing the committed state", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");

	const outcome = await controller.markPending(pendingRequest("m1"), {refresh: false});

	assert.deepEqual(outcome, {
		confirmedIds: [],
		missingIds: [],
		fallbackUsed: false,
		deferredIds: ["m1"]
	});
	assert.equal(refreshes.length, 0);
	assert.equal(store.getDisplayState("m1").status, "pending");
	assert.equal(store.getDisplayState("m1").renderStatus, "pending");
});

test("markPending reports rejected IDs without mutating or refreshing", async () => {
	const {store, refreshes, controller} = createHarness();
	const captured = capture(store, "m1");

	const outcome = await controller.markPending({...pendingRequest("m1"), generation: 2});

	assert.deepEqual(outcome, {
		confirmedIds: [],
		missingIds: [],
		fallbackUsed: false,
		rejectedIds: ["m1"]
	});
	assert.equal(refreshes.length, 0);
	assert.equal(store.getDisplayState("m1"), captured);
});

test("commitMessageResult rejects a terminal result with the wrong active request identity", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");
	await controller.markPending(pendingRequest("m1", "c1", "request-new"), {refresh: false});
	const pending = store.getDisplayState("m1");

	const outcome = await controller.commitMessageResult(result("m1", "c1", "automatic", "request-old"));

	assert.deepEqual(outcome, {
		confirmedIds: [],
		missingIds: [],
		fallbackUsed: false,
		rejectedIds: ["m1"]
	});
	assert.equal(refreshes.length, 0);
	assert.equal(store.getDisplayState("m1"), pending);
});

test("commitHistoricalBatch reports the rejected result when the atomic batch does not commit", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");
	capture(store, "m2");
	store.markPending(pendingRequest("m2", "c1", "request-new"));

	const outcome = await controller.commitHistoricalBatch([
		result("m1"),
		result("m2", "c1", "automatic", "request-old")
	]);

	assert.deepEqual(outcome, {
		confirmedIds: [],
		missingIds: [],
		fallbackUsed: false,
		rejectedIds: ["m2"]
	});
	assert.equal(refreshes.length, 0);
	assert.equal(store.getDisplayState("m1").status, "idle");
	assert.equal(store.getDisplayState("m2").status, "pending");
});

test("render transactions use monotonically increasing IDs", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");
	capture(store, "m2");

	await controller.renderMessage("m1");
	await controller.renderMessage("m2");
	await controller.renderMessage("m1");

	assert.deepEqual(refreshes.map(request => request.transactionId), [1, 2, 3]);
});

test("a display transaction rejects records spanning channels before refreshing", async () => {
	const realStore = createMessageStateStore();
	const first = capture(realStore, "m1", "c1");
	const second = capture(realStore, "m2", "c2");
	const store = {
		...realStore,
		restoreChannel() {return [first, second];}
	};
	let refreshCount = 0;
	const controller = createTranslationDisplayController({
		store,
		renderAdapter: {
			async refreshMessages() {
				refreshCount++;
				return emptyOutcome();
			}
		}
	});

	await assert.rejects(controller.restoreChannel("c1"), /cannot span channels/i);

	assert.equal(refreshCount, 0);
});

test("restoreAll groups every restored record by channel without cross-channel leakage", async () => {
	const {store, refreshes, controller} = createHarness();
	for (const [messageId, channelId, origin] of [
		["auto-a", "c1", "automatic"],
		["auto-b", "c1", "automatic"],
		["auto-c", "c2", "automatic"],
		["manual-c", "c2", "manual"]
	]) {
		capture(store, messageId, channelId);
		store.commitResult(result(messageId, channelId, origin));
	}

	const outcomes = await controller.restoreAll();

	assert.equal(outcomes.length, 2);
	assert.deepEqual(refreshes.map(request => ({
		transactionId: request.transactionId,
		channelId: request.channelId,
		messageIds: request.messageIds
	})), [
		{transactionId: 1, channelId: "c1", messageIds: ["auto-a", "auto-b"]},
		// Stopping the plugin leaves nothing translated on screen, manual included.
		{transactionId: 2, channelId: "c2", messageIds: ["auto-c", "manual-c"]}
	]);
	assert.equal(refreshes.every(request => request.views.every(view => view.channelId === request.channelId)), true);
	assert.equal(controller.getDisplayView("manual-c").translated, false);
});

test("restoreAll with refresh disabled returns restored records without rendering", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "auto-a", "c1");
	capture(store, "auto-b", "c2");
	store.commitResult(result("auto-a", "c1"));
	store.commitResult(result("auto-b", "c2"));

	const records = await controller.restoreAll({refresh: false});

	assert.deepEqual(records.map(record => record.messageId), ["auto-a", "auto-b"]);
	assert.equal(records.every(record => record.status === "cancelled" && record.translation === null), true);
	assert.equal(refreshes.length, 0);
});

test("empty controller operations return the stable no-op outcome", async () => {
	const {refreshes, controller} = createHarness();

	assert.deepEqual(await controller.renderMessage("missing"), emptyOutcome());
	assert.deepEqual(await controller.commitHistoricalBatch([]), emptyOutcome());
	assert.deepEqual(await controller.restoreChannel("missing"), emptyOutcome());
	assert.deepEqual(await controller.restoreAll(), emptyOutcome());
	assert.equal(controller.getDisplayView("missing"), null);
	assert.equal(refreshes.length, 0);
});

test("a late confirmed acknowledgement cannot confirm a newer display revision", async () => {
	const deferred = createDeferred();
	const {store, refreshes, controller} = createHarness(() => deferred.promise);
	capture(store, "m1");
	const rendering = controller.commitMessageResult(result("m1"));
	assert.equal(refreshes.length, 1);
	const requestedRevision = refreshes[0].views[0].revision;

	// Superseding a translated record is now explicit, so a stale-acknowledgement test
	// has to say it means to do it.
	const newerState = store.markPending(Object.assign(pendingRequest("m1", "c1", "request-new"), {supersede: true}));
	assert.equal(newerState.revision > requestedRevision, true);
	deferred.resolve({confirmedIds: ["m1"], missingIds: [], fallbackUsed: false});

	const outcome = await rendering;

	assert.deepEqual(outcome, {confirmedIds: [], missingIds: [], fallbackUsed: false, staleIds: ["m1"]});
	assert.equal(store.getDisplayState("m1"), newerState);
	assert.equal(newerState.renderStatus, "pending");
	assert.equal(newerState.renderReason, null);
});

test("a late missing acknowledgement cannot mark a newer display revision unconfirmed", async () => {
	const deferred = createDeferred();
	const {store, refreshes, controller} = createHarness(() => deferred.promise);
	capture(store, "m1");
	const rendering = controller.commitMessageResult(result("m1"));
	assert.equal(refreshes.length, 1);
	const requestedRevision = refreshes[0].views[0].revision;

	// Superseding a translated record is now explicit, so a stale-acknowledgement test
	// has to say it means to do it.
	const newerState = store.markPending(Object.assign(pendingRequest("m1", "c1", "request-new"), {supersede: true}));
	assert.equal(newerState.revision > requestedRevision, true);
	deferred.resolve({confirmedIds: [], missingIds: ["m1"], fallbackUsed: true});

	const outcome = await rendering;

	assert.deepEqual(outcome, {confirmedIds: [], missingIds: [], fallbackUsed: true, staleIds: ["m1"]});
	assert.equal(store.getDisplayState("m1"), newerState);
	assert.equal(newerState.renderStatus, "pending");
	assert.equal(newerState.renderReason, null);
});

test("restoreMessage cancels one automatic record through an acknowledged refresh", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");
	store.commitResult(result("m1"));
	refreshes.length = 0;

	const outcome = await controller.restoreMessage("m1");

	assert.deepEqual(outcome, {confirmedIds: ["m1"], missingIds: [], fallbackUsed: false});
	assert.equal(refreshes.length, 1);
	assert.equal(refreshes[0].views[0].content, "m1 source");
	assert.equal(refreshes[0].views[0].translated, false);
	assert.equal(store.getDisplayState("m1").status, "cancelled");
	assert.deepEqual(await controller.restoreMessage("m1"), emptyOutcome());
	assert.deepEqual(await controller.restoreMessage("missing"), emptyOutcome());
});

test("commitHistoricalBatch commits recorded results and surfaces unrecorded rejections", async () => {
	const {store, refreshes, controller} = createHarness();
	capture(store, "m1");

	const outcome = await controller.commitHistoricalBatch([
		result("m1"),
		{messageId: "never-captured", channelId: "c1", generation: 1, sourceSignature: "c1:never-captured", origin: "automatic", status: "translated", translation: {content: "孤儿"}}
	]);

	assert.deepEqual(outcome.confirmedIds, ["m1"]);
	assert.deepEqual(outcome.rejectedIds, ["never-captured"]);
	assert.equal(refreshes.length, 1);
	assert.deepEqual(refreshes[0].messageIds, ["m1"]);
	assert.equal(store.getDisplayState("m1").status, "translated");
});
