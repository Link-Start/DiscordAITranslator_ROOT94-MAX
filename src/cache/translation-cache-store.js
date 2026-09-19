// Owns the persisted translation cache: the message-id keyed record of what a paid
// translation produced, plus the record of which messages a policy already decided not
// to translate. Before this module the cache object and its debounced save timer lived
// in the plugin factory closure, where any of the 9000 surrounding lines could rewrite
// an entry and silently invalidate a user's paid cache.
//
// Almost every rule below exists to protect that paid cache rather than to be tidy:
// the signature digest shrinks the file without invalidating what is already on disk,
// the skip whitelist keeps free decisions from evicting paid ones, and the entry bound
// keeps the file from growing without limit. Treat them as behaviour, not as knobs.
//
// The store deliberately does not know translation policy or display formatting. The
// cached-translation lookup still needs both - it re-validates an old entry against the
// current guards before handing it back - so both arrive as injected callbacks instead
// of being reimplemented here. See the note above getCachedTranslation.
//
// A store instance is per plugin instance, but its contents outlive a restart because
// they are loaded from and saved back to disk.

const {DEFAULT_TRANSLATION_CACHE_CAPACITY, normalizeTranslationCacheCapacity} = require("../settings/translation-cache-capacity");
// Compatibility export and default for the separately bounded experimental partition.
const MAX_TRANSLATION_CACHE_ENTRIES = DEFAULT_TRANSLATION_CACHE_CAPACITY;
// Bumped whenever the skip rules change meaning. A cached skip decision written under
// an older policy is not evidence about the current policy, so it is discarded on read
// rather than trusted.
const RECEIVED_SKIP_CACHE_POLICY_VERSION = 4;
// A burst of commits writes many entries in a row; one save at the end of the burst is
// enough and keeps the plugin off the disk during a batch translation.
const TRANSLATION_CACHE_SAVE_DEBOUNCE_MS = 300;
// Only decisions that actually saved a paid request may occupy a cache slot.
// symbol_only and link_only are recomputed locally for free before any request, so
// persisting them would evict real translations to store something free.
const PERSISTED_RECEIVED_SKIP_REASONS = Object.freeze(["same_language", "too_similar", "ai_skip_signal", "source_filter"]);
// Marks an entry whose signature is a digest. Entries written before digests existed
// carry the raw signature and have no prefix; that is how they stay matchable.
const SIGNATURE_DIGEST_PREFIX = "h1:";

