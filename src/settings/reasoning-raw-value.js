// A thinking strength is whatever value the provider actually accepts: an enum name
// ("high", "xhigh"), a token budget (12000, -1 for dynamic) or a plain switch (true).
// The plugin stores and sends it verbatim, so the type has to survive storage: a
// budget of 12000 and the string "12000" are different requests to different fields.
// Every map key, capability key and fingerprint segment therefore uses a tagged key,
// which is the only way "n:12000" and "s:12000" can coexist in one record.

const MAX_REASONING_RAW_LENGTH = 128;

function normalizeReasoningRawValue(raw) {
	if (typeof raw == "boolean") return raw;
	if (typeof raw == "number") return Number.isFinite(raw) ? raw : null;
	if (typeof raw != "string") return null;
	const trimmed = raw.trim().slice(0, MAX_REASONING_RAW_LENGTH);
	return trimmed ? trimmed : null;
}

function createReasoningRawKey(raw) {
	const value = normalizeReasoningRawValue(raw);
	if (value === null) return "";
	if (typeof value == "boolean") return `b:${value}`;
	if (typeof value == "number") return `n:${value}`;
	return `s:${value}`;
}

module.exports = {MAX_REASONING_RAW_LENGTH, normalizeReasoningRawValue, createReasoningRawKey};
