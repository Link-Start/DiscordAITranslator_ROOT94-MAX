const {createTranslationCacheStore, createWholeMarkerTranslationCacheStore} = require("./translation-cache-store");
const {assessLegacyCacheEntry, SEMANTIC_REVISION} = require("../planner/translation-semantic-revision");
const {INLINE_RANGES_VERSION} = require("../planner/translation-inline-ranges");
const {SOFT_VALIDATION_VERSION} = require("../planner/translation-soft-validation");
const {planReceivedMarkdown} = require("../planner/received-markdown-lossless-planner");
const {SOURCE_CONTEXT_VERSION, buildMessageSourceContext} = require("../planner/translation-source-context");

function hasMessageContext(sourceData, target) {
	const parts = [sourceData.content || ""];
	for (const embed of sourceData.embeds || []) {
		parts.push(embed.title || "", embed.description || "", embed.footerText || "");
		for (const field of embed.fields || []) parts.push(field.name || "", field.value || "");
	}
	return parts.some(text => {
		if (!/[^\x00-\x7F]/.test(text)) return false;
		const plan = planReceivedMarkdown(text, {targetLanguageId: target});
		// Migration follows changed planning/acceptance, even if the context itself
		// exceeds its wire budget. Cover every script, not just Latin names.
		return plan.nodes.some(node => ["translate", "uncertain"].includes(node.classification) && /\p{L}/u.test(node.raw)) && !!buildMessageSourceContext(plan, Infinity);
	});
}

function createReceivedCacheSignature(plugin, message, channelId, originalContentData = null, includeInlineFormatVersion = true) {
	const sourceData = originalContentData || plugin.extractOriginalContentData(message), configuration = plugin.getReceivedTranslationConfigurationData(channelId);
	if (configuration.providerSemanticRevision === SEMANTIC_REVISION && hasMessageContext(sourceData, configuration.output)) configuration.sourceContextVersion = SOURCE_CONTEXT_VERSION;
	// A source-signature hit bypasses semantic dual-read checks. Mark formatting
	// candidates cheaply so old fragmented translations must pass that check.
	// On a miss the planner below resolves false positives (e.g. code containing *).
	if (includeInlineFormatVersion && configuration.providerSemanticRevision === SEMANTIC_REVISION && /[*_]|~~|\|\||\]\(/.test(String(sourceData.content || "") + (sourceData.embeds && sourceData.embeds.length ? JSON.stringify(sourceData.embeds) : ""))) configuration.inlineFormatVersion = INLINE_RANGES_VERSION;
	return JSON.stringify(Object.assign({}, configuration, {content: sourceData.content || "", embeds: sourceData.embeds || []}));
}

