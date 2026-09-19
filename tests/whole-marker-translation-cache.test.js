const test = require("node:test");
const assert = require("node:assert/strict");
const {createWholeMarkerTranslationCacheStore} = require("../src/cache/translation-cache-store");
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const identity = () => ({messageId: "paid-one", channelId: "channel-one", source: "Please translate this sentence.", inputLanguageId: "en", targetLanguageId: "zh-CN", providerHash: "1".repeat(64), promptHash: "2".repeat(64), protectionHash: "3".repeat(64), policyHash: "4".repeat(64), planHash: "5".repeat(64), plannerVersion: "planner-v1", wireVersion: "whole-marker-v2", validatorVersion: "validator-v2", reassemblyVersion: "reassembly-v1"});
const translated = () => ({channelId: "channel-one", originalContent: "Please translate this sentence.", translatedContent: "请翻译这个句子。", wireFamily: "whole-marker"});
function fixture(initial = null) {
 let disk = clone(initial), fail = false, time = 0, serial = 0, loadHook = null;
 const timers = new Map(), saves = [], loads = [];
 const store = createWholeMarkerTranslationCacheStore({now: () => time,
  setTimeout: (fn, ms) => {const id = ++serial; timers.set(id, {fn, due: time + ms}); return id;}, clearTimeout: id => timers.delete(id),
  loadCache: () => {loads.push(clone(disk)); return loadHook ? loadHook(clone(disk)) : clone(disk);},
  saveCache: value => {saves.push(clone(value)); if (fail) throw new Error("fixture save failure"); disk = clone(value);}
 });
 store.loadPersisted();
 return {store, timers, saves, loads, disk: () => clone(disk), setDisk: value => {disk = clone(value);}, fail: value => {fail = value;}, onLoad: fn => {loadHook = fn;},
  advance(ms) {time += ms; for (const [id, timer] of [...timers]) if (timer.due <= time) {timers.delete(id); timer.fn();}}
 };
}

test("D partition roundtrip uses exact identity and a separate versioned envelope", () => {
 const h = fixture(), id = identity();
 assert.equal(h.store.persistTranslation(id, translated()), true);
 assert.deepEqual(h.store.getCachedTranslation(id), translated());
 assert.equal(h.store.flushPendingSave(), true);
 assert.equal(h.disk().version, 1);
 assert.equal(fixture(h.disk()).store.getCachedTranslation(id).translatedContent, "请翻译这个句子。");
});
test("D partition does not return malformed or explicitly non-cacheable stored results", () => {
 const h = fixture(), id = identity(); h.store.persistTranslation(id, translated()); h.store.flushPendingSave();
 for (const patch of [{translatedContent: ""}, {channelId: "other"}, {originalContent: "edited"}, {cacheWrite: false}]) {
  const disk = h.disk(); Object.assign(disk.entries["d:paid-one"].translation, patch);
  const reader = fixture(disk); assert.equal(reader.store.getCachedTranslation(id), null); assert.deepEqual(reader.disk(), disk);
 }
});
test("D wiring writes only its own key and leaves the typed key unchanged", () => {
 const {createPluginWholeMarkerTranslationCacheStore} = require("../src/cache/translation-cache-wiring");
 const disk = {translationCache: {paid: {translation: {translatedContent: "保留原译文"}}}}, before = clone(disk.translationCache), loaded = [], saved = [];
 const store = createPluginWholeMarkerTranslationCacheStore({plugin: {}, BDFDB: {
  TimeUtils: {timeout: () => 1, clear: () => {}},
  DataUtils: {load: (_plugin, key) => {loaded.push(key); return clone(disk[key]);}, save: (value, _plugin, key) => {saved.push(key); disk[key] = clone(value);}}
 }});
 store.loadPersisted(); assert.equal(store.persistTranslation(identity(), translated()), true); store.flushPendingSave();
 assert.deepEqual(loaded, ["translationCacheWholeMarker"]); assert.deepEqual(saved, ["translationCacheWholeMarker"]);
 assert.deepEqual(disk.translationCache, before); assert.equal(disk.translationCacheWholeMarker.version, 1);
});
test("D identity requires every field; mismatch or omission is a nondestructive miss", () => {
 const h = fixture(), id = identity(); h.store.persistTranslation(id, translated()); h.store.flushPendingSave(); const before = h.disk();
 for (const key of Object.keys(id)) {
  const changed = {...id, [key]: key.endsWith("Hash") ? "a".repeat(64) : id[key] + "-changed"};
  assert.equal(h.store.getCachedTranslation(changed), null, key);
  const missing = {...id}; delete missing[key]; assert.equal(h.store.getCachedTranslation(missing), null, "missing " + key);
  assert.equal(h.store.persistTranslation(missing, translated()), false);
 }
 assert.equal(h.store.getCachedTranslation({...id, providerHash: "h1:short"}), null);
 assert.equal(h.store.getCachedTranslation({...id, futureField: "unknown"}), null);
 assert.equal(h.store.getCachedTranslation(Object.fromEntries(Object.entries(id).reverse())).translatedContent, "请翻译这个句子。");
 assert.equal(h.store.getEntryCount(), 1); assert.deepEqual(h.disk(), before); assert.equal(h.store.flushPendingSave(), false);
});

test("D writes and reads do not share mutable input or returned objects", () => {
 const h = fixture(), id = identity(), value = {...translated(), embeds: {one: {text: "附加数据"}}};
 h.store.persistTranslation(id, value); id.source = "changed"; value.embeds.one.text = "changed";
 const hit = h.store.getCachedTranslation(identity()); assert.equal(hit.embeds.one.text, "附加数据"); hit.embeds.one.text = "returned mutation";
 assert.equal(h.store.getCachedTranslation(identity()).embeds.one.text, "附加数据"); assert.equal(Object.hasOwn(hit, "cacheIdentity"), false);
});

