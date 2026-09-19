const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const planner = require("../src/planner/translation-document-plan");

function harness({capacity, failPlan = () => false, failSave = () => false, failClear = () => false, plannerCost = 0} = {}) {
 const state = {plans: 0, saves: [], now: 1000}, timers = new Map(); let sequence = 0, saved = null;
 const filename = require.resolve("../src/diagnostics/translation-document-shadow-store"), nativeRequire = Module.createRequire(filename), module = {exports: {}};
 const localRequire = id => id === "../planner/translation-document-plan" ? Object.assign({}, planner, {planTranslationDocument(...args) {state.plans++; state.now += plannerCost; if (failPlan()) throw new Error("synthetic planner failure"); return planner.planTranslationDocument(...args);}}) : nativeRequire(id);
 vm.runInThisContext(Module.wrap(fs.readFileSync(filename, "utf8")), {filename})(module.exports, localRequire, module, filename, path.dirname(filename));
 const store = module.exports.createTranslationDocumentShadowStore({capacity, now: () => state.now, load: () => saved, save: value => {if (failSave()) throw new Error("synthetic persistence failure"); saved = JSON.parse(JSON.stringify(value)); state.saves.push(saved);}, setTimer: (callback, delay) => {const id = ++sequence; timers.set(id, {callback, due: state.now + delay}); return id;}, clearTimer: id => {if (failClear()) throw new Error("synthetic clear failure"); timers.delete(id);}});
 return {store, state, timers, persisted: () => saved, advance(ms) {state.now += ms; for (const [id, timer] of [...timers]) if (timer.due <= state.now) {timers.delete(id); timer.callback();}}};
}

test("document shadow repeats reuse planning while preserving newest record and coalescing persistence", () => {
 const h = harness(); h.store.start();
 try {
  let last;
  for (let index = 0; index < 200; index++) {h.state.now++; last = h.store.observe({content: "Please review **these notes**.", embeds: [{title: "Release title"}]}, {lane: "manual", targetLanguageId: "zh-CN"});}
  assert.deepEqual({plans: h.state.plans, saves: h.state.saves.length}, {plans: 1, saves: 0});
  const snapshot = h.store.getSnapshot(); assert.equal(snapshot.rowCount, 1); assert.equal(snapshot.rows[0], last); assert.equal(last.recordedAt, 1200);
  assert.deepEqual(snapshot.resources, {active: 0}); assert.equal(h.timers.size, 1);
  h.advance(500); assert.equal(h.state.saves.length, 1); assert.equal(h.persisted().rows[0].recordedAt, 1200);
  h.store.stop(); assert.equal(h.timers.size, 0); assert.equal(h.state.saves.length, 1);
 } finally {h.store.stop();}
});

test("document shadow failed persistence remains dirty across stop and restart until it is saved", () => {
 let failing = true; const h = harness({failSave: () => failing}); h.store.start();
 try {
  const row = h.store.observe({body: "Pending source"}, {lane: "manual"});
  h.store.stop(); assert.equal(h.timers.size, 0); assert.equal(h.state.saves.length, 0);
  h.store.start(); assert.equal(h.store.getSnapshot().rows[0].key, row.key, "restart retains the unsaved newest event when persistence still fails");
  failing = false; h.store.stop(); assert.equal(h.state.saves.length, 1); assert.equal(h.persisted().rows[0].key, row.key);
 } finally {failing = false; h.store.stop();}
});

test("document shadow stop isolates timer-clear failure and invalidates its late callback", () => {
 let fail = true; const h = harness({failClear: () => fail}); h.store.start();
 try {
  h.store.observe({body: "Before stop"}, {lane: "manual"}); const late = [...h.timers.values()][0].callback;
  assert.doesNotThrow(() => h.store.stop()); assert.equal(h.state.saves.length, 1, "stop still synchronously flushes newest rows");
  late(); assert.equal(h.state.saves.length, 1, "the lost host timer cannot save after stop");
  fail = false; h.store.start(); h.store.observe({body: "Before stop"}, {lane: "manual"}); assert.equal(h.state.plans, 2, "stop invalidates the only reuse slot");
  late(); assert.equal(h.state.saves.length, 1, "old timer cannot steal a later session's pending save");
  h.store.stop(); assert.equal(h.state.saves.length, 2); assert.deepEqual(h.store.getSnapshot().resources, {active: 0});
 } finally {fail = false; h.store.stop(); h.timers.clear();}
});

