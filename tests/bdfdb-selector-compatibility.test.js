const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("composer status and focus detection do not read the removed BDFDB channeltextarea selector", () => {
	const runtime = fs.readFileSync(path.resolve(__dirname, "..", "src", "legacy", "runtime.js"), "utf8");

	assert.doesNotMatch(runtime, /BDFDB\.dotCN\s*&&\s*BDFDB\.dotCN\.channeltextarea|BDFDB\.dotCN\.channeltextarea/);
	assert.match(runtime, /\[class\*="channelTextArea"\]/, "the local Discord composer fallback remains available");
});
