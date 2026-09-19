const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {classifyHistoricalBatchValidation} = require("../../src/orchestrator/historical-validation-classifier");
const {createSemanticRequest, validateSemanticResponse, getSemanticLocalState} = require("../../src/planner/translation-semantic-runtime");
const {createReceivedTranslationRuntime} = require("../../src/received/received-translation-runtime");

const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const CHANNEL = "kept-cache-channel";
const ENGINE = "custom-kept-cache";
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const sourceOf = message => ({content: message.content, embeds: []});
const messageOf = (content = "Atomic Gains") => ({id: "kept-cache-message", channel_id: CHANNEL, content, embeds: [], author: {id: "other-user"}});
const likelyTarget = value => /[\p{Script=Han}]/u.test(String(value || ""));

test("old kept results miss once while current kept results and ordinary paid translations remain cached", () => {
	const writer = createHarness();
	let reader;
	try {
		for (const [id, content, translated, kept] of [["old-kept", "Do not publish this.", "Do not publish this.", 1], ["current-kept", "Atomic Gains", "Atomic Gains", 1], ["ordinary", "Please wait.", "请稍候。", 0]]) {
			const message = {...messageOf(content), id};
			const source = sourceOf(message), signature = writer.plugin.createReceivedTranslationSignature(message, CHANNEL, source);
			const translation = writer.plugin.createStoredReceivedTranslationData(message, CHANNEL, source, signature, translated, {id: "en"}, {id: "zh-CN"}, true);
			if (kept) Object.assign(translation, {keptSegmentCount: kept, keptReasons: {"wrong-language": kept}});
			writer.plugin.persistTranslationCacheEntry(id, signature, translation);
		}
		writer.plugin.ensureTranslationCacheStore().flushPendingSave();
		delete writer.disk.translationCache["old-kept"].policyVersion;
		reader = createHarness(writer.disk);
		assert.equal(reader.plugin.getCachedReceivedTranslation({...messageOf("Do not publish this."), id: "old-kept"}, CHANNEL), null);
		assert.ok(reader.plugin.getCachedReceivedTranslation({...messageOf("Atomic Gains"), id: "current-kept"}, CHANNEL));
		assert.ok(reader.plugin.getCachedReceivedTranslation({...messageOf("Please wait."), id: "ordinary"}, CHANNEL));
		assert.equal(reader.transportCalls(), 0, "cache lookup never sends a request itself");
	}
	finally {writer.close(); if (reader) reader.close();}
});

// The plugin, normalization, cache wiring/store and similarity policy are real. Only disk,
// timers and external transport are replaced. Persistence round-trips through JSON, so the
// next plugin instance cannot share an in-memory translation object with its predecessor.
function createHarness(disk = {}) {
	let timerId = 0, transportCalls = 0;
	const timers = new Map();
	const plugin = createPluginInstance({
		pluginPath: BUNDLE,
		settings: {
			engines: {translator: ENGINE, backup: "----", customProviders: [{id: ENGINE, name: "Fixture"}]},
			filters: {useLocalLanguagePrecheck: false, skipMixedReceivedMessages: false, minimumAutoTranslateLength: 1},
			choices: {received: {input: "en", output: "zh-CN"}}
		},
		bdfdb: {
			TimeUtils: {timeout: callback => {timers.set(++timerId, callback); return timerId;}, clear: id => timers.delete(id)},
			DataUtils: {load: (_owner, key) => clone(disk[key]), save: (value, _owner, key) => {disk[key] = clone(value);}},
			LibraryRequires: {request: () => {transportCalls++; throw new Error("unexpected provider request on cache path");}}
		}
	});
	plugin.ensureSettingsStore().replaceAuthKeys({[ENGINE]: {key: "fixture-key", endpoint: "https://kept-cache.invalid/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat"}});
	plugin.ensureTranslationCacheStore().loadPersisted();
	return {plugin, disk, transportCalls: () => transportCalls, close() {plugin.ensureTranslationCacheStore().cancelPendingSave(); assert.equal(timers.size, 0);}};
}

