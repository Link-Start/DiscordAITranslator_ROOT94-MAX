const test = require("node:test");
const assert = require("node:assert/strict");
const {createReplyPreviewQueue} = require("../../src/received/reply-preview-queue");

// Contract tests for the reply-preview queue extracted from the legacy runtime in
// display-unification 5d: eligibility gates, cache-hit commits, provider-path
// commit with the pending-token and signature guards.

function createHarness(overrides = {}) {
	const state = Object.assign({
		pending: false,
		suppressed: false,
		enabled: true,
		own: false,
		cached: null,
		previewTranslation: null,
		translation: "hola",
		runtimeActive: true
	}, overrides);
	const calls = {commits: [], marked: [], released: [], translateTexts: []};
	const displayRuntime = {
		isPreviewPending: () => state.pending,
		isSuppressed: () => state.suppressed,
		getPreviewTranslation: () => state.previewTranslation,
		markPreviewPending: request => {calls.marked.push(request); return "token-1";},
		releasePreviewPending: (messageId, token) => {calls.released.push(token); return true;},
		commitPreviewResult: commit => {calls.commits.push(commit); return Promise.resolve();}
	};
	const plugin = {
		ensureReceivedDisplayRuntime: () => displayRuntime,
		shouldAutoTranslateReplyPreview: () => true,
		isTranslationEnabled: () => state.enabled,
		isOwnMessage: () => state.own,
		createReplyPreviewSignature: (message, channelId, content) => `sig:${content}`,
		getCachedReceivedTranslation: () => state.cached,
		createReplyPreviewTranslationData: (message, channelId, cached) => ({signature: `sig:${(message.content || "").trim()}`, channelId, auto: true, translatedContent: cached.translatedContent}),
		translateText: (text, place, callback, forced, options) => {
			calls.translateTexts.push({text, place, options});
			callback(state.translation, {id: "en"}, {id: "zh"});
		}
	};
	const queue = createReplyPreviewQueue({
		getPlugin: () => plugin,
		messageTypes: {RECEIVED: "received", SENT: "sent"},
		isRuntimeActive: () => state.runtimeActive
	});
	return {queue, calls, state};
}

const MESSAGE = {id: "m1", content: "hello"};

test("ineligible previews never reach the provider", () => {
	for (const overrides of [{pending: true}, {suppressed: true}, {enabled: false}, {own: true}]) {
		const {queue, calls} = createHarness(overrides);
		queue.queueReplyPreviewTranslation(MESSAGE, "c1");
		assert.equal(calls.translateTexts.length, 0);
		assert.equal(calls.commits.length, 0);
	}
	const {queue, calls} = createHarness({previewTranslation: {signature: "sig:hello"}});
	queue.queueReplyPreviewTranslation(MESSAGE, "c1");
	assert.equal(calls.translateTexts.length, 0, "an up-to-date preview is not requeued");
});

test("a cached translation commits the preview without a provider request", () => {
	const {queue, calls} = createHarness({cached: {translatedContent: "cached"}});
	queue.queueReplyPreviewTranslation(MESSAGE, "c1");
	assert.equal(calls.translateTexts.length, 0);
	assert.equal(calls.commits.length, 1);
	assert.equal(calls.commits[0].translation.translatedContent, "cached");
});

test("the provider path marks pending, translates silently, and commits the result", () => {
	const {queue, calls} = createHarness();
	queue.queueReplyPreviewTranslation(MESSAGE, "c1");
	assert.equal(calls.marked.length, 1);
	const {isCurrent, ...options} = calls.translateTexts[0].options;
	assert.equal(typeof isCurrent, "function");
	assert.deepEqual(options, {showToast: false, showFailureToast: false, trackBusy: false, channelId: "c1"});
	assert.deepEqual(calls.released, ["token-1"]);
	assert.equal(calls.commits.length, 1);
	assert.equal(calls.commits[0].translation.translatedContent, "hola");
	assert.equal(calls.commits[0].translation.auto, true);
});

test("a stopped runtime drops the provider result instead of committing", () => {
	const {queue, calls, state} = createHarness();
	state.runtimeActive = false;
	queue.queueReplyPreviewTranslation(MESSAGE, "c1");
	assert.equal(calls.commits.length, 0);
});

