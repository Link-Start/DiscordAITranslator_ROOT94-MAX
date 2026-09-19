// Pure presentation policy for the custom-provider settings surface. It owns no
// plugin state and deliberately derives the three friendly strategies from the
// already-persisted per-model reasoning fields.

const CUSTOM_PROVIDER_MAIN_SLOTS = Object.freeze(["endpoint", "key", "model", "thinking", "strength", "status-actions"]);
const MAX_RAW_LENGTH = 128;

// The stored raw is projected, never folded: the strength label has to name the value
// that actually gets dispatched, so an unlisted or typed raw survives untouched.
// The label is the upstream value itself. Only the dynamic budget gets a word, and it
// carries its own number, so the control never names a value it does not send.
function formatThinkingRawLabel(raw) {
	if (raw === null || raw === undefined || raw === "") return "";
	if (raw === -1) return "dynamic (-1)";
	if (typeof raw == "boolean") return raw ? "true" : "false";
	return String(raw);
}

// Every raw carries a plain-language gloss on the menu's second line: the raw stays
// the label (it is what gets sent), the gloss says how strong that value is. Unknown
// raws get an honest "provider-specific" gloss instead of a guessed rank.
function thinkingRawGlossKey(raw) {
	if (raw === true) return "thinking_raw_gloss_on";
	if (raw === false) return "thinking_raw_gloss_off";
	const numeric = typeof raw == "number" ? raw : typeof raw == "string" && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
	if (numeric !== null) return numeric === -1 ? "thinking_raw_gloss_dynamic" : "thinking_raw_gloss_budget";
	const word = String(raw === null || raw === undefined ? "" : raw).trim().toLowerCase();
	return ["none", "minimal", "low", "medium", "high", "max", "xhigh", "auto"].includes(word) ? `thinking_raw_gloss_${word}` : "thinking_raw_gloss_unknown";
}

function normalizeRaw(value) {
	if (typeof value == "boolean") return value;
	if (typeof value == "number") return Number.isFinite(value) ? value : null;
	if (typeof value != "string") return null;
	const trimmed = value.trim().slice(0, MAX_RAW_LENGTH);
	return trimmed || null;
}

function normalizeStrategy(value) {
	return THINKING_STRATEGIES.includes(value) ? value : "auto";
}

// Capability sentences describe what the endpoint accepted for this model. Only they
// may carry the "manual draft not saved yet" prefix: the transient states above them
// (detecting, HTTP error, unknown API type, stale, benchmark advice) are already the
// one action the user should take, and wrapping them would only lengthen the line.
const CAPABILITY_STATUS_KEYS = Object.freeze([
	"custom_status_unknown_model",
	"custom_status_setting_sent_unconfirmed",
	"custom_status_thinking_off_confirmed",
	"custom_status_effort_reduced",
	"custom_status_thinking_on_confirmed",
	"custom_status_off_not_applied",
	"custom_status_on_not_applied",
	"custom_status_setting_rejected"
]);

function resolveCustomProviderStatus({
	detecting = false,
	error = false,
	stale = false,
	benchmarkWarning = false,
	validationOk = false,
	interfaceResolved = "",
	reasoning = {}
} = {}) {
	// A draft never renders as a green success: the value on screen is not saved yet.
	// Every choice is saved the moment it is made, so there is no draft state to caveat.
	const finish = (key, tone) => Object.freeze({key, tone, decorator: null});
	if (detecting) return finish("custom_status_detecting", "neutral");
	if (error) return finish("custom_status_error", "fail");
	// Without a resolved API type nothing below can be trusted, not even "provider default".
	if (!interfaceResolved) return finish("custom_status_interface_unknown", "fail");
	// Following the provider sends no reasoning field, so a reasoning-only staleness
	// (switching to follow invalidates the previous validation by itself) must not ask
	// for a re-test here.
	if (reasoning && reasoning.mode === "follow") return finish("custom_status_upstream", "neutral");
	// A locally known rejection outranks staleness and "not tested yet": sending the user
	// to re-validate a value the model is documented to refuse is a dead end. It is not
	// evidence either, so it never reaches the capability sentences below.
	if (reasoning && reasoning.availability === "unsupported") return finish("custom_status_invalid_strength", "warn");
	if (stale) return finish("custom_status_stale", "warn");
	if (benchmarkWarning) return finish("custom_status_benchmark_slower", "warn");
	const support = reasoning && reasoning.support || "pending";
	const evidence = reasoning && reasoning.evidence || "none";
	// A verdict this configuration already earned survives a restart and an upgrade, so
	// only the absence of any verdict falls back to "not tested".
	if (support === "pending" && !validationOk) return finish("custom_status_unknown_model", "warn");
	// Split by direction so the sentence always confirms what WAS sent before saying
	// it did not take effect. Off that provably kept thinking is an error with a named
	// culprit - the request said off, the response billed thinking, so a relay or the
	// provider substituted its own level - and reads red, not amber.
	if (evidence === "contradicted") {
		if (reasoning && reasoning.mode === "on") return finish("custom_status_on_not_applied", "warn");
		return finish("custom_status_off_not_applied", "fail");
	}
	// A rejected field only proves this endpoint refuses it; it says nothing about the model.
	if (support === "unsupported") return finish("custom_status_setting_rejected", "warn");
	// "reduced" reports the effort now in force (the endpoint accepted that value), not a
	// measured effect, so it stays a plain statement.
	if (support === "reduced") return finish("custom_status_effort_reduced", "ok");
	if (support === "accepted") {
		// A validation that passed with nothing contradicting it reads as the normal
		// success it is; the "a reported zero proves nothing" caveat rides the title.
		if (evidence !== "confirmed") return finish("custom_status_setting_sent_unconfirmed", "ok");
		return finish(reasoning && reasoning.mode === "on" ? "custom_status_thinking_on_confirmed" : "custom_status_thinking_off_confirmed", "ok");
	}
	return finish("custom_status_unknown_model", "warn");
}

function getVisibleAdapterOptions(adapters = []) {
	return adapters.filter(adapter => {
		const capabilities = adapter && adapter.capabilities || {};
		return !!(adapter && adapter.id && adapter.uiReady && adapter.labelKey
			&& capabilities.single && capabilities.batch && capabilities.validation
			&& capabilities.errorClassification && (capabilities.catalog || capabilities.catalogUnsupported));
	}).map(adapter => Object.freeze({
		id: adapter.id,
		labelKey: adapter.labelKey,
		credentialPlaceholderKey: adapter.credentialPlaceholderKey || "",
		credentialPolicy: adapter.credentialPolicy || "required",
		reasoningFamilies: Object.freeze([...(adapter.reasoningFamilies || [])]),
		supportedEfforts: Object.freeze([...(adapter.supportedEfforts || [])])
	}));
}

module.exports = {
	CUSTOM_PROVIDER_MAIN_SLOTS,
	CAPABILITY_STATUS_KEYS,
	formatThinkingRawLabel,
	thinkingRawGlossKey,
	resolveCustomProviderStatus,
	getVisibleAdapterOptions
};
