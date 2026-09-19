const test = require("node:test"), assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fixture = require("../fixtures/markdown-gap-synthetic.json");
const {createSemanticRequest, validateSemanticResponse} = require("../../src/planner/translation-semantic-runtime");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const translated = new Map(Object.entries({"Synthetic release notes":"合成版本说明","Translate the explanation but keep the structure.":"翻译说明，但保留结构。","First checklist item":"第一项检查事项","Second checklist item with":"第二项检查事项，包含","spoiler text":"剧透文字","Field":"字段","Value":"值","Status":"状态","Ready for review":"准备好供审阅","Read the synthetic guide":"阅读合成指南","The fenced code and link destination must remain unchanged.":"围栏代码和链接目标必须保持不变。"}));
translated.set("Second checklist item with ⟦F0⟧spoiler text⟦/F0⟧", "第二项检查事项，包含 ⟦F0⟧剧透文字⟦/F0⟧");
translated.set("⟦F0⟧Read the synthetic guide⟦/F0⟧", "⟦F0⟧阅读合成指南⟦/F0⟧");
function rows(plan) {return plan.segments.map(segment => {const translation = translated.get(segment.text.trim()); assert.ok(translation, "all synthetic segments have independently specified translations"); return {id: segment.id, translation};});}

test("typed Markdown gap synthetic source validates trimmed rows but must preserve original syntax separators", () => {
 assert.equal(createHash("sha256").update(fixture.source).digest("hex").toUpperCase(), fixture.sourceSha256);
 const request = createSemanticRequest({engineKey: "oaicompat", source: fixture.source, inputLanguageId: "en", targetLanguageId: "zh-CN"});
 const outcome = validateSemanticResponse(request, JSON.stringify({segments: rows(JSON.parse(request.wire))}));
 assert.equal(outcome.ok, true); assert.equal(outcome.keptCount, 0);
 assert.equal(outcome.translation, fixture.expected);
});

test("typed Markdown gap public translateMessage pipeline preserves structure with locally trimmed provider segments", async () => {
 const calls = [], applied = [], ENGINE = "custom-markdowngap";
 const request = (_url, options, done) => {calls.push(options.body);const wire = JSON.parse(JSON.parse(options.body).messages.at(-1).content); const body = JSON.stringify({choices: [{message: {content: JSON.stringify({segments: rows(wire)})}, finish_reason: "stop"}]}); queueMicrotask(() => done(null, {statusCode: 200}, body)); return {abort() {}};};
 const plugin = createPluginInstance({callSetLanguages: false, bdfdb: {LibraryRequires: {request}}, settings: {engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Markdown fixture"}]}, performance: {liveStreaming: false}, filters: {skipMixedReceivedMessages: false, useLocalLanguagePrecheck: false}, choices: {received: {input: "en", output: "zh-CN"}}, exceptions: {wrapperPairs: [], protectedTerms: []}}});
 try {plugin.onLoad();} catch {}
 plugin.settings.engines.translator = ENGINE; plugin.settings.engines.backup = "----"; plugin.settings.engines.customProviders = [{id: ENGINE, name: "Markdown fixture"}]; plugin.setLanguages();
 plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture", endpoint: "https://markdown.fixture/v1/chat/completions", model: "gemini-fixture", interfaceFormat: "openai_chat", reasoningMode: "off", reasoningProfile: "openai"}});
 plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place][type]; plugin.isTranslationEnabled = () => true; plugin.isOwnMessage = () => false; plugin.getCachedReceivedTranslation = () => null; plugin.getCachedReceivedSkipDecision = () => null; plugin.persistTranslationCacheEntry = () => {}; plugin.applyStoredTranslationToMessage = (_message, stored) => applied.push(stored); plugin.scheduleReceivedDisplayFlush = () => {};
 try {
  const result = await plugin.translateMessage({id: "markdown-gap", channel_id: "gap-fixture", content: fixture.source, embeds: [], attachments: [], author: {id: "other"}}, {id: "gap-fixture"}, {manual: true, silent: true, trackBusy: false});
  assert.equal(result, true, JSON.stringify({calls:calls.length,choices:plugin.settings.choices,ledger:plugin.getTranslationTerminalLedgerSnapshot().recent})); assert.equal(calls.length, 1); assert.equal(applied.length, 1); assert.equal(applied[0].translatedContent, fixture.expected);
 } finally {await plugin.onStop();}
});

test("historical Markdown gap request retains its frozen pre-format reconstruction oracle", () => {
 const request = createSemanticRequest({engineKey: "oaicompat", source: fixture.source, inputLanguageId: "en", targetLanguageId: "zh-CN", inlineFormatting: false, includeNameKeep: false});
 const hash = value => createHash("sha256").update(value).digest("hex");
 assert.equal(hash(request.wire), fixture.wireOracle.wireSha256); assert.equal(hash(request.systemPrompt), fixture.wireOracle.promptSha256); assert.equal(hash(JSON.stringify(request.plan)), fixture.wireOracle.planSha256); assert.deepEqual(request.segmentOrder, fixture.wireOracle.segmentOrder);
});
