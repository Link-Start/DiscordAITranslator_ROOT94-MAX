const test = require("node:test");
const assert = require("node:assert/strict");
const {verify} = require("../scripts/verify-historical-cap2-ab");

test("deterministic cap1/cap2 A/B changes only overlap and clears the 20 percent gate", async () => {
	const result = await verify();
	assert.equal(result.ok, true);
	assert.equal(result.cap1.requests.length, 5);
	assert.equal(result.cap2.requests.length, 5);
	assert.equal(result.cap1.logicalTotalMs, 520);
	assert.equal(result.cap2.logicalTotalMs, 320);
	assert.equal(Math.round(result.improvementPercent * 100) / 100, 38.46);
});