test("document shadow oversized reuse keys bypass the memory slot without skipping normal planning", () => {
 const h = harness(), input = {body: "Synthetic sentence. ".repeat(4000)}; h.store.start();
 try {
  const first = h.store.observe(input, {lane: "manual"}), second = h.store.observe(input, {lane: "manual"});
  assert.ok(first); assert.ok(second); assert.equal(h.state.plans, 2, "a key larger than 64 Ki code units is not retained for reuse");
  assert.equal(first.documentIdentity, second.documentIdentity); assert.equal(h.store.getSnapshot().rowCount, 1);
  h.store.observe({body: "Small document"}, {lane: "manual"}); h.store.observe({body: "Small document"}, {lane: "manual"});
  assert.equal(h.state.plans, 3, "bounded documents still reuse the slot"); h.store.stop(); assert.equal(h.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(h.persisted()), /Synthetic sentence|Small document/);
 } finally {h.store.stop();}
});

test("document shadow nested edits reply relation and language-direction changes invalidate only the exact projection", () => {
 const h = harness(), input = {body: "Body", content: "Ignored", embeds: [{title: "Title", description: "Description", footer: {text: "Footer"}, fields: [{name: "Name", value: "Value"}]}], forwarded: [{body: "Forward"}], reply: {body: "Reply", documentIdentity: "dp1:before"}, sent: {body: "Sent"}}, metadata = {direction: "received", targetLanguageId: "zh-CN", lane: "manual"};
 h.store.start();
 try {
  let count = 0;
  const check = () => {const row = h.store.observe(input, metadata); assert.ok(row); assert.equal(h.state.plans, ++count); const expected = planner.planTranslationDocument(input, metadata); assert.equal(row.documentIdentity, expected.documentIdentity); assert.equal(row.nodeCount, expected.nodeCount); assert.deepEqual(row.fields.map(field => [field.fieldPath, field.planHash, field.sourceLength, field.relation.reusesDocument]), expected.fields.map(field => [field.fieldPath, field.plan.sourceHash, field.plan.sourceLength, !!field.relation.reuseDocumentIdentity]));};
  check();
  for (const change of [() => {input.body = "Changed body";}, () => {input.embeds[0].title = "Changed title";}, () => {input.embeds[0].description = "Changed description";}, () => {input.embeds[0].footer.text = "Changed footer";}, () => {input.embeds[0].fields[0].name = "Changed name";}, () => {input.embeds[0].fields[0].value = "Changed value";}, () => {input.forwarded[0].body = "Changed forward";}, () => {input.reply.body = "Changed reply";}, () => {input.reply.documentIdentity = null;}, () => {metadata.targetLanguageId = "en";}, () => {metadata.direction = "sent";}, () => {input.sent.body = "Changed sent";}]) {change(); check();}
  input.content = "Still ignored"; input.attachments = [{name: "Private-attachment-filename"}]; input.id = "unrelated";
  const latest = h.store.observe(input, metadata); assert.ok(latest); assert.equal(h.state.plans, count, "non-planner data does not invalidate the slot");
  assert.equal(h.store.getSnapshot().resources.active, 0); assert.doesNotMatch(JSON.stringify(h.store.getSnapshot()), /Changed body|Changed title|Changed reply|unrelated|Private-attachment-filename/);
 } finally {h.store.stop();}
});

