const test = require("node:test");
const assert = require("node:assert/strict");

const {
	PROVIDER_GROUPS,
	ARCHIVED_PROVIDER_KEYS,
	isArchivedProviderKey,
	resolveProviderGroupId,
	resolveProviderGroupKeys,
	resolveVisibleProviderKeys
} = require("../../src/ui/provider-catalog");

// The stock engine table plus one renamed oaicompat slot and one custom entry,
// mirroring what syncCustomEngines() leaves in translationEngines.
const labels = {
	googleapi: "Google", googlecloud: "Google Cloud", microsoft: "Azure", deepl: "DeepL", deepseek: "DeepSeek",
	openai: "OpenAI", gemini: "Gemini", oaicompat: "GG", papago: "Papago", baidu: "Baidu", "custom-aa": "AA"
};
const engines = Object.fromEntries(Object.keys(labels).map(key => [key, {name: labels[key]}]));
const getLabel = key => labels[key];
const customProviderIds = ["oaicompat", "custom-aa"];

test("archived stock providers are exactly OpenAI and Papago", () => {
	assert.deepEqual([...ARCHIVED_PROVIDER_KEYS], ["openai", "papago"]);
	assert.equal(isArchivedProviderKey("openai"), true);
	assert.equal(isArchivedProviderKey("papago"), true);
	assert.equal(isArchivedProviderKey("deepseek"), false);
	assert.equal(resolveProviderGroupId("custom-aa"), "ai");
	assert.equal(resolveProviderGroupId("baidu"), "machine");
});

test("the flattened list matches the sidebar: AI group first, archived rows gone, customs where oaicompat sat", () => {
	const keys = resolveVisibleProviderKeys({engines, customProviderIds, getLabel, keepKeys: ["custom-aa", "----"]});
	assert.deepEqual(keys, ["deepseek", "gemini", "oaicompat", "custom-aa", "googleapi", "microsoft", "baidu", "deepl", "googlecloud"]);
	assert.equal(keys.includes("openai"), false);
	assert.equal(keys.includes("papago"), false);
});

test("a kept archived engine keeps its row inside its own group", () => {
	const keys = resolveVisibleProviderKeys({engines, customProviderIds, getLabel, keepKeys: ["openai"]});
	assert.deepEqual(keys.slice(0, 5), ["deepseek", "gemini", "openai", "oaicompat", "custom-aa"]);
	assert.equal(keys.includes("papago"), false);
	const machine = resolveProviderGroupKeys(PROVIDER_GROUPS[1], {engines, customProviderIds, getLabel, keepKeys: ["papago"]});
	assert.deepEqual(machine, ["googleapi", "microsoft", "baidu", "deepl", "googlecloud", "papago"]);
});

test("a kept custom slot that is not in the custom list is appended to the AI group, unknown keys are ignored", () => {
	const keys = resolveVisibleProviderKeys({engines, customProviderIds: [], getLabel, keepKeys: ["oaicompat", "custom-missing", undefined, null]});
	assert.deepEqual(keys, ["deepseek", "gemini", "oaicompat", "googleapi", "microsoft", "baidu", "deepl", "googlecloud"]);
});

test("custom engines removed from the engine table never render", () => {
	const keys = resolveVisibleProviderKeys({engines, customProviderIds: ["oaicompat", "custom-aa", "custom-gone"], getLabel});
	assert.equal(keys.includes("custom-gone"), false);
	assert.deepEqual(keys.filter(key => key.startsWith("custom-")), ["custom-aa"]);
});
