const test = require("node:test");
const assert = require("node:assert/strict");
const {
	SENT_ORIGINAL_MATCH_TTL,
	MAX_SENT_ORIGINAL_ENTRIES,
	createSentTranslationStore
} = require("../src/sent/sent-translation-store");

function createHarness(overrides = {}) {
	let clock = 1000;
	let runtimeActive = true;
	const disabledChannels = new Set();
	const ownMessageIds = new Set();
	const store = createSentTranslationStore(Object.assign({
		now: () => clock,
		isRuntimeActive: () => runtimeActive,
		isTranslationEnabled: channelId => !disabledChannels.has(String(channelId)),
		isOwnMessage: message => !!(message && ownMessageIds.has(String(message.id)))
	}, overrides));
	return {
		store,
		advance(ms) {clock += ms;},
		stopRuntime() {runtimeActive = false;},
		startRuntime() {runtimeActive = true;},
		disableChannel(channelId) {disabledChannels.add(String(channelId));},
		ownMessage(messageId) {ownMessageIds.add(String(messageId));}
	};
}

// Records the value the pipeline actually handed to Discord.
function createSubmitRecorder() {
	const submitted = [];
	const submit = nextText => {
		submitted.push(nextText);
		return Promise.resolve();
	};
	return {submit, submitted};
}

test("a live request submits the translation and remembers the original for the echo", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const request = harness.store.createRequest("c1", "hello");

	assert.equal(harness.store.isRequestCurrent(request), true);
	assert.equal(await harness.store.completeRequest(request, "你好", recorder.submit), true);
	assert.deepEqual(recorder.submitted, ["你好"]);

	harness.ownMessage("m1");
	assert.equal(harness.store.captureEcho({id: "m1", channel_id: "c1", content: "你好"}), true);
	assert.equal(harness.store.getEditableText("m1", "你好"), "hello", "editing shows what the user typed");
});

test("a request without a channel is refused, because nothing can be scoped to it", () => {
	const harness = createHarness();
	assert.equal(harness.store.createRequest(null, "hello"), null);
	assert.equal(harness.store.createRequest("", "hello"), null);
});

test("an edit request remembers its original immediately instead of waiting for an echo", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const request = harness.store.createRequest("c1", "edited", "m9");

	await harness.store.completeRequest(request, "已编辑", recorder.submit);
	assert.deepEqual(recorder.submitted, ["已编辑"]);
	assert.equal(harness.store.getEditableText("m9", "已编辑"), "edited");
});

test("a completed request cannot be completed twice", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const request = harness.store.createRequest("c1", "hello");

	await harness.store.completeRequest(request, "你好", recorder.submit);
	assert.equal(await harness.store.completeRequest(request, "再见", recorder.submit), false);
	assert.deepEqual(recorder.submitted, ["你好"], "the second completion must not submit again");
	assert.equal(harness.store.isRequestCurrent(request), false);
});

test("completeRequest tolerates a missing request or a non-callable submit", async () => {
	const harness = createHarness();
	assert.equal(await harness.store.completeRequest(null, "你好", () => {}), false);
	const request = harness.store.createRequest("c1", "hello");
	assert.equal(await harness.store.completeRequest(request, "你好", null), false);
	assert.equal(harness.store.isRequestCurrent(request), true, "a refused completion leaves the request alive");
});

test("a late callback after a plugin stop sends the original and records nothing", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const request = harness.store.createRequest("c1", "hello");

	// The provider is still in flight when the user disables the plugin.
	harness.stopRuntime();
	harness.store.invalidateRequests();
	harness.store.clearPendingOriginals();
	harness.startRuntime();

	assert.equal(harness.store.isRequestCurrent(request), false);
	assert.equal(await harness.store.completeRequest(request, "你好", recorder.submit), true);
	assert.deepEqual(recorder.submitted, ["hello"], "the user's message is still sent, untranslated");

	harness.ownMessage("m1");
	assert.equal(harness.store.captureEcho({id: "m1", channel_id: "c1", content: "hello"}), false, "no pending original was recorded");
	assert.equal(harness.store.getEditableText("m1", "hello"), "hello");
});