// Owns the plugin/BDFDB adapter for the translation cache. The cache store keeps
// persistence, debounce and compatibility behaviour; this wiring maps those ports to
// the plugin's established helpers without leaving BDFDB keys in the composition root.
function createPluginTranslationCacheStore({
	plugin,
	BDFDB,
	now = Date.now,
	createStore = createTranslationCacheStore
}) {
	const store = createStore({
		now,
		getCapacity: () => plugin.settings && plugin.settings.general && plugin.settings.general.translationCacheLimit,
		setTimeout: (callback, delay) => BDFDB.TimeUtils.timeout(callback, delay),
		clearTimeout: timer => BDFDB.TimeUtils.clear(timer),
		loadCache: () => BDFDB.DataUtils.load(plugin, "translationCache"),
		saveCache: cache => BDFDB.DataUtils.save(cache, plugin, "translationCache"),
		extractOriginalContentData: message => plugin.extractOriginalContentData(message),
		createSignature: (message, channelId, sourceData) => plugin.createReceivedTranslationSignature(message, channelId, sourceData),
		normalizeStoredTranslation: translation => plugin.normalizeStoredTranslationData(translation),
		getTranslationPolicyVersion: translation => Number(translation && translation.keptSegmentCount) > 0 ? SOFT_VALIDATION_VERSION : null,
		extractLegacyDisplayedParts: content => plugin.extractLegacyDisplayedTranslationParts(content),
		refreshTranslationDisplay: translation => plugin.refreshTranslationDisplay(translation),
		isTranslationResultTooSimilar: translation => plugin.isTranslationResultTooSimilar(translation),
		shouldSkipBeforeRequest: (sourceData, channelId) => plugin.shouldSkipReceivedTranslationBeforeRequest(sourceData, channelId),
		shouldKeepAutoTranslatedResult: (translation, channelId) => plugin.shouldKeepAutoTranslatedResult(translation, channelId),
		getSkipPreviewText: text => plugin.getLoadedAutoTranslationPreviewText(text),
		getSemanticCacheContext: (sourceData, channelId) => {
			const input = plugin.ensureSettingsStore().getLanguage(plugin.getLanguageChoice("input", "received", channelId)) || {id: "auto"}, output = plugin.ensureSettingsStore().getLanguage(plugin.getLanguageChoice("output", "received", channelId)) || {id: "zh-CN"};
			// Mixed-language results must match the new source signature. Even an old
			// matching plan hash may have been accepted under the former keep policy.
			if (hasMessageContext(sourceData, output.id)) return null;
			const request = plugin.createAtomicSemanticRevisionContract(plugin.buildTranslationRequestText(sourceData), {place: "received", channelId, inputLanguageId: input.id || "auto", targetLanguageId: output.id || "zh-CN", fieldPath: "body"});
			if (!request.enabled) return null;
			// Legacy fallback entries may have no semantic metadata. They remain paid
			// hits when only the new signature field differs and no format was merged.
			return {planHash: plugin.getAtomicSemanticPlanHash(request), workloadKey: request.workload.key, previousSignature: request.plan && request.plan.inlineRanges && request.plan.inlineRanges.formatCount ? null : createReceivedCacheSignature(plugin, null, channelId, sourceData, false)};
		},
		assessSemanticCacheEntry: assessLegacyCacheEntry
	});
 let wholeMarker = null;
 const getWholeMarkerStore = () => {
  if (!wholeMarker) {const created = createPluginWholeMarkerTranslationCacheStore({plugin, BDFDB, now}); created.loadPersisted(); wholeMarker = created;}
  return wholeMarker;
 };
 // Keep typed reads/writes/count unchanged. Only lifecycle operations fan out.
 return Object.freeze(Object.assign({}, store, {
  getWholeMarkerStore,
  clear(messageId) {const result = store.clear(messageId); try {if (wholeMarker) wholeMarker.clear(messageId);} catch {} return result;},
  clearAll() {const count = store.clearAll(); try {return count + getWholeMarkerStore().clearAll();} catch {return count;}},
  loadPersisted() {const result = store.loadPersisted(); try {if (wholeMarker) wholeMarker.loadPersisted();} catch {} return result;},
  flushPendingSave() {const result = store.flushPendingSave(); let dSaved = false; try {if (wholeMarker) dSaved = wholeMarker.flushPendingSave();} catch {} return result || dSaved;},
  cancelPendingSave() {store.cancelPendingSave(); try {if (wholeMarker) wholeMarker.cancelPendingSave();} catch {}}
 }));
}

// Created only by explicit W4 cache admission or the existing clear-cache action.
function createPluginWholeMarkerTranslationCacheStore({plugin, BDFDB, now = Date.now}) {
 return createWholeMarkerTranslationCacheStore({
  now,
  setTimeout: (callback, delay) => BDFDB.TimeUtils.timeout(callback, delay),
  clearTimeout: timer => BDFDB.TimeUtils.clear(timer),
  loadCache: () => {const value = BDFDB.DataUtils.load(plugin, "translationCacheWholeMarker"); return value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length ? null : value;},
  saveCache: cache => BDFDB.DataUtils.save(cache, plugin, "translationCacheWholeMarker")
 });
}

module.exports = {createReceivedCacheSignature, createPluginTranslationCacheStore, createPluginWholeMarkerTranslationCacheStore};
