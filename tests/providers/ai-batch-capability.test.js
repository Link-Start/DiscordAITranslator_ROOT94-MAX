const test = require("node:test");
const assert = require("node:assert/strict");
const {isAiBatchCapableEngineKey} = require("../../src/providers/provider-client");

// F0.5: batch eligibility keys off engine capability, not a hardcoded built-in
// list. Field data 2026-08-25 showed a 21-message backlog draining one request at
// a time because custom AI platforms were excluded from the batch whitelist.

test("built-in AI engines stay batch-capable", () => {
	for (const engineKey of ["deepseek", "openai", "gemini", "oaicompat"]) {
		assert.equal(isAiBatchCapableEngineKey(engineKey), true, `${engineKey} must stay batch-capable`);
	}
});

test("custom AI platforms are batch-capable", () => {
	assert.equal(isAiBatchCapableEngineKey("custom-mt7lq9eosc"), true);
	assert.equal(isAiBatchCapableEngineKey("custom-abc123"), true);
});

test("machine translation engines and malformed keys are not batch-capable", () => {
	for (const engineKey of ["googleapi", "deepl", "microsoft", "papago", "baidu", "custom-", "customx", "CUSTOM-ABC", "", null, undefined]) {
		assert.equal(isAiBatchCapableEngineKey(engineKey), false, `${String(engineKey)} must not be batch-capable`);
	}
});
