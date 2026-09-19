const test = require("node:test");
const assert = require("node:assert/strict");
const {createSentTranslationStore} = require("../src/sent/sent-translation-store");

test("3 deletion cancels only the captured channel/message manual slot and late release preserves its successor", () => {
	const store = createSentTranslationStore();
	const a = store.createManualRequestKey("a", "m"), b = store.createManualRequestKey("b", "m");
	const old = store.beginManualRequest(a), other = store.beginManualRequest(b);
	assert.equal(store.cancelManualRequest(a), true);
	assert.equal(store.cancelManualRequest(a), false);
	assert.equal(store.isManualRequestCurrent(a, old), false);
	assert.equal(store.isManualRequestCurrent(b, other), true);
	const next = store.beginManualRequest(a);
	assert.equal(store.releaseManualRequest(a, old), false);
	assert.equal(store.isManualRequestCurrent(a, next), true);
	assert.equal(store.cancelManualRequest(null), false);
	store.clearManualRequests();
	assert.equal(store.hasManualRequest(a), false);
	assert.equal(store.hasManualRequest(b), false);
});
