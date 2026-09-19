const test = require("node:test");
const assert = require("node:assert/strict");
const {createTranslationCacheStore, TRANSLATION_CACHE_SAVE_DEBOUNCE_MS} = require("../src/cache/translation-cache-store");
const clone = value => JSON.parse(JSON.stringify(value));
const translation = text => ({translatedContent: text, originalContent: "Synthetic original", channelId: "cache-persistence-fixture"});

// Only persistence and scheduling are doubles. No provider or cache-policy callbacks
// participate: these tests exercise ownership of an already-paid cache mutation.
function harness({firstTimerId = 1} = {}) {
 let disk = {}, clock = 0, nextId = firstTimerId, failSave = false, failClear = false, failSchedule = false, saveHook = null, loadHook = null;
 const timers = new Map(), saves = [], loads = [];
 const store = createTranslationCacheStore({
  now: () => clock,
  setTimeout: (callback, delay) => {if (failSchedule) throw new Error("synthetic schedule failure"); const id = nextId++; timers.set(id, {callback, due: clock + delay}); return id;},
  clearTimeout: id => {if (failClear) throw new Error("synthetic clear failure"); timers.delete(id);},
  loadCache: () => {loads.push(clone(disk)); return loadHook ? loadHook(clone(disk)) : clone(disk);},
  saveCache: value => {
   const snapshot = clone(value); saves.push(snapshot);
   if (failSave) throw new Error("synthetic save failure");
   if (saveHook) saveHook(snapshot);
   disk = snapshot;
  }
 });
 store.loadPersisted();
 return {store, timers, saves, loads, disk: () => clone(disk), setDisk: value => {disk = clone(value);},
  failSchedule: value => {failSchedule = value;}, failSave: value => {failSave = value;}, failClear: value => {failClear = value;}, onSave: value => {saveHook = value;}, onLoad: value => {loadHook = value;},
  advance(ms) {clock += ms; for (const [id, item] of [...timers]) if (item.due <= clock) {timers.delete(id); item.callback();}},
  write(id = "paid", text = "已经付费的译文") {store.persistTranslation(id, "sig-" + id, translation(text));}
 };
}

test("cache persistence reload flushes a pending paid write before reading disk", () => {
 const h = harness(); h.write();
 const result = h.store.loadPersisted();
 assert.ok(result.paid, "reload must retain the just-paid translation");
 assert.equal(h.saves.length, 1); assert.equal(h.loads.length, 2); assert.equal(h.timers.size, 0);
 assert.equal(h.disk().paid.translation.translatedContent, "已经付费的译文");
 h.advance(1000); assert.equal(h.saves.length, 1);
});

for (const operation of ["clear", "clearAll"]) test(`cache persistence pending ${operation} survives reload without reviving disk entries`, () => {
 const h = harness(); h.write(); h.store.flushPendingSave();
 if (operation === "clear") h.store.clear("paid"); else assert.equal(h.store.clearAll(), 1);
 assert.equal(h.store.hasEntry("paid"), false);
 h.store.loadPersisted();
 assert.equal(h.store.hasEntry("paid"), false, "the pending removal must reach disk before adoption");
 assert.deepEqual(h.disk(), {}); assert.equal(h.saves.length, 2); assert.equal(h.timers.size, 0);
});

test("cache persistence failed reload flush preserves dirty memory and retries with no timer", () => {
 const h = harness(); h.write(); h.failSave(true);
 assert.doesNotThrow(() => h.store.loadPersisted());
 assert.ok(h.store.getEntry("paid"), "failed persistence is not permission to replace dirty memory");
 assert.equal(h.loads.length, 1, "do not read an older disk snapshot after failed flush");
 assert.equal(h.timers.size, 0); assert.deepEqual(h.disk(), {});
 h.failSave(false); assert.equal(h.store.flushPendingSave(), true);
 assert.ok(h.disk().paid); assert.equal(h.store.flushPendingSave(), false); assert.equal(h.saves.length, 2);
});

test("cache persistence failed timer save is isolated and leaves a retryable dirty cache", () => {
 const h = harness(); h.write(); h.failSave(true);
 assert.doesNotThrow(() => h.advance(TRANSLATION_CACHE_SAVE_DEBOUNCE_MS));
 assert.equal(h.timers.size, 0); assert.ok(h.store.getEntry("paid")); assert.deepEqual(h.disk(), {});
 h.failSave(false); assert.equal(h.store.flushPendingSave(), true); assert.ok(h.disk().paid); assert.equal(h.saves.length, 2);
});

test("cache persistence explicit cancel abandons dirty persistence and permits disk reload", () => {
 const h = harness(); h.write(); h.store.cancelPendingSave();
 assert.equal(h.timers.size, 0); assert.equal(h.store.flushPendingSave(), false); assert.equal(h.saves.length, 0);
 assert.ok(h.store.getEntry("paid"), "cancel does not itself erase in-memory data");
 h.store.loadPersisted(); assert.equal(h.store.hasEntry("paid"), false); assert.equal(h.saves.length, 0);
 h.write("later"); h.advance(300); assert.ok(h.disk().later); assert.equal(h.saves.length, 1);
});