function createAcceptedTranslation(plugin, message, kind) {
	const source = sourceOf(message), signature = plugin.createReceivedTranslationSignature(message, CHANNEL, source);
	const stored = text => plugin.createStoredReceivedTranslationData(message, CHANNEL, source, signature, text, {id: "en"}, {id: "zh-CN"}, true);
	if (kind === "legacy-kept") {
		const classified = classifyHistoricalBatchValidation({
			prepared: {message, originalContentData: source, signature, protectedText: message.content, exceptions: [], input: {id: "en"}, output: {id: "zh-CN"}},
			rawTranslation: message.content, channelId: CHANNEL,
			isSkipSignal: value => plugin.isSkipTranslationSignal(value),
			hasPlaceholders: (value, exceptions) => plugin.hasAllProtectionPlaceholders(value, exceptions),
			addExceptions: (value, exceptions) => plugin.addExceptions(value, exceptions),
			likelyTarget,
			createStored: (...args) => plugin.createStoredReceivedTranslationData(...args),
			shouldKeep: (value, channelId) => plugin.shouldKeepAutoTranslatedResult(value, channelId),
			tooSimilar: value => plugin.isTranslationResultTooSimilar(value)
		});
		assert.equal(classified.outcome.ok, true);
		assert.equal(classified.outcome.translation.keptSegmentCount, 1);
		return classified.outcome.translation;
	}
	const request = createSemanticRequest({engineKey: ENGINE, source: message.content, inputLanguageId: "en", targetLanguageId: "zh-CN"});
	assert.equal(request.enabled, true);
	const rows = JSON.parse(request.wire).segments.map(segment => ({id: segment.id, translation: segment.text}));
	const outcome = validateSemanticResponse(request, {segments: rows}, {likelyTarget, similarity: (a, b) => plugin.getTextSimilarityScore(a, b)});
	assert.equal(outcome.ok, true);
	assert.ok(outcome.keptCount > 0);
	const result = Object.assign(stored(outcome.translation), {semanticRevision: request.semanticRevision, semanticWorkloadKey: request.workload.key, planHash: getSemanticLocalState(request).cachePlanHash, validatorVersion: request.workload.fields.validatorVersion, outputSchemaVersion: request.workload.fields.outputSchemaVersion});
	assert.equal(result.validatorVersion, "segment-validator-v2");
	assert.equal(result.keptSegmentCount, undefined, "typed production stores semantic metadata, not the ledger's kept count");
	return result;
}

for (const kind of ["legacy-kept", "semantic-kept"]) test(`2a ${kind} survives real cache write/read and a JSON-persisted plugin restart`, () => {
	const first = createHarness(), message = messageOf();
	let second;
	try {
		const translation = createAcceptedTranslation(first.plugin, message, kind);
		first.plugin.persistTranslationCacheEntry(message.id, translation.signature, translation);
		assert.equal(first.plugin.ensureTranslationCacheStore().flushPendingSave(), true);
		assert.equal(first.disk.translationCache[message.id].translation.translatedContent, message.content);
		const hit = first.plugin.getCachedReceivedTranslation(message, CHANNEL, sourceOf(message));
		assert.ok(hit, `${kind}: accepted source-preserving cache entry must not be deleted by a second similarity verdict`);
		assert.equal(hit.translatedContent, message.content);
		assert.equal(first.plugin.hasCachedTranslationEntry(message.id), true);
		second = createHarness(first.disk);
		const reloaded = second.plugin.getCachedReceivedTranslation(message, CHANNEL, sourceOf(message));
		assert.ok(reloaded);
		assert.equal(reloaded.translatedContent, message.content);
		assert.equal(first.transportCalls() + second.transportCalls(), 0);
	}
	finally {first.close(); if (second) second.close();}
});

for (const kind of ["legacy-kept", "semantic-kept"]) test(`2a ${kind} reloaded rows commit cached display without queueing provider work`, () => {
	const writer = createHarness(), message = messageOf();
	let reader;
	try {
		const accepted = createAcceptedTranslation(writer.plugin, message, kind);
		writer.plugin.persistTranslationCacheEntry(message.id, accepted.signature, accepted);
		writer.plugin.ensureTranslationCacheStore().flushPendingSave();
		reader = createHarness(writer.disk);
		const plugin = reader.plugin, views = new Map(), commits = [], queued = [];
		// Empty display state models a newly mounted row; only the client display boundary is
		// replaced. The production received pass decides whether cache lookup avoids queueing.
		plugin.ensureReceivedDisplayRuntime = () => ({getDisplayView: id => views.get(id), isSuppressed: () => false, hasSourceArchive: () => false});
		plugin.getActiveMessageTranslation = () => null;
		plugin.getReceivedDisplayRuntimeView = id => views.get(id);
		plugin.markAutoTranslationEligibleReplyPreviewMessage = () => {};
		plugin.createReceivedDisplayCommitResult = (item, channelId, result) => Object.assign({messageId: item.id, channelId}, result);
		plugin.commitReceivedDisplayResult = result => {commits.push(result); views.set(result.messageId, {translated: true, translation: result.translation}); return Promise.resolve();};
		plugin.applyReceivedDisplayViewToStream = (stream, view) => {stream.content = view.translation.translatedContent;};
		plugin.queueAutoTranslateMessage = (...args) => queued.push(args);
		const {receivedTranslationRuntime: runtime} = createReceivedTranslationRuntime();
		for (let mount = 0; mount < 2; mount++) {
			views.clear();
			const stream = {content: message.content}, context = {channelId: CHANNEL, expectedSignature: accepted.signature, originalContentData: sourceOf(message), isNewerThanBoundary: true, historicalLoad: false, skipAutoQueue: false};
			const outcome = runtime.resolveCheckMessageDisplay(plugin, stream, message, context);
			runtime.queueCheckMessageTranslation(plugin, message, {id: CHANNEL}, context, outcome);
			assert.equal(outcome.storeCommitted, true);
			assert.equal(stream.content, message.content);
		}
		assert.equal(commits.length, 2);
		assert.equal(queued.length, 0, "a cached mount must not schedule a new translation");
		assert.equal(reader.transportCalls(), 0);
	}
	finally {writer.close(); if (reader) reader.close();}
});

