const test = require("node:test");
const assert = require("node:assert/strict");
const packageJson = require("../package.json");

test("npm test checks source and bundle parity before tests can load the artifact", () => {
	assert.match(packageJson.scripts.test || "", /^npm run build:check && node --test$/);
});

test("verify avoids repeating the parity check while retaining syntax and the complete suite", () => {
	assert.equal(packageJson.scripts["test:node"], "node --test");
	assert.equal(packageJson.scripts.verify, "npm run check:publication && npm run check:notes && npm run build:check && npm run check && npm run test:node");
});
