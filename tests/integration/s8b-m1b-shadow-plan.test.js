const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {original14Markdown, targetBodyForeignTitle} = require("../fixtures/s8b-m0a-mixed-language-fixtures");

function createPlugin() {
	const persisted = {};
	const plugin = createPluginInstance({pluginPath: process.env.DTA_PLUGIN_PATH || undefined, callSetLanguages: false, settings: {exceptions: {wrapperPairs: ['"|"', '“|”', '`|`'], protectedTerms: []}, choices: {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}}}, defaults: {choices: {received: {value: {input: "auto", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}, bdfdb: {DataUtils: {load: (_plugin, key) => persisted[key] || {}, save: (value, _plugin, key) => {persisted[key] = JSON.parse(JSON.stringify(value));}}}});
	try {plugin.onLoad();} catch {}
	plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place] && plugin.settings.choices[place][type];
	plugin.getReceivedTranslationPlanEligibility = () => ({enabled: false}); return {plugin, persisted};
}

test("S8b M1b production seam merges identical body plans across all approved received lanes", () => {
	const {plugin, persisted} = createPlugin();
	for (const lane of ["manual", "auto-single", "live-burst", "history-primary", "batch-repair", "item-repair", "reply"]) plugin.observeReceivedBodyTranslationPlan(original14Markdown, {lane, channelId: "m1b", legacyHardSkip: false, legacyEligibility: "eligible"});
	plugin.flushTranslationPlanShadow(); const snapshot = plugin.getTranslationPlanShadowSnapshot(); assert.equal(snapshot.rowCount, 1); const row = snapshot.rows[0];
	assert.equal(row.eventCount, 7); assert.equal(row.legacyPlaceholderOccurrences, 8); assert.equal(row.legacyProtectedCandidateTranslateCount, 6); assert.equal(row.alignedProtectedCount, 2); assert.equal(row.candidateHasTranslate, true); assert.equal(row.coverageComplete, true);
	assert.deepEqual(Object.keys(row.lanes), ["manual", "auto-single", "live-burst", "history-primary", "batch-repair", "item-repair", "reply"]); assert.match(row.planHash, /^ph1:/); assert.equal(row.plannerVersion, "m3i-v2"); assert.equal(row.nodeCount, 218); assert.equal(row.contextCount, 72);
	assert.ok(persisted.translationPlanShadow); assert.doesNotMatch(JSON.stringify(persisted.translationPlanShadow), /Degree of Interest|Spouse\/Dependent|```text|https?:|prompt|endpoint|model/i);
});

test("S8b M1b legacy target-body skip remains unchanged while candidate records translate leaves", () => {
	const {plugin} = createPlugin(); const data = {content: targetBodyForeignTitle, embeds: []}, hardSkip = plugin.shouldSkipReceivedTranslationBeforeRequest(data, "m1b"); assert.equal(hardSkip, true);
	plugin.observeReceivedBodyTranslationPlan(targetBodyForeignTitle, {lane: "manual", channelId: "m1b", legacyHardSkip: hardSkip, legacyEligibility: "filtered"});
	const row = plugin.getTranslationPlanShadowSnapshot().rows[0]; assert.equal(row.legacyHardSkip, true); assert.equal(row.candidateHasTranslate, true); assert.ok(row.diffReasons.includes("legacy-skip-candidate-translate"));
});

test("S8b M1b stop flushes and zeros shadow resources without changing production bundle identity", () => {
	const {plugin} = createPlugin(); plugin.observeReceivedBodyTranslationPlan(original14Markdown, {lane: "manual", channelId: "m1b"}); plugin.onStop(); assert.deepEqual(plugin.getTranslationPlanShadowSnapshot().resources, {active: 0, pendingSave: false});
});