function createBoundedHarness() {
 const calls = [], commits = [], pending = new Map(), cache = new Map(), timers = new Map();
 let sequence = 0, timerId = 0;
 const state = {runtimeActive: true, enabled: true, historicalBusy: false, liveBusy: false, throwNext: false, synchronous: false};
 const display = {
  isPreviewPending: id => pending.has(id), getPreviewPending: id => pending.get(id) || null,
  isSuppressed: () => false, getPreviewTranslation: () => null,
  markPreviewPending: data => {const token = "pending-" + ++sequence; pending.set(data.messageId, {...data, token}); return token;},
  releasePreviewPending: (id, token) => {if (pending.get(id)?.token !== token) return false; pending.delete(id); return true;},
  commitPreviewResult: value => {commits.push(value); return Promise.resolve();}
 };
 const plugin = {
  ensureReceivedDisplayRuntime: () => display, shouldAutoTranslateReplyPreview: () => true,
  isTranslationEnabled: () => state.enabled, isOwnMessage: () => false,
  createReplyPreviewSignature: (message, channel, content) => channel + ":" + content,
  getCachedReceivedTranslation: message => cache.get(message.id) || null,
  createReplyPreviewTranslationData: (message, channel, value) => ({signature: channel + ":" + message.content, translatedContent: value.translatedContent}),
  ensureHistoricalJobRegistry: () => ({listQueues: () => state.historicalBusy ? [{runningPromise: Promise.resolve(), jobs: []}] : []}),
  ensureLiveTranslationQueue: () => ({getQueueLength: () => state.liveBusy ? 1 : 0, getLiveSlotActiveCount: () => 0, isBusyTranslating: () => false}),
  translateText: (text, place, callback) => {calls.push({text, callback}); if (state.throwNext) {state.throwNext = false; throw new Error("sync provider failure");} if (state.synchronous) callback("translated");}
 };
 const queue = createReplyPreviewQueue({getPlugin: () => plugin, messageTypes: {RECEIVED: "received"}, isRuntimeActive: () => state.runtimeActive,
  setTimeout: callback => {const id = ++timerId; timers.set(id, callback); return id;}, clearTimeout: id => timers.delete(id)});
 const enqueue = id => {const message = {id, content: id}; queue.queueReplyPreviewTranslation(message, "c1"); return message;};
 const tick = () => {const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback();};
 return {queue, calls, commits, pending, cache, timers, state, display, enqueue, tick, plugin};
}

test("reply preview admits only one automatic request until its predecessor settles", () => {
 const h = createBoundedHarness();
 h.enqueue("first"); h.enqueue("second");
 assert.equal(h.calls.length, 1, "a second distinct preview waits instead of creating parallel provider load");
 h.calls[0].callback("first translation");
 assert.equal(h.calls.length, 2);
 h.calls[1].callback("second translation");
 assert.equal(h.commits.length, 2);
 assert.equal(h.pending.size, 0);
 assert.equal(h.timers.size, 0);
});

test("history and live work defer preview dispatch with one timer and reuse a cache arriving meanwhile", () => {
 const h = createBoundedHarness(); h.state.historicalBusy = true;
 h.enqueue("cached-later"); h.enqueue("deferred");
 assert.equal(h.calls.length, 0, "history gets priority");
 assert.equal(h.timers.size, 1, "one shared retry tick, not one per preview");
 h.cache.set("cached-later", {translatedContent: "already translated"});
 h.tick();
 assert.equal(h.calls.length, 0);
 assert.equal(h.commits.length, 1);
 h.state.historicalBusy = false; h.state.liveBusy = true; h.tick();
 assert.equal(h.calls.length, 0, "live work also gets priority");
 h.state.liveBusy = false; h.tick();
 assert.equal(h.calls.length, 1);
 assert.equal(h.calls[0].text, "deferred");
 h.calls[0].callback("done");
 assert.equal(h.timers.size, 0);
 assert.equal(h.pending.size, 0);
});

test("stop cancels waiting work but holds the in-flight slot through restart and ignores its late callback", () => {
 const h = createBoundedHarness(); h.enqueue("in-flight"); h.enqueue("old-waiting");
 h.queue.stop();
 assert.equal(h.pending.size, 0);
 assert.equal(h.timers.size, 0);
 h.queue.start(); h.enqueue("new-generation");
 assert.equal(h.calls.length, 1, "restart never bypasses the old physical request");
 h.calls[0].callback("stale");
 assert.equal(h.commits.length, 0);
 assert.equal(h.calls.length, 2);
 assert.equal(h.calls[1].text, "new-generation");
 h.calls[0].callback("duplicate stale");
 assert.equal(h.pending.size, 1);
 h.calls[1].callback("fresh");
 assert.equal(h.commits.length, 1);
 assert.equal(h.pending.size, 0);
});

test("waiting previews recheck source, deletion, channel setting, and pending ownership before paying", () => {
 for (const invalidation of ["source", "deleted", "disabled", "superseded"]) {
  const h = createBoundedHarness(); h.state.historicalBusy = true;
  const message = h.enqueue("stale");
  if (invalidation === "source") message.content = "edited";
  if (invalidation === "deleted") h.pending.delete("stale");
  if (invalidation === "disabled") h.state.enabled = false;
  if (invalidation === "superseded") h.display.markPreviewPending({messageId: "stale", channelId: "c1", signature: "new"});
  h.state.historicalBusy = false; h.tick();
  assert.equal(h.calls.length, 0, invalidation + " is not dispatched");
  assert.equal(h.timers.size, 0);
  assert.equal(h.pending.size, invalidation === "superseded" ? 1 : 0);
 }
});