test("a restart moves the generation so a request from the previous run stays dead", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const stale = harness.store.createRequest("c1", "hello");

	harness.store.resetForStart();
	const fresh = harness.store.createRequest("c1", "hello again");

	assert.equal(harness.store.isRequestCurrent(stale), false);
	assert.equal(harness.store.isRequestCurrent(fresh), true, "the new run's request is live");
	assert.notEqual(stale.generation, fresh.generation, "the generation counter distinguishes the runs");

	await harness.store.completeRequest(stale, "你好", recorder.submit);
	assert.deepEqual(recorder.submitted, ["hello"]);
});

test("a restart keeps remembered originals so an edit still prefills after a reload", async () => {
	const harness = createHarness();
	await harness.store.completeRequest(harness.store.createRequest("c1", "edited", "m9"), "已编辑", createSubmitRecorder().submit);

	harness.store.resetForStart();
	assert.equal(harness.store.getEditableText("m9", "已编辑"), "edited");
});

test("channel-scoped invalidation drops only that channel's requests", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const inChannel = harness.store.createRequest("c1", "hello");
	const elsewhere = harness.store.createRequest("c2", "hallo");

	harness.store.invalidateRequests("c1");
	assert.equal(harness.store.isRequestCurrent(inChannel), false);
	assert.equal(harness.store.isRequestCurrent(elsewhere), true);

	await harness.store.completeRequest(inChannel, "你好", recorder.submit);
	await harness.store.completeRequest(elsewhere, "您好", recorder.submit);
	assert.deepEqual(recorder.submitted, ["hello", "您好"]);
});

test("turning translation off for a channel supersedes its in-flight request", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	const request = harness.store.createRequest("c1", "hello");

	harness.disableChannel("c1");
	assert.equal(harness.store.isRequestCurrent(request), false);
	await harness.store.completeRequest(request, "你好", recorder.submit);
	assert.deepEqual(recorder.submitted, ["hello"]);
});

test("a translation identical to the original records nothing to restore", async () => {
	const harness = createHarness();
	const recorder = createSubmitRecorder();
	await harness.store.completeRequest(harness.store.createRequest("c1", "hello"), "hello", recorder.submit);

	harness.ownMessage("m1");
	assert.equal(harness.store.captureEcho({id: "m1", channel_id: "c1", content: "hello"}), false);
});

test("an edit whose translation equals the original drops the previous record", async () => {
	const harness = createHarness();
	await harness.store.completeRequest(harness.store.createRequest("c1", "edited", "m9"), "已编辑", createSubmitRecorder().submit);
	assert.equal(harness.store.getEditableText("m9", "已编辑"), "edited");

	await harness.store.completeRequest(harness.store.createRequest("c1", "plain", "m9"), "plain", createSubmitRecorder().submit);
	assert.equal(harness.store.getEditableText("m9", "plain"), "plain", "the superseded original must not resurface");
});

test("trackPendingOriginal refuses entries that cannot identify a substitution", () => {
	const harness = createHarness();
	assert.equal(harness.store.trackPendingOriginal(null, "hello", "你好"), false);
	assert.equal(harness.store.trackPendingOriginal("c1", "", "你好"), false);
	assert.equal(harness.store.trackPendingOriginal("c1", "hello", ""), false);
	assert.equal(harness.store.trackPendingOriginal("c1", "hello", "hello"), false);
	assert.equal(harness.store.trackPendingOriginal("c1", "hello", "你好"), true);
});

test("an echo is matched only for our own message, in its channel, by exact submitted text", () => {
	const harness = createHarness();
	harness.store.trackPendingOriginal("c1", "hello", "你好");
	harness.ownMessage("mine");

	assert.equal(harness.store.captureEcho(null), false);
	assert.equal(harness.store.captureEcho({id: "other", channel_id: "c1", content: "你好"}), false, "someone else's message");
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c2", content: "你好"}), false, "wrong channel");
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c1", content: "你好 "}), false, "text does not match exactly");
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c1", content: ""}), false, "empty echo");
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c1", content: "你好"}), true);
	assert.equal(harness.store.getEditableText("mine", "你好"), "hello");
});

test("an echo consumes its pending entry, so a later identical send cannot reuse it", () => {
	const harness = createHarness();
	harness.store.trackPendingOriginal("c1", "hello", "你好");
	harness.ownMessage("first");
	harness.ownMessage("second");

	assert.equal(harness.store.captureEcho({id: "first", channel_id: "c1", content: "你好"}), true);
	assert.equal(harness.store.captureEcho({id: "second", channel_id: "c1", content: "你好"}), false);
	assert.equal(harness.store.getEditableText("second", "你好"), "你好");
});

