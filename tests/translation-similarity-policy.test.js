const test = require("node:test");
const assert = require("node:assert/strict");
const {
	TRANSLATION_SIMILARITY_THRESHOLD,
	RECEIVED_ECHO_GUARD_THRESHOLD,
	SENT_ECHO_GUARD_THRESHOLD
} = require("../src/language/translation-similarity-policy");

test("translation similarity thresholds are explicit internal policy", () => {
	assert.equal(TRANSLATION_SIMILARITY_THRESHOLD, 0.90);
	assert.equal(RECEIVED_ECHO_GUARD_THRESHOLD, 0.92);
	assert.equal(SENT_ECHO_GUARD_THRESHOLD, 0.94);
});