test("waiting preview retention is bounded to 200 with no overflow pending leak or timer fanout", () => {
 const h = createBoundedHarness(); h.state.historicalBusy = true;
 for (let i = 0; i < 205; i++) h.enqueue("preview-" + i);
 assert.equal(h.pending.size, 200);
 assert.equal(h.pending.has("preview-204"), false);
 assert.equal(h.timers.size, 1);
 h.queue.stop();
 assert.equal(h.pending.size, 0);
 assert.equal(h.timers.size, 0);
 h.state.historicalBusy = false; h.tick();
 assert.equal(h.calls.length, 0);
});

test("synchronous provider failure and duplicate callbacks release exactly their own slot without wedging the queue", () => {
 const h = createBoundedHarness(); h.state.historicalBusy = true;
 h.enqueue("throws"); h.enqueue("sync"); h.enqueue("async");
 h.state.historicalBusy = false; h.state.throwNext = true;
 assert.doesNotThrow(() => h.tick());
 assert.equal(h.calls.length, 2);
 h.calls[1].callback("once"); h.calls[1].callback("duplicate");
 assert.equal(h.calls.length, 3);
 assert.equal(h.pending.size, 1);
 h.calls[2].callback("last");
 assert.equal(h.commits.length, 2);
 assert.equal(h.pending.size, 0);
 h.state.synchronous = true; h.enqueue("synchronous-completion");
 assert.equal(h.pending.size, 0);
 assert.equal(h.commits.length, 3);
 assert.equal(h.timers.size, 0);
});

test("a cleared pre-stop timer cannot overwrite the restarted queue timer", () => {
 const h = createBoundedHarness(); h.state.historicalBusy = true; h.enqueue("old");
 const oldTick = [...h.timers.values()][0];
 h.queue.stop(); h.queue.start(); h.enqueue("new");
 assert.equal(h.timers.size, 1);
 const currentTick = [...h.timers.values()][0];
 oldTick();
 assert.equal(h.timers.size, 1, "late old timer must not create another live timer");
 assert.equal([...h.timers.values()][0], currentTick);
 h.queue.stop(); assert.equal(h.timers.size, 0);
});

test("real translateText pipeline dispatches no backup after a stopped preview primary returns failure", () => {
 const h = createBoundedHarness(), physical = [];
 const {createTranslationPipeline} = require("../../src/orchestrator/translation-pipeline");
 Object.assign(h.plugin, {
  beginTranslationTerminalRoute: () => "test-route", recordTranslationTerminalStage: () => {}, finishTranslationTerminalRoute: () => {},
  removeExceptions: text => [text, {}, true], addExceptions: text => text, getProtectionRuleSummary: () => ({}),
  getEffectivePrimaryEngine: () => "googleapi", getEffectiveBackupEngine: () => "deepl",
  ensureSettingsStore: () => ({getLanguage: id => ({id, name: id})}), getLanguageChoice: kind => kind === "input" ? "en" : "zh-CN",
  createAtomicSemanticRevisionContract: () => ({enabled: false}), checkForSpecialCase: () => null, getAiAutoTranslatePrompt: () => "",
  validTranslator: () => true, supportsAiAutoTranslateDecisionEngine: () => false,
  isSkipTranslationSignal: () => false, isTranslationLikelyInTargetLanguage: () => true, hasAllProtectionPlaceholders: () => true,
  googleApiTranslate: (data, callback) => physical.push({kind: "primary", callback}),
  deepLTranslate: (data, callback) => physical.push({kind: "backup", callback})
 });
 const pipeline = createTranslationPipeline({getPlugin: () => h.plugin, messageTypes: {RECEIVED: "received", SENT: "sent"}, languageTypes: {INPUT: "input", OUTPUT: "output"},
  BDFDB: {TimeUtils: {timeout: () => 1, clear: () => {}, interval: () => 1}, LibraryStores: {SelectedChannelStore: {getChannelId: () => "c1"}}}});
 h.plugin.translateText = pipeline.translateText;
 h.enqueue("old-primary"); assert.equal(physical.length, 1, "real primary dispatch was reached");
 h.queue.stop();
 physical[0].callback("");
 assert.equal(physical.length, 1, "stopped preview must not initiate backup or compatibility work");
 assert.equal(h.commits.length, 0);
 h.queue.start(); h.enqueue("fresh");
 assert.equal(physical.length, 2, "settled old request releases its slot for the new generation");
 assert.equal(physical[1].kind, "primary"); physical[1].callback("translated fresh");
 assert.equal(h.commits.length, 1); assert.equal(h.pending.size, 0);
});