test("an explicit channel id overrides the one carried on the echoed message", () => {
	const harness = createHarness();
	harness.store.trackPendingOriginal("c1", "hello", "你好");
	harness.ownMessage("mine");

	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c2", content: "你好"}, "c1"), true);
	assert.equal(harness.store.getEditableText("mine", "你好"), "hello");
});

test("a pending original expires after two minutes so a repeated send cannot adopt it", () => {
	const harness = createHarness();
	harness.store.trackPendingOriginal("c1", "hello", "你好");
	harness.ownMessage("mine");

	harness.advance(SENT_ORIGINAL_MATCH_TTL);
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c1", content: "你好"}), true, "an entry exactly at the boundary still matches");

	harness.store.trackPendingOriginal("c1", "hello", "你好");
	harness.advance(SENT_ORIGINAL_MATCH_TTL + 1);
	assert.equal(harness.store.captureEcho({id: "later", channel_id: "c1", content: "你好"}), false);
});

test("pending originals are capped, dropping the oldest first", () => {
	const harness = createHarness();
	for (let index = 0; index < MAX_SENT_ORIGINAL_ENTRIES + 5; index++) {
		harness.store.trackPendingOriginal("c1", `original-${index}`, `sent-${index}`);
		harness.advance(1);
	}
	harness.ownMessage("mine");

	// The five oldest entries were pushed out by the cap.
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c1", content: "sent-4"}), false);
	assert.equal(harness.store.captureEcho({id: "mine", channel_id: "c1", content: "sent-5"}), true);
	assert.equal(harness.store.getEditableText("mine", "sent-5"), "original-5");

	harness.ownMessage("newest");
	assert.equal(harness.store.captureEcho({id: "newest", channel_id: "c1", content: `sent-${MAX_SENT_ORIGINAL_ENTRIES + 4}`}), true, "the newest send survived the cap");
});

test("remembered originals are capped, dropping the least recently captured first", () => {
	const harness = createHarness();
	for (let index = 0; index < MAX_SENT_ORIGINAL_ENTRIES + 3; index++) {
		harness.store.trackPendingOriginal("c1", `original-${index}`, `sent-${index}`);
		harness.ownMessage(`m-${index}`);
		harness.store.captureEcho({id: `m-${index}`, channel_id: "c1", content: `sent-${index}`});
		harness.advance(1);
	}

	assert.equal(harness.store.getEditableText("m-0", "sent-0"), "sent-0", "evicted");
	assert.equal(harness.store.getEditableText("m-2", "sent-2"), "sent-2", "evicted");
	assert.equal(harness.store.getEditableText("m-3", "sent-3"), "original-3", "the oldest surviving entry");
	assert.equal(harness.store.getEditableText(`m-${MAX_SENT_ORIGINAL_ENTRIES + 2}`, `sent-${MAX_SENT_ORIGINAL_ENTRIES + 2}`), `original-${MAX_SENT_ORIGINAL_ENTRIES + 2}`);
});

test("a remembered original is dropped once the visible message no longer matches what we sent", () => {
	const harness = createHarness();
	harness.store.trackPendingOriginal("c1", "hello", "你好");
	harness.ownMessage("mine");
	harness.store.captureEcho({id: "mine", channel_id: "c1", content: "你好"});

	// Somebody edited the message outside our pipeline; the record is now worthless.
	assert.equal(harness.store.getEditableText("mine", "something else"), "something else");
	assert.equal(harness.store.getEditableText("mine", "你好"), "你好", "the stale record was discarded on the first mismatch");
});

test("getEditableText passes through when nothing was ever remembered", () => {
	const harness = createHarness();
	assert.equal(harness.store.getEditableText("unknown", "text"), "text");
	assert.equal(harness.store.getEditableText(null, "text"), "text");
	assert.equal(harness.store.getEditableText(undefined, undefined), undefined);
});