function createTranslationCacheStore({
	now = Date.now,
	setTimeout,
	clearTimeout,
	// Persistence. loadCache returns whatever is on disk, including garbage.
	loadCache = () => null,
	saveCache = () => {},
	getCapacity = () => DEFAULT_TRANSLATION_CACHE_CAPACITY,
	// Message shape helpers owned by the received-translation runtime.
	extractOriginalContentData = () => ({}),
	createSignature = () => "",
	normalizeStoredTranslation = translation => translation,
	getTranslationPolicyVersion = () => null,
	extractLegacyDisplayedParts = () => ({}),
	// Policy and display seams. A cache lookup has no business deciding any of these,
	// but the lookup it replaces did, so they are injected rather than reimplemented.
	refreshTranslationDisplay = translation => translation,
	isTranslationResultTooSimilar = () => false,
	shouldSkipBeforeRequest = () => false,
	shouldKeepAutoTranslatedResult = () => true,
	getSkipPreviewText = text => text == null ? "" : String(text)
	,getSemanticCacheContext = () => null
	,assessSemanticCacheEntry = () => ({read: false, reason: "semantic-version-mismatch"})
} = {}) {
	let cache = {};
	let saveTimer = null;
	let dirty = false, mutationRevision = 0, timerGeneration = 0, saving = false;
	let evictedCount = 0;

	// The raw signature embeds the whole request configuration, so storing it verbatim
	// made it the majority of the persisted cache file. Every use is an equality check,
	// so a compact FNV-1a digest carries the same information at a fraction of the size.
	function hashSignature(signature) {
		const text = String(signature == null ? "" : signature);
		let hash = 0x811c9dc5;
		for (let index = 0; index < text.length; index++) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return `${SIGNATURE_DIGEST_PREFIX}${hash.toString(36)}:${text.length.toString(36)}`;
	}

	function matchesSignature(entry, signature) {
		if (!entry || entry.signature == null) return false;
		// Entries written before digests existed keep matching on their raw value, so
		// shipping the digest did not throw away anyone's existing paid cache.
		if (String(entry.signature).indexOf(SIGNATURE_DIGEST_PREFIX) !== 0) return entry.signature == signature;
		return entry.signature == hashSignature(signature);
	}

	// The timer is only a scheduling handle, not evidence that the latest paid result
	// reached disk. Detach first so a late/repeated host callback cannot save again.
	function detachSaveTimer() {
		const previous = saveTimer;
		saveTimer = null;
		timerGeneration++;
		if (previous != null) {try {clearTimeout(previous);} catch {}}
	}

	function saveDirtyCache() {
		if (!dirty || saving) return false;
		const writtenRevision = mutationRevision;
		saving = true;
		try {
			// The established BDFDB persistence port is synchronous. A throw retains
			// dirty state for the next mutation, explicit flush, reload, or clean stop.
			saveCache(cache);
			if (mutationRevision === writtenRevision) dirty = false;
			return true;
		}
		catch {return false;}
		finally {saving = false;}
	}

	function scheduleSave() {
		dirty = true;
		mutationRevision++;
		detachSaveTimer();
		const generation = timerGeneration;
		try {
			saveTimer = setTimeout(() => {
				if (generation !== timerGeneration) return;
				saveTimer = null;
				timerGeneration++;
				saveDirtyCache();
			}, TRANSLATION_CACHE_SAVE_DEBOUNCE_MS);
		}
		catch {saveTimer = null; timerGeneration++;}
	}

	function cancelPendingSave() {
		detachSaveTimer();
		// Explicit abandonment is different from a failed save or a clean stop.
		dirty = false;
		mutationRevision++;
	}

	function flushPendingSave() {
		detachSaveTimer();
		return saveDirtyCache();
	}

	// Runs after the insert, so the entry just written is the newest and survives.
	function evictOldestBeyondLimit() {
		const cacheKeys = Object.keys(cache);
		const capacity = normalizeTranslationCacheCapacity(getCapacity());
		if (cacheKeys.length <= capacity) return 0;
		const evictedKeys = cacheKeys
			.sort((keyA, keyB) => (Number(cache[keyA]?.cachedAt) || 0) - (Number(cache[keyB]?.cachedAt) || 0))
			.slice(0, cacheKeys.length - capacity);
		for (const key of evictedKeys) delete cache[key];
		evictedCount += evictedKeys.length;
		return evictedKeys.length;
	}

	function applyCapacityLimit() {
		const removed = evictOldestBeyondLimit();
		if (removed) scheduleSave();
		return removed;
	}

	// Unconditional: the callers below have already proven the entry exists.
	function dropEntry(messageId) {
		delete cache[messageId];
		scheduleSave();
	}

	// Returns a usable translation for this message, or null. A hit is not just a
	// signature match: an entry written under older guards is re-validated against the
	// current ones and dropped if it would no longer be produced today, which is why the
	// policy and display callbacks are injected. Everything between the signature check
	// and the write-back is caller-owned logic passing through.
	function getCachedTranslation(message, channelId, originalContentData = null) {
		if (!message || !cache[message.id]) return null;
		const sourceData = originalContentData || extractOriginalContentData(message);
		const signature = createSignature(message, channelId, sourceData);
		// Paid dual-read compatibility never moves an existing translation to another channel.
		const storedTranslation = cache[message.id].translation;
		if (storedTranslation && storedTranslation.channelId != null && String(storedTranslation.channelId) !== String(channelId)) return null;
		// Only policy-sensitive results need this check; ordinary paid translations
		// retain their existing cache identity. A miss leaves the old record intact.
		const policyVersion = getTranslationPolicyVersion(storedTranslation);
		if (policyVersion != null && cache[message.id].policyVersion !== policyVersion) return null;
		let migrateSignature = false;
		if (!matchesSignature(cache[message.id], signature)) {
			const current = getSemanticCacheContext(sourceData, channelId), semantic = cache[message.id].semantic;
			migrateSignature = !!(current && current.previousSignature && matchesSignature(cache[message.id], current.previousSignature));
			if (!migrateSignature && (!current || !semantic || !assessSemanticCacheEntry(Object.assign({kind: "translation"}, semantic), current).read)) return null;
		}
		if (cache[message.id].skipped) return null;
		let cachedTranslation = Object.assign({signature, channelId}, cache[message.id].translation);
		const beforeSerialized = JSON.stringify(cachedTranslation || {});
		cachedTranslation = normalizeStoredTranslation(cachedTranslation);
		if (!cachedTranslation.originalContent && sourceData && sourceData.content) cachedTranslation.originalContent = String(sourceData.content);
		if (!cachedTranslation.translatedContent && cachedTranslation.content) cachedTranslation.translatedContent = extractLegacyDisplayedParts(cachedTranslation.content).translatedContent || cachedTranslation.content;
		// A valid translation can live entirely in an Embed; existing result guards below
		// still enforce useful and complete output. This is only an empty-container check.
		if (!cachedTranslation.translatedContent && !Object.keys(cachedTranslation.embeds || {}).length) return null;
		if ((sourceData && sourceData.content || "").trim() && !String(cachedTranslation.originalContent || "").trim()) return null;
		cachedTranslation = refreshTranslationDisplay(cachedTranslation);
		if (isTranslationResultTooSimilar(cachedTranslation)) {
			dropEntry(message.id);
			return null;
		}
		// Re-check old cached auto-translations against the current same-language and
		// auto-translation guards so stale rewritten target-language results do not return.
		if (shouldSkipBeforeRequest(sourceData, channelId) || !shouldKeepAutoTranslatedResult(cachedTranslation, channelId)) {
			dropEntry(message.id);
			return null;
		}
		// Upgrade legacy cache entries in-place when the live Discord message still provides
		// the original content. This prevents old cached translations from coming back as
		// plain text without the original block.
		if (migrateSignature || JSON.stringify(cachedTranslation || {}) != beforeSerialized) {
			const upgradedTranslation = Object.assign({}, cachedTranslation);
			delete upgradedTranslation.signature;
			cache[message.id].translation = upgradedTranslation;
			cache[message.id].signature = hashSignature(signature);
			cache[message.id].cachedAt = cache[message.id].cachedAt || now();
			scheduleSave();
		}
		return cachedTranslation;
	}

	function getCachedSkipDecision(message, channelId, originalContentData = null) {
		if (!message || !cache[message.id]) return null;
		const sourceData = originalContentData || extractOriginalContentData(message);
		const signature = createSignature(message, channelId, sourceData);
		if (!matchesSignature(cache[message.id], signature)) return null;
		const skipped = cache[message.id].skipped;
		if (!skipped || !skipped.reason) return null;
		if (skipped.policyVersion !== RECEIVED_SKIP_CACHE_POLICY_VERSION) {
			dropEntry(message.id);
			return null;
		}
		return Object.assign({signature, channelId}, skipped);
	}

	function shouldPersistSkipDecision(reason) {
		return PERSISTED_RECEIVED_SKIP_REASONS.includes(reason);
	}

	function persistTranslation(messageId, signature, translation) {
		const storedTranslation = Object.assign({}, translation);
		// The signature already lives on the entry; the nested copy doubled its cost.
		delete storedTranslation.signature;
		cache[messageId] = {
			signature: hashSignature(signature),
			cachedAt: now(),
			translation: storedTranslation,
			semantic: translation && translation.semanticRevision ? {semanticRevision: translation.semanticRevision, planHash: translation.planHash || null, workloadKey: translation.semanticWorkloadKey || null, validatorVersion: translation.validatorVersion || null, outputSchemaVersion: translation.outputSchemaVersion || null} : null
		};
		const policyVersion = getTranslationPolicyVersion(storedTranslation);
		if (policyVersion != null) cache[messageId].policyVersion = policyVersion;
		evictOldestBeyondLimit();
		scheduleSave();
	}

	function persistSkipDecision(messageId, signature, reason, preview = "") {
		if (!messageId || !signature || !reason || !shouldPersistSkipDecision(reason)) return;
		cache[messageId] = {
			signature: hashSignature(signature),
			cachedAt: now(),
			skipped: {
				policyVersion: RECEIVED_SKIP_CACHE_POLICY_VERSION,
				reason,
				preview: getSkipPreviewText(preview)
			}
		};
		evictOldestBeyondLimit();
		scheduleSave();
	}

	function clear(messageId) {
		if (!messageId || !cache[messageId]) return;
		dropEntry(messageId);
	}

	function clearAll() {
		const count = Object.keys(cache).length;
		if (!count) return 0;
		cache = {};
		scheduleSave();
		return count;
	}

	// Adopts whatever is on disk. Only the container is validated: a settings reload must
	// not discard the whole cache because one entry looks odd.
	function loadPersisted() {
		// A refresh must not replace unsaved translations (or resurrect removals).
		// After a successful synchronous flush, clean reload still adopts disk.
		if (dirty) flushPendingSave();
		if (dirty || saving) return cache;
		const readRevision = mutationRevision;
		const loaded = loadCache();
		// A synchronous load port can reenter and mutate the owner before returning.
		if (dirty || saving || mutationRevision !== readRevision) return cache;
		cache = loaded && typeof loaded == "object" && !Array.isArray(loaded) ? loaded : {};
		applyCapacityLimit();
		return cache;
	}

	return Object.freeze({
		getCachedTranslation,
		getCachedSkipDecision,
		persistTranslation,
		persistSkipDecision,
		shouldPersistSkipDecision,
		clear,
		clearAll,
		applyCapacityLimit,
		getCapacity: () => normalizeTranslationCacheCapacity(getCapacity()),
		getEntryCount: () => Object.keys(cache).length,
		getEvictedCount: () => evictedCount,
		hasEntry(messageId) {
			return !!(messageId && cache[messageId]);
		},
		getEntry(messageId) {
			return messageId && cache[messageId] || null;
		},
		scheduleSave,
		flushPendingSave,
		// Retained for owners that intentionally abandon a pending write rather than
		// performing the clean-stop flush.
		cancelPendingSave,
		loadPersisted,
		hashSignature,
		matchesSignature,
		// Writes an entry with a raw, undigested signature, the shape a pre-digest install
		// has on disk. Only the compatibility tests need it.
		seedRawEntryForTest(messageId, signature, translation) {
			cache[messageId] = {signature, cachedAt: now(), translation: Object.assign({}, translation)};
		}
	});
}

