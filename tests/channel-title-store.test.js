const test = require("node:test");
const assert = require("node:assert/strict");
const {createChannelTitleStore} = require("../src/channel-title/channel-title-store");

function createStore(startTime = 1000) {
	let clock = startTime;
	const store = createChannelTitleStore({now: () => clock});
	return {store, advance(ms) {clock += ms;}};
}

test("a translated title is returned only while its signature matches", () => {
	const {store} = createStore();
	const request = store.beginRequest("c1", "sig-1");
	store.completeRequest(request, "译文标题");

	assert.equal(store.getTranslatedTitle("c1", "sig-1"), "译文标题");
	// A configuration change produces a new signature; the stale entry must not show.
	assert.equal(store.getTranslatedTitle("c1", "sig-2"), null);
	assert.equal(store.getTranslatedTitle("c1", "sig-1"), null, "the stale entry is dropped on read");
});

test("a request is refused while an identical one is settled or in flight", () => {
	const {store} = createStore();
	const first = store.beginRequest("c1", "sig-1");
	assert.ok(first);
	assert.equal(store.beginRequest("c1", "sig-1"), null, "no duplicate while in flight");

	store.completeRequest(first, "译文标题");
	assert.equal(store.beginRequest("c1", "sig-1"), null, "no re-request for an already translated signature");
	assert.ok(store.beginRequest("c1", "sig-2"), "a changed signature may request again");
});

test("a failed request is retried only after its cooldown", () => {
	const {store, advance} = createStore();
	const request = store.beginRequest("c1", "sig-1");
	store.failRequest(request);

	assert.equal(store.beginRequest("c1", "sig-1"), null, "still cooling down");
	advance(30001);
	assert.ok(store.beginRequest("c1", "sig-1"), "retry allowed after the cooldown");
});

test("a superseded request cannot commit its late result", () => {
	const {store} = createStore();
	const stale = store.beginRequest("c1", "sig-1");
	store.cancelPending("c1");
	const fresh = store.beginRequest("c1", "sig-2");

	assert.equal(store.isRequestCurrent(stale), false);
	assert.equal(store.completeRequest(stale, "旧标题"), false, "a cancelled request must not write");
	assert.equal(store.getTranslatedTitle("c1", "sig-1"), null);

	store.completeRequest(fresh, "新标题");
	assert.equal(store.getTranslatedTitle("c1", "sig-2"), "新标题");
});

test("clear reports whether a visible title was removed and is channel scoped", () => {
	const {store} = createStore();
	store.completeRequest(store.beginRequest("c1", "sig-1"), "标题一");
	store.completeRequest(store.beginRequest("c2", "sig-2"), "标题二");

	assert.equal(store.clear("c1"), true, "removing a visible title warrants a refresh");
	assert.equal(store.getTranslatedTitle("c1", "sig-1"), null);
	assert.equal(store.getTranslatedTitle("c2", "sig-2"), "标题二", "other channels are untouched");
	assert.equal(store.clear("c1"), false, "clearing nothing warrants no refresh");

	assert.equal(store.clear(), true, "a global clear removes the remaining title");
	assert.equal(store.getTranslatedTitle("c2", "sig-2"), null);
});

test("invalidating in-flight requests keeps displayed titles but blocks late writes", () => {
	const {store} = createStore();
	store.completeRequest(store.beginRequest("c1", "sig-1"), "已显示");
	const inFlight = store.beginRequest("c2", "sig-2");

	store.invalidateInFlight();

	assert.equal(store.getTranslatedTitle("c1", "sig-1"), "已显示", "displayed titles survive");
	assert.equal(store.completeRequest(inFlight, "太晚了"), false, "a late callback cannot commit");
	assert.equal(store.getTranslatedTitle("c2", "sig-2"), null);
});
