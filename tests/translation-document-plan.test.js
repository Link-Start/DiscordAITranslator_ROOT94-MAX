const test = require("node:test");
const assert = require("node:assert/strict");
const {original14Markdown} = require("./fixtures/s8b-m0a-mixed-language-fixtures");
const {planTranslationDocument} = require("../src/planner/translation-document-plan");
const {createTranslationDocumentShadowStore} = require("../src/diagnostics/translation-document-shadow-store");

test("M1c losslessly closes received body, Embed, forward and reply fields", () => {
	const document = planTranslationDocument({body: original14Markdown, embeds: [{title: "Title", description: "Description", footer: {text: "Footer"}, fields: [{name: "Name", value: "Value"}]}], forwarded: [{body: "Forwarded body"}], reply: {body: "Referenced body", documentIdentity: "dp1:prior"}, attachments: [{name: "excluded.txt"}]}, {direction: "received", targetLanguageId: "zh-CN"});
	for (const fieldPath of ["body", "embeds.0.title", "embeds.0.description", "embeds.0.footer.text", "embeds.0.fields.0.name", "embeds.0.fields.0.value", "forwarded.0.body", "reply.body"]) assert.ok(document.fields.some(field => field.fieldPath === fieldPath), fieldPath);
	assert.equal(document.coverageComplete, true); assert.equal(document.attachmentsIncluded, false); assert.equal(document.attachmentPolicy, "excluded");
	assert.equal(document.fields.find(field => field.fieldPath === "reply.body").relation.reuseDocumentIdentity, "dp1:prior");
});

test("M1c sent direction is independent and repeated plans are stable", () => {
	const input = {body: "Hello **world**"}, receivedA = planTranslationDocument(input, {direction: "received", targetLanguageId: "zh-CN"}), receivedB = planTranslationDocument(input, {direction: "received", targetLanguageId: "zh-CN"}), sent = planTranslationDocument(input, {direction: "sent", targetLanguageId: "zh-CN"});
	assert.equal(receivedA.documentIdentity, receivedB.documentIdentity); assert.deepEqual(receivedA.fields.map(field => field.plan.nodes.map(node => node.id)), receivedB.fields.map(field => field.plan.nodes.map(node => node.id))); assert.notEqual(receivedA.documentIdentity, sent.documentIdentity); assert.equal(sent.direction, "sent");
});

test("M1c document shadow is bounded, anonymous, persistent and resource-clean", () => {
	let saved = null; const store = createTranslationDocumentShadowStore({capacity: 2, load: () => saved, save: value => {saved = JSON.parse(JSON.stringify(value));}}); store.start();
	store.observe({body: "private source alpha", embeds: [{title: "private title"}]}, {lane: "manual", direction: "received"}); store.observe({body: "beta"}, {lane: "history-primary", direction: "received"}); store.observe({body: "gamma"}, {lane: "sent", direction: "sent"});
	const snapshot = store.getSnapshot(), serialized = JSON.stringify(snapshot); assert.equal(snapshot.rowCount, 2); assert.equal(snapshot.evictedCount, 1); assert.equal(snapshot.attachmentsIncluded, false); assert.ok(snapshot.persistedBytes < 1024 * 1024); assert.doesNotMatch(serialized, /private source|private title|beta|gamma/); assert.equal(snapshot.resources.active, 0); store.stop(); assert.equal(store.getSnapshot().resources.active, 0);
	const restored = createTranslationDocumentShadowStore({load: () => saved}); restored.start(); assert.equal(restored.getSnapshot().rowCount, 2); for (let index = 0; index < 100; index++) {restored.reset(); restored.observe({body: `sample ${index}`}, {lane: "manual"}); restored.stop(); restored.start();} assert.equal(restored.getSnapshot().resources.active, 0);
});

test("document shared collector preserves fixed pre-refactor full-plan structures for all field priorities", () => {
 const crypto = require("node:crypto"), cases = require("./fixtures/document-plan-baseline.json");
 for (const [index, fixture] of cases.entries()) {
  const plan = planTranslationDocument(fixture.input, fixture.options);
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex"), fixture.sha256, "baseline full source hashes/nodes/identity/coverage/relations case " + index);
 }
 assert.throws(() => planTranslationDocument(null));
});