test("clearPendingOriginals drops unmatched sends without touching remembered ones", () => {
	const harness = createHarness();
	harness.store.trackPendingOriginal("c1", "unmatched", "未匹配");
	harness.store.trackPendingOriginal("c1", "matched", "已匹配");
	harness.ownMessage("mine");
	harness.store.captureEcho({id: "mine", channel_id: "c1", content: "已匹配"});

	harness.store.clearPendingOriginals();
	harness.ownMessage("late");
	assert.equal(harness.store.captureEcho({id: "late", channel_id: "c1", content: "未匹配"}), false);
	assert.equal(harness.store.getEditableText("mine", "已匹配"), "matched");
});

test("the manual request key is scoped to channel and message", () => {
	const harness = createHarness();
	assert.equal(harness.store.createManualRequestKey("c1", "m1"), "c1:m1");
	assert.equal(harness.store.createManualRequestKey("c1", 42), "c1:42");
	assert.equal(harness.store.createManualRequestKey(null, "m1"), "__global:m1", "a message with no channel still gets a stable key");
	assert.notEqual(harness.store.createManualRequestKey("c1", "m1"), harness.store.createManualRequestKey("c2", "m1"));
});

test("a second manual translation of the same message is refused while the first is in flight", () => {
	const harness = createHarness();
	const key = harness.store.createManualRequestKey("c1", "m1");

	assert.equal(harness.store.hasManualRequest(key), false);
	const request = harness.store.beginManualRequest(key);
	assert.equal(harness.store.hasManualRequest(key), true);

	harness.store.releaseManualRequest(key, request);
	assert.equal(harness.store.hasManualRequest(key), false, "the message can be translated by hand again");
});

test("a superseded manual request must not apply its result", () => {
	const harness = createHarness();
	const key = harness.store.createManualRequestKey("c1", "m1");
	const first = harness.store.beginManualRequest(key);
	const second = harness.store.beginManualRequest(key);

	assert.equal(harness.store.isManualRequestCurrent(key, first), false);
	assert.equal(harness.store.isManualRequestCurrent(key, second), true);

	// The superseded request finishing must not evict the live one's slot.
	assert.equal(harness.store.releaseManualRequest(key, first), false);
	assert.equal(harness.store.isManualRequestCurrent(key, second), true);
	assert.equal(harness.store.releaseManualRequest(key, second), true);
});

test("manual requests in different channels and messages do not collide", () => {
	const harness = createHarness();
	const here = harness.store.createManualRequestKey("c1", "m1");
	const there = harness.store.createManualRequestKey("c2", "m1");
	const other = harness.store.createManualRequestKey("c1", "m2");
	harness.store.beginManualRequest(here);

	assert.equal(harness.store.hasManualRequest(there), false);
	assert.equal(harness.store.hasManualRequest(other), false);
});

test("releaseManualRequest ignores a missing key or a request that never registered", () => {
	const harness = createHarness();
	const key = harness.store.createManualRequestKey("c1", "m1");
	const request = harness.store.beginManualRequest(key);

	assert.equal(harness.store.releaseManualRequest(null, request), false);
	assert.equal(harness.store.releaseManualRequest(key, {}), false);
	assert.equal(harness.store.hasManualRequest(key), true, "an unrelated release must not free the slot");
});

test("clearManualRequests releases every slot so a stop cannot block later manual translation", () => {
	const harness = createHarness();
	const key = harness.store.createManualRequestKey("c1", "m1");
	const request = harness.store.beginManualRequest(key);

	harness.store.clearManualRequests();
	assert.equal(harness.store.hasManualRequest(key), false);
	assert.equal(harness.store.isManualRequestCurrent(key, request), false, "the in-flight request may no longer apply its result");
});

test("the store exposes no way to mutate its state except through the API", () => {
	const harness = createHarness();
	assert.equal(Object.isFrozen(harness.store), true);
	assert.equal(harness.store.pendingOriginals, undefined);
	assert.equal(harness.store.requests, undefined);
});

test("the defaults are usable without any injection", async () => {
	const store = createSentTranslationStore();
	const recorder = createSubmitRecorder();
	const request = store.createRequest("c1", "hello");

	assert.equal(store.isRequestCurrent(request), true);
	await store.completeRequest(request, "你好", recorder.submit);
	assert.deepEqual(recorder.submitted, ["你好"]);
	// isOwnMessage defaults to false, so no echo is ever adopted without the plugin's answer.
	assert.equal(store.captureEcho({id: "m1", channel_id: "c1", content: "你好"}), false);
});
