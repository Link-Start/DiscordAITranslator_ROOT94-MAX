const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
function fixture() {
 const persisted = {}, documentSaves = [];
 const plugin = createPluginInstance({callSetLanguages: false, settings: {choices: {received: {input: "auto", output: "zh-CN"}, sent: {input: "auto", output: "en"}}}, defaults: {choices: {received: {value: {input: "auto", output: "zh-CN"}}, sent: {value: {input: "auto", output: "en"}}}}, bdfdb: {DataUtils: {load: (_plugin, key) => persisted[key] || {}, save: (value, _plugin, key) => {persisted[key] = JSON.parse(JSON.stringify(value)); if (key === "translationDocumentShadow") documentSaves.push(persisted[key]);}}}});
 try {plugin.onLoad();} catch {}
 plugin.setLanguages();
 plugin.getLanguageChoice = (type, place) => plugin.settings.choices[place][type];
 return {plugin, persisted, documentSaves};
}

test("document shadow public runtime rereads target settings and preserves lane identity before stop flush", async () => {
 const h = fixture();
 try {
  const input = {content: "Public synthetic source", embeds: [{title: "Public title"}]};
  const first = h.plugin.observeTranslationDocumentPlan(input, {lane: "manual", direction: "received", channelId: "shadow-fixture"});
  const auto = h.plugin.observeTranslationDocumentPlan(input, {lane: "auto-single", direction: "received", channelId: "shadow-fixture"});
  assert.equal(first.documentIdentity, auto.documentIdentity); assert.notEqual(first.key, auto.key);
  h.plugin.settings.choices.received.output = "en"; await h.plugin.onSettingsClosed();
  const changed = h.plugin.observeTranslationDocumentPlan(input, {lane: "manual", direction: "received", channelId: "shadow-fixture"});
  assert.notEqual(changed.documentIdentity, first.documentIdentity); assert.equal(h.plugin.getTranslationDocumentShadowSnapshot().rowCount, 3);
  assert.equal(h.documentSaves.length, 0, "the synchronous observation burst has not issued redundant saves");
  await h.plugin.onStop(); assert.equal(h.documentSaves.length, 1); assert.equal(h.persisted.translationDocumentShadow.rows.length, 3);
  assert.deepEqual(h.plugin.getTranslationDocumentShadowSnapshot().resources, {active: 0});
  assert.doesNotMatch(JSON.stringify(h.persisted.translationDocumentShadow), /Public synthetic source|Public title|shadow-fixture/);
 } finally {await h.plugin.onStop();}
});

test("document shadow public reset persists empty state and following observation is flushed by stop", async () => {
 const h = fixture();
 try {
  h.plugin.observeTranslationDocumentPlan({body: "Before reset"}, {lane: "sent", direction: "sent"});
  h.plugin.resetTranslationDocumentShadow(); assert.deepEqual(h.persisted.translationDocumentShadow.rows, []); assert.equal(h.documentSaves.length, 1);
  h.plugin.observeTranslationDocumentPlan({reply: {body: "After reset", documentIdentity: "dp1:prior"}}, {lane: "reply", direction: "received"});
  await h.plugin.onStop(); assert.equal(h.documentSaves.length, 2); assert.equal(h.persisted.translationDocumentShadow.rows.length, 1);
  assert.equal(h.persisted.translationDocumentShadow.rows[0].lane, "reply"); assert.equal(h.persisted.translationDocumentShadow.rows[0].fields[0].relation.reusesDocument, true);
 } finally {await h.plugin.onStop();}
});
