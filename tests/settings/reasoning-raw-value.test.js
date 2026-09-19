const test = require("node:test");
const assert = require("node:assert/strict");
const {normalizeReasoningRawValue, createReasoningRawKey} = require("../../src/settings/reasoning-raw-value");

test("a raw thinking value keeps the type the provider actually accepts", () => {
	assert.equal(normalizeReasoningRawValue("high"), "high");
	assert.equal(normalizeReasoningRawValue("  xhigh  "), "xhigh", "surrounding space is noise, the value itself is not");
	assert.equal(normalizeReasoningRawValue(12000), 12000);
	assert.equal(normalizeReasoningRawValue(-1), -1, "dynamic budgets are negative on purpose");
	assert.equal(normalizeReasoningRawValue(0), 0);
	assert.equal(normalizeReasoningRawValue(true), true);
	assert.equal(normalizeReasoningRawValue(false), false);
	// nothing else is a dispatchable value
	for (const rejected of [null, undefined, "", "   ", {}, [], NaN, Infinity, -Infinity, () => {}]) {
		assert.equal(normalizeReasoningRawValue(rejected), null, JSON.stringify(String(rejected)));
	}
	assert.equal(normalizeReasoningRawValue("x".repeat(200)).length, 128, "long values are bounded, not rejected");
});

test("tagged raw keys keep a number and its spelling apart", () => {
	assert.equal(createReasoningRawKey(12000), "n:12000");
	assert.equal(createReasoningRawKey("12000"), "s:12000");
	assert.notEqual(createReasoningRawKey(12000), createReasoningRawKey("12000"));
	assert.equal(createReasoningRawKey(true), "b:true");
	assert.equal(createReasoningRawKey("true"), "s:true");
	assert.notEqual(createReasoningRawKey(true), createReasoningRawKey("true"));
	assert.equal(createReasoningRawKey("high"), "s:high");
	assert.equal(createReasoningRawKey(-1), "n:-1");
	assert.equal(createReasoningRawKey(null), "");
	assert.equal(createReasoningRawKey("  high "), createReasoningRawKey("high"), "the key follows the normalized value");
});
