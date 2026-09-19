// Shared by persistence and settings UI: invalid legacy values keep the old default.
const DEFAULT_TRANSLATION_CACHE_CAPACITY = 500;
const MIN_TRANSLATION_CACHE_CAPACITY = 100;
const MAX_TRANSLATION_CACHE_CAPACITY = 10000;

function parseTranslationCacheCapacity(value) {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const number = Number(value);
	return Number.isInteger(number) && number >= MIN_TRANSLATION_CACHE_CAPACITY && number <= MAX_TRANSLATION_CACHE_CAPACITY ? number : null;
}

function normalizeTranslationCacheCapacity(value) {
	return parseTranslationCacheCapacity(value) ?? DEFAULT_TRANSLATION_CACHE_CAPACITY;
}

module.exports = {DEFAULT_TRANSLATION_CACHE_CAPACITY, MIN_TRANSLATION_CACHE_CAPACITY, MAX_TRANSLATION_CACHE_CAPACITY, parseTranslationCacheCapacity, normalizeTranslationCacheCapacity};