test("D store rejects typed fallback, explicit no-write and invalid output", () => {
 const h = fixture();
 for (const patch of [{wireFamily: "typed-json"}, {cacheWrite: false}, {translatedContent: " "}, {channelId: "other"}, {originalContent: "other"}]) assert.equal(h.store.persistTranslation(identity(), {...translated(), ...patch}), false);
 const cyclic = translated(); cyclic.self = cyclic; assert.equal(h.store.persistTranslation(identity(), cyclic), false);
 assert.equal(h.store.getEntryCount(), 0); assert.equal(h.store.flushPendingSave(), false); assert.equal(h.saves.length, 0);
});

test("D pending writes and removals survive reload through the existing dirty owner", () => {
 const h = fixture(); h.store.persistTranslation(identity(), translated()); h.store.loadPersisted();
 assert.ok(h.store.getCachedTranslation(identity())); assert.equal(h.saves.length, 1); assert.equal(h.timers.size, 0);
 h.store.clear(identity().messageId); h.store.loadPersisted(); assert.equal(h.store.getCachedTranslation(identity()), null); assert.deepEqual(h.disk().entries, {});
});

test("D debounce remains 300 ms, save failure retains dirty data and explicit retry persists it", () => {
 const h = fixture(); h.store.persistTranslation(identity(), translated()); h.advance(299); assert.equal(h.saves.length, 0);
 h.fail(true); h.advance(1); assert.equal(h.saves.length, 1); assert.equal(h.timers.size, 0); assert.ok(h.store.getCachedTranslation(identity()));
 h.store.loadPersisted(); assert.equal(h.loads.length, 1, "failed flush does not adopt older disk"); assert.ok(h.store.getCachedTranslation(identity()));
 h.fail(false); assert.equal(h.store.flushPendingSave(), true); assert.equal(fixture(h.disk()).store.getCachedTranslation(identity()).translatedContent, "请翻译这个句子。");
 assert.equal(h.store.flushPendingSave(), false);
});

test("D burst saves merge and explicit cancellation does not masquerade as a flush", () => {
 const h = fixture(); h.store.persistTranslation(identity(), translated());
 h.store.persistTranslation({...identity(), messageId: "paid-two"}, translated()); h.advance(300); assert.equal(h.saves.length, 1);
 h.store.clearAll(); h.store.cancelPendingSave(); assert.equal(h.store.flushPendingSave(), false); h.store.loadPersisted(); assert.equal(h.store.getEntryCount(), 2);
 assert.equal(h.store.clearAll(), 2); h.store.flushPendingSave(); assert.deepEqual(h.disk().entries, {});
});

test("D unknown or malformed envelope is preserved and cannot be overwritten", () => {
 for (const disk of [{version: 2, entries: {future: {paid: true}}}, {version: 1, entries: []}, {version: 1, entries: {broken: null}}, ["legacy"], {}]) {
  const h = fixture(disk); assert.equal(h.store.loadPersisted(), false); assert.equal(h.store.getCachedTranslation(identity()), null);
  assert.equal(h.store.persistTranslation(identity(), translated()), false); h.store.clear(identity().messageId); assert.equal(h.store.clearAll(), 0);
  assert.equal(h.store.flushPendingSave(), false); assert.deepEqual(h.disk(), disk); assert.equal(h.saves.length, 0);
  h.setDisk({version: 1, entries: {}}); assert.equal(h.store.loadPersisted(), true); assert.equal(h.store.persistTranslation(identity(), translated()), true);
 }
});

test("D partition uses the existing 500-entry bound and keeps the newest result", () => {
 const h = fixture();
 for (let i = 0; i < 501; i++) {h.store.persistTranslation({...identity(), messageId: String(i)}, translated()); h.advance(1);}
 assert.equal(h.store.getEntryCount(), 500); assert.equal(h.store.getCachedTranslation({...identity(), messageId: "0"}), null);
 assert.ok(h.store.getCachedTranslation({...identity(), messageId: "500"})); h.store.flushPendingSave(); assert.equal(Object.keys(h.disk().entries).length, 500);
});

test("D record keys cannot mutate the cache object prototype", () => {
 const h = fixture(), id = {...identity(), messageId: "__proto__"}; assert.equal(h.store.persistTranslation(id, translated()), true);
 assert.equal(h.store.getEntryCount(), 1); assert.ok(h.store.getCachedTranslation(id)); h.store.clear(id.messageId); assert.equal(h.store.getEntryCount(), 0);
});
test("D load rejects reentrant mutations and can recover after an unknown envelope", () => {
 const h = fixture(), future = {version: 2, entries: {future: {paid: true}}}; let accepted;
 h.store.persistTranslation(identity(), translated()); h.store.flushPendingSave(); const known = h.disk(); h.setDisk(future);
 h.onLoad(value => {accepted = h.store.persistTranslation({...identity(), messageId: "arrived-during-load"}, translated()); h.store.clear(identity().messageId); h.store.clearAll(); return value;});
 assert.equal(h.store.loadPersisted(), false); assert.equal(accepted, false, "a write during envelope inspection must report not accepted");
 assert.equal(h.store.flushPendingSave(), false); assert.deepEqual(h.disk(), future);
 h.onLoad(null); h.setDisk(known); assert.equal(h.store.loadPersisted(), true); assert.ok(h.store.getCachedTranslation(identity()));
 assert.equal(h.store.persistTranslation({...identity(), messageId: "arrived-during-load"}, translated()), true); assert.equal(h.store.flushPendingSave(), true);
});