// Offline W4 storage only; the runtime does not create this partition yet. Callers
// supply complete identity snapshots and commit-approved D results. Hash fields
// describe semantic configuration as SHA-256, never raw provider credentials.
const WHOLE_MARKER_IDENTITY_FIELDS = Object.freeze(["messageId", "channelId", "source", "inputLanguageId", "targetLanguageId", "providerHash", "promptHash", "protectionHash", "policyHash", "planHash", "plannerVersion", "wireVersion", "validatorVersion", "reassemblyVersion"]);
function createWholeMarkerTranslationCacheStore({now = Date.now, setTimeout, clearTimeout, loadCache = () => null, saveCache = () => {}} = {}) {
 let writable = false, loading = false;
 const clone = value => JSON.parse(JSON.stringify(value));
 const identityKey = identity => {
  if (!identity || typeof identity !== "object" || Object.keys(identity).length !== WHOLE_MARKER_IDENTITY_FIELDS.length) return null;
  if (WHOLE_MARKER_IDENTITY_FIELDS.some(key => typeof identity[key] !== "string" || !identity[key] || key.endsWith("Hash") && !/^[a-f0-9]{64}$/i.test(identity[key]))) return null;
  return JSON.stringify(WHOLE_MARKER_IDENTITY_FIELDS.map(key => identity[key]));
 };
 const validTranslation = (translation, identity) => translation && translation.wireFamily === "whole-marker" && translation.cacheWrite !== false && typeof translation.translatedContent === "string" && !!translation.translatedContent.trim() && translation.originalContent === identity.source && translation.channelId === identity.channelId;
 // Share the paid-cache debounce, retry, reload and bound. Its short signature is
 // not a D identity: reads below compare every identity field without a bypass.
 const store = createTranslationCacheStore({now, setTimeout, clearTimeout,
  loadCache: () => {
   loading = true;
   let value; try {value = loadCache();} finally {loading = false;}
   writable = value == null || !!(value && value.version === 1 && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) && Object.values(value.entries).every(entry => entry && typeof entry === "object" && !Array.isArray(entry)));
   return writable && value ? clone(value.entries) : {};
  },
  saveCache: entries => {
   if (!writable) throw new Error("D cache envelope is not writable");
   saveCache({version: 1, entries: clone(entries)});
  }
 });
 return Object.freeze({
  getCachedTranslation(identity) {
   const key = identityKey(identity);
   if (!key || !writable) return null;
   const entry = store.getEntry(`d:${identity.messageId}`), value = entry && entry.translation;
   if (!value || value.cacheIdentity !== key || !validTranslation(value, identity)) return null;
   const result = clone(value); delete result.cacheIdentity;
   return result;
  },
  persistTranslation(identity, translation) {
   const key = identityKey(identity);
   if (!key || !writable || loading || !validTranslation(translation, identity)) return false;
   let value; try {value = clone(translation);} catch {return false;}
   value.cacheIdentity = key;
   store.persistTranslation(`d:${identity.messageId}`, "whole-marker-cache-v1", value);
   return true;
  },
  clear(messageId) {if (writable && !loading && typeof messageId === "string") store.clear(`d:${messageId}`);},
  clearAll() {return writable && !loading ? store.clearAll() : 0;},
  loadPersisted() {store.loadPersisted(); return writable;},
  flushPendingSave: store.flushPendingSave,
  cancelPendingSave: store.cancelPendingSave,
  getEntryCount: store.getEntryCount
 });
}

module.exports = {
	MAX_TRANSLATION_CACHE_ENTRIES,
	RECEIVED_SKIP_CACHE_POLICY_VERSION,
	TRANSLATION_CACHE_SAVE_DEBOUNCE_MS,
	PERSISTED_RECEIVED_SKIP_REASONS,
	SIGNATURE_DIGEST_PREFIX,
	createTranslationCacheStore,
	createWholeMarkerTranslationCacheStore
};
