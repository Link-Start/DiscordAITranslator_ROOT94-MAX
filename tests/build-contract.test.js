const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("the committed BetterDiscord plugin matches the deterministic source build", async () => {
	const {createPluginBundle} = await import("../scripts/build-plugin.mjs");
	const generated = await createPluginBundle();
	const committed = fs.readFileSync(path.join(root, "DiscordAITranslator.plugin.js"), "utf8");

	assert.equal(committed, generated);
});

test("the generated plugin keeps metadata and excludes development artifacts", async () => {
	const {createPluginBundle} = await import("../scripts/build-plugin.mjs");
	const generated = await createPluginBundle();

	assert.match(generated, /^\/\*\*[\s\S]*@name DiscordAITranslator/);
	assert.match(generated, /@version 0\.3\.36/);
	assert.doesNotMatch(generated, /sourceMappingURL=/);
	assert.doesNotMatch(generated, /tests\//);
	assert.doesNotMatch(generated, /TRANSLATOR_DISPLAY_DEBUG_JOURNAL/);
});