test("cache persistence explicit cancel also abandons a dirty failed-flush retry", () => {
 const h = harness(); h.write(); h.failSave(true); assert.equal(h.store.flushPendingSave(), false);
 h.store.cancelPendingSave(); h.failSave(false);
 assert.equal(h.store.flushPendingSave(), false); assert.equal(h.saves.length, 1);
 h.store.loadPersisted(); assert.equal(h.store.hasEntry("paid"), false);
});

test("cache persistence clean reload keeps adopting externally updated disk values", () => {
 const h = harness(); h.write(); h.store.flushPendingSave();
 h.setDisk({external: {signature: "external", cachedAt: 1, translation: translation("外部译文")}});
 const adopted = h.store.loadPersisted();
 assert.equal(h.store.hasEntry("paid"), false); assert.equal(adopted.external.translation.translatedContent, "外部译文"); assert.equal(h.saves.length, 1);
 h.setDisk([]); assert.deepEqual(h.store.loadPersisted(), {});
});

test("cache persistence successful flush still adopts the load callback latest snapshot", () => {
 const h = harness(); h.write();
 h.onLoad(value => ({...value, external: {signature: "external", translation: translation("刚刚更新")}}));
 const adopted = h.store.loadPersisted();
 assert.ok(adopted.paid); assert.ok(adopted.external); assert.equal(h.saves.length, 1); assert.equal(h.loads.length, 2);
});

test("cache persistence reentrant mutation during a save remains dirty for a second flush", () => {
 const h = harness(); h.write("first");
 h.onSave(() => {h.onSave(null); h.write("second");});
 assert.equal(h.store.flushPendingSave(), true);
 assert.ok(h.disk().first); assert.equal(h.disk().second, undefined, "the synthetic save captured its argument before reentry");
 assert.ok(h.store.getEntry("second"));
 assert.equal(h.store.flushPendingSave(), true, "newer mutation is still outstanding after the older save succeeds");
 assert.ok(h.disk().second); assert.equal(h.saves.length, 2); assert.equal(h.store.flushPendingSave(), false);
});

test("cache persistence reload does not adopt disk while a reentrant save left newer dirty data", () => {
 const h = harness(); h.write("first");
 h.onSave(() => {h.onSave(null); h.write("second");});
 h.store.loadPersisted();
 assert.ok(h.store.getEntry("second"), "reentrant paid entry must not be overwritten by the prior snapshot");
 h.store.flushPendingSave(); assert.ok(h.disk().first); assert.ok(h.disk().second);
});

test("cache persistence clear failure does not let an old timer save after explicit flush", () => {
 const h = harness(); h.write(); const callback = [...h.timers.values()][0].callback;
 h.failClear(true);
 assert.doesNotThrow(() => assert.equal(h.store.flushPendingSave(), true));
 callback(); assert.equal(h.saves.length, 1, "invalidated callback is inert even if the host failed to clear it");
 assert.equal(h.store.flushPendingSave(), false);
});

for (const operation of ["flush", "cancel"]) test(`cache persistence timer id zero supports ${operation}`, () => {
 const h = harness({firstTimerId: 0}); h.write(); assert.equal(h.timers.has(0), true);
 if (operation === "flush") {assert.equal(h.store.flushPendingSave(), true); assert.equal(h.saves.length, 1);}
 else {h.store.cancelPendingSave(); assert.equal(h.store.flushPendingSave(), false); assert.equal(h.saves.length, 0);}
 assert.equal(h.timers.size, 0);
});

test("cache persistence keeps the 300 ms burst debounce and saves the latest full cache once", () => {
 const h = harness(); h.write("one"); h.advance(100); h.write("two"); h.advance(100); h.write("three");
 assert.equal(h.timers.size, 1); h.advance(299); assert.equal(h.saves.length, 0);
 h.advance(1); assert.equal(h.saves.length, 1); assert.deepEqual(Object.keys(h.disk()), ["one", "two", "three"]); assert.equal(h.timers.size, 0);
});

test("cache persistence failed clear on cancel invalidates old callback before a fresh write", () => {
 const h = harness(); h.write("old"); const oldCallback = [...h.timers.values()][0].callback;
 h.failClear(true); assert.doesNotThrow(() => h.store.cancelPendingSave()); h.failClear(false); h.write("new");
 oldCallback(); assert.equal(h.saves.length, 0, "cancelled generation never steals the new debounce window");
 h.advance(300); assert.equal(h.saves.length, 1); assert.ok(h.disk().new);
});
test("cache persistence scheduler failure keeps the mutation retryable without a timer", () => {
 const h = harness(); h.failSchedule(true);
 assert.doesNotThrow(() => h.write()); assert.equal(h.timers.size, 0); assert.ok(h.store.getEntry("paid"));
 assert.equal(h.store.flushPendingSave(), true); assert.ok(h.disk().paid); assert.equal(h.saves.length, 1);
});
test("cache persistence load callback reentry preserves the newly paid in-memory entry", () => {
 const h = harness();
 h.onLoad(oldSnapshot => {h.onLoad(null); h.write("reentrant"); return oldSnapshot;});
 const result = h.store.loadPersisted();
 assert.ok(result.reentrant, "a stale load return must not replace data created during that load callback");
 assert.ok(h.store.getEntry("reentrant")); assert.deepEqual(h.disk(), {});
 assert.equal(h.store.flushPendingSave(), true); assert.ok(h.disk().reentrant);
});