test("2a unmarked echoes, partial semantic markers and non-positive kept counts remain rejected", () => {
	const h = createHarness(), message = messageOf();
	try {
		const signature = h.plugin.createReceivedTranslationSignature(message, CHANNEL, sourceOf(message));
		const ordinary = h.plugin.createStoredReceivedTranslationData(message, CHANNEL, sourceOf(message), signature, message.content, {id: "en"}, {id: "zh-CN"}, true);
		for (const marker of [{}, {keptSegmentCount: 0}, {keptSegmentCount: -1}, {keptSegmentCount: "not-a-count"}, {semanticRevision: "s8b-p2-v1"}, {validatorVersion: "segment-validator-v2"}, {semanticRevision: "s8b-p2-v1", validatorVersion: "unverified"}]) {
			const value = Object.assign({}, ordinary, marker);
			assert.equal(h.plugin.getAutoTranslatedResultRejectReason(value, CHANNEL), "too_similar", JSON.stringify(marker));
			h.plugin.persistTranslationCacheEntry(message.id, signature, value);
			assert.equal(h.plugin.getCachedReceivedTranslation(message, CHANNEL, sourceOf(message)), null);
			assert.equal(h.plugin.hasCachedTranslationEntry(message.id), false);
		}
		// Keep the pre-existing stricter 0.90 final guard, not just the 0.92 echo guard.
		h.plugin.getTextSimilarityScore = () => 0.91;
		const nearEcho = Object.assign({}, ordinary, {translatedContent: "Atomic Gain"});
		assert.equal(h.plugin.isTranslationResultTooSimilar(nearEcho), false);
		assert.equal(h.plugin.getAutoTranslatedResultRejectReason(nearEcho, CHANNEL), "too_similar");
	}
	finally {h.close();}
});

for (const kind of ["legacy-kept", "semantic-kept"]) test(`2a ${kind} still obeys empty, same-language, source, precheck and identity gates`, () => {
	const h = createHarness(), message = messageOf(), p = h.plugin;
	try {
		const value = createAcceptedTranslation(p, message, kind);
		assert.equal(p.getAutoTranslatedResultRejectReason(Object.assign({}, value, {translatedContent: "", content: "", embeds: {}}), CHANNEL), "local_guard");
		p.shouldSkipSameLanguageReceivedMessages = () => true;
		assert.equal(p.getAutoTranslatedResultRejectReason(Object.assign({}, value, {input: {id: "zh-CN"}}), CHANNEL), "same_language");
		p.getReceivedAutoTranslateSourceLanguages = () => ["de"];
		assert.equal(p.getAutoTranslatedResultRejectReason(value, CHANNEL), "source_filter");
		p.getReceivedAutoTranslateSourceLanguages = () => [];
		p.persistTranslationCacheEntry(message.id, value.signature, value);
		p.shouldSkipReceivedTranslationBeforeRequest = () => true;
		assert.equal(p.getCachedReceivedTranslation(message, CHANNEL, sourceOf(message)), null, "precheck still evicts rejected input");
		assert.equal(p.hasCachedTranslationEntry(message.id), false);
		p.shouldSkipReceivedTranslationBeforeRequest = () => false;
		p.persistTranslationCacheEntry(message.id, value.signature, value);
		assert.equal(p.getCachedReceivedTranslation(Object.assign({}, message, {content: "Changed Gains"}), CHANNEL), null, "source signature/plan changes are not a cache hit");
		assert.equal(p.hasCachedTranslationEntry(message.id), true, "a signature miss keeps the existing store non-destructive behavior");
		assert.equal(p.getCachedReceivedTranslation(message, "different-channel", sourceOf(message)), null, "channel identity still isolates cache results");
		assert.equal(p.hasCachedTranslationEntry(message.id), true);
	}
	finally {h.close();}
});

test("2a a normal non-similar translation keeps its existing cache hit", () => {
	const h = createHarness(), message = messageOf("Please review the updated schedule before the meeting.");
	try {
		const p = h.plugin, signature = p.createReceivedTranslationSignature(message, CHANNEL, sourceOf(message));
		const translation = p.createStoredReceivedTranslationData(message, CHANNEL, sourceOf(message), signature, "请在会议前查看更新后的日程。", {id: "en"}, {id: "zh-CN"}, true);
		assert.equal(p.getAutoTranslatedResultRejectReason(translation, CHANNEL), null);
		p.persistTranslationCacheEntry(message.id, signature, translation);
		assert.equal(p.getCachedReceivedTranslation(message, CHANNEL, sourceOf(message)).translatedContent, translation.translatedContent);
	}
	finally {h.close();}
});