test("document shadow reuses across lanes but preserves distinct keys latest ordering freshness and local duration", () => {
 const h = harness({plannerCost: 2}), input = {body: "Shared document"}; h.store.start();
 try {
  for (const lane of ["manual", "auto-single", "live-burst", "history-primary", "batch-repair", "item-repair", "reply", "sent"]) {h.state.now++; assert.ok(h.store.observe(input, {lane}));}
  let snapshot = h.store.getSnapshot(); assert.equal(h.state.plans, 1); assert.equal(snapshot.rowCount, 8); assert.equal(snapshot.rows[0].durationMicros, 2000); assert.equal(snapshot.rows[1].durationMicros, 0);
  h.state.now++; const newest = h.store.observe(input, {lane: "manual"}); snapshot = h.store.getSnapshot();
  assert.equal(snapshot.rowCount, 8); assert.equal(snapshot.rows.at(-1), newest); assert.equal(newest.recordedAt, h.state.now); assert.equal(newest.durationMicros, 0);
  h.advance(600); assert.equal(h.state.saves.length, 1);
  for (let index = 0; index < 3; index++) {h.store.observe(input, {lane: "manual"}); h.advance(600);}
  assert.equal(h.state.plans, 1); assert.equal(h.state.saves.length, 4, "spaced changes still persist current recordedAt");
 } finally {h.store.stop();}
});

test("document shadow reset start and stop clear reuse while reset and stop flush exactly newest anonymous content", () => {
 const h = harness(), input = {body: "Lifecycle source"}; h.store.start();
 try {
  h.store.observe(input, {lane: "manual"}); const oldTimer = [...h.timers.values()][0].callback;
  h.store.reset(); assert.equal(h.timers.size, 0); assert.equal(h.state.saves.length, 1); assert.deepEqual(h.persisted().rows, []);
  oldTimer(); assert.equal(h.state.saves.length, 1);
  h.store.observe(input, {lane: "manual"}); assert.equal(h.state.plans, 2); h.store.start(); assert.equal(h.timers.size, 0); assert.equal(h.state.saves.length, 2);
  h.store.observe(input, {lane: "manual"}); assert.equal(h.state.plans, 3); h.store.stop(); assert.equal(h.state.saves.length, 3); assert.equal(h.timers.size, 0);
  h.store.start(); h.store.observe(input, {lane: "manual"}); assert.equal(h.state.plans, 4); h.store.stop(); assert.equal(h.state.saves.length, 4);
  assert.equal(h.persisted().schemaVersion, 1); assert.doesNotMatch(JSON.stringify(h.persisted()), /Lifecycle source/);
 } finally {h.store.stop();}
});

test("document shadow planner failures never cache failure or suppress a successful retry", () => {
 let fail = true; const h = harness({failPlan: () => fail}); h.store.start();
 try {
  assert.equal(h.store.observe({body: "Retry source"}, {lane: "manual"}), null); assert.equal(h.state.plans, 1); assert.equal(h.timers.size, 0); assert.equal(h.store.getSnapshot().rowCount, 0);
  fail = false; assert.ok(h.store.observe({body: "Retry source"}, {lane: "manual"})); assert.equal(h.state.plans, 2);
  fail = true; assert.equal(h.store.observe({body: "Changed retry source"}, {lane: "manual"}), null); assert.equal(h.state.plans, 3);
  fail = false; assert.ok(h.store.observe({body: "Changed retry source"}, {lane: "manual"})); assert.equal(h.state.plans, 4); assert.equal(h.store.getSnapshot().resources.active, 0);
 } finally {h.store.stop();}
});

test("document shadow capacity remains 128 with replacement ordering eviction and latest flush", () => {
 const h = harness({capacity: 1000}); h.store.start();
 try {
  for (let index = 0; index < 140; index++) {h.state.now++; h.store.observe({body: "Unique document " + index}, {lane: "manual"});}
  assert.equal(h.state.plans, 140); let snapshot = h.store.getSnapshot(); assert.equal(snapshot.rowCount, 128); assert.equal(snapshot.evictedCount, 12);
  h.store.observe({body: "Unique document 20"}, {lane: "manual"}); snapshot = h.store.getSnapshot(); assert.equal(snapshot.rowCount, 128); assert.equal(snapshot.evictedCount, 12);
  h.store.stop(); assert.equal(h.state.saves.length, 1); assert.equal(h.persisted().rows.length, 128); assert.equal(h.persisted().evictedCount, 12); assert.equal(h.timers.size, 0);
 } finally {h.store.stop();}
});
