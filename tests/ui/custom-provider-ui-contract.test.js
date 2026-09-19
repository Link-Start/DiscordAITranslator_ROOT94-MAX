const test = require("node:test");
const assert = require("node:assert/strict");
const {
	CUSTOM_PROVIDER_MAIN_SLOTS,
	resolveCustomProviderStatus,
	getVisibleAdapterOptions,
	formatThinkingRawLabel
} = require("../../src/ui/custom-provider-ui-contract");

test("custom provider main surface stays at six stable slots", () => {
	assert.deepEqual(CUSTOM_PROVIDER_MAIN_SLOTS, ["endpoint", "key", "model", "thinking", "strength", "status-actions"]);
});



test("single-line custom status has one deterministic priority", () => {
	const stable = {validationOk: true, interfaceResolved: "openai_chat", reasoning: {mode: "off", support: "accepted", evidence: "confirmed"}};
	const keyOf = patch => resolveCustomProviderStatus({...stable, ...patch}).key;
	// detecting > http error > interface unknown > upstream(resolved) > stale > A/B > capability
	assert.equal(keyOf({detecting: true, error: true, stale: true, benchmarkWarning: true}), "custom_status_detecting");
	assert.equal(keyOf({error: true, stale: true, benchmarkWarning: true}), "custom_status_error");
	assert.equal(keyOf({interfaceResolved: "", stale: true, reasoning: {mode: "follow"}}), "custom_status_interface_unknown");
	assert.equal(keyOf({reasoning: {mode: "follow"}, stale: true}), "custom_status_upstream");
	assert.equal(keyOf({stale: true, benchmarkWarning: true}), "custom_status_stale");
	assert.equal(keyOf({benchmarkWarning: true}), "custom_status_benchmark_slower");
	assert.equal(keyOf({validationOk: false, reasoning: {mode: "off", support: "pending"}}), "custom_status_unknown_model");
	// a verdict already earned outlives the session that earned it
	assert.equal(keyOf({validationOk: false}), "custom_status_thinking_off_confirmed", "a restored verdict is not re-asked");
});

test("capability results map to plain sentences that never claim unverified effects", () => {
	const base = {strategy: "auto", validationOk: true, interfaceResolved: "openai_chat"};
	const of = reasoning => resolveCustomProviderStatus({...base, reasoning});
	assert.deepEqual(of({mode: "off", support: "accepted", evidence: "confirmed"}), {key: "custom_status_thinking_off_confirmed", tone: "ok", decorator: null});
	// accepted without evidence reads as a passed validation (green) but must never reuse
	// the confirmed sentence: the words still separate "sent" from "proven to take effect"
	assert.deepEqual(of({mode: "off", support: "accepted", evidence: "none"}), {key: "custom_status_setting_sent_unconfirmed", tone: "ok", decorator: null});
	assert.deepEqual(of({mode: "on", support: "accepted", evidence: "none"}), {key: "custom_status_setting_sent_unconfirmed", tone: "ok", decorator: null});
	assert.deepEqual(of({mode: "on", support: "accepted", evidence: "confirmed"}), {key: "custom_status_thinking_on_confirmed", tone: "ok", decorator: null});
	assert.deepEqual(of({mode: "off", support: "reduced", resolvedValue: "low", evidence: "none"}), {key: "custom_status_effort_reduced", tone: "ok", decorator: null});
	// off that provably kept thinking is an error (the relay or provider substituted a level);
	// on that produced no thinking stays a caution because absence is weaker evidence
	assert.deepEqual(of({mode: "off", support: "accepted", evidence: "contradicted"}), {key: "custom_status_off_not_applied", tone: "fail", decorator: null});
	assert.deepEqual(of({mode: "on", support: "accepted", evidence: "contradicted"}), {key: "custom_status_on_not_applied", tone: "warn", decorator: null}, "each direction says what was sent before saying it had no effect");
	assert.deepEqual(of({mode: "off", support: "unsupported", evidence: "none"}), {key: "custom_status_setting_rejected", tone: "warn", decorator: null});
	assert.deepEqual(of({mode: "off", support: "pending", evidence: "none"}), {key: "custom_status_unknown_model", tone: "warn", decorator: null});
});


test("only complete UI-ready protocol adapters become advanced options", () => {
	const complete = {single: true, batch: true, validation: true, catalog: true, errorClassification: true};
	const options = getVisibleAdapterOptions([
		{id: "openai_chat", uiReady: true, labelKey: "api_format_openai_chat", capabilities: complete},
		{id: "openai_responses", uiReady: true, labelKey: "api_format_openai_responses", capabilities: {...complete, catalog: false, catalogUnsupported: true}},
		{id: "future_hidden", uiReady: false, labelKey: "future", capabilities: complete},
		{id: "future_incomplete", uiReady: true, labelKey: "future", capabilities: {single: true}}
	]);
	assert.deepEqual(options.map(option => option.id), ["openai_chat", "openai_responses"]);
});


// --- T3: the pure contract projects the stored raw, it never folds it ---


test("T3 a locally known rejection outranks staleness and pending without becoming evidence", () => {
	const base = {interfaceResolved: "anthropic_messages", validationOk: true};
	const invalid = resolveCustomProviderStatus(Object.assign({}, base, {stale: true, reasoning: {mode: "on", availability: "unsupported", support: "pending", evidence: "none"}}));
	assert.deepEqual(invalid, {key: "custom_status_invalid_strength", tone: "warn", decorator: null}, "it wins over the re-validate prompt");
	// transient states still come first: they are the one action the user should take
	assert.equal(resolveCustomProviderStatus(Object.assign({}, base, {detecting: true, reasoning: {availability: "unsupported"}})).key, "custom_status_detecting");
	assert.equal(resolveCustomProviderStatus(Object.assign({}, base, {error: true, reasoning: {availability: "unsupported"}})).key, "custom_status_error");
	assert.equal(resolveCustomProviderStatus(Object.assign({}, base, {interfaceResolved: "", reasoning: {availability: "unsupported"}})).key, "custom_status_interface_unknown");
	// following the provider sends no strength at all, so there is nothing to reject
	assert.equal(resolveCustomProviderStatus(Object.assign({}, base, {reasoning: {mode: "follow", availability: "unsupported"}})).key, "custom_status_upstream");
	// and an available raw leaves the ladder exactly as it was
	assert.equal(resolveCustomProviderStatus(Object.assign({}, base, {stale: true, reasoning: {mode: "on", availability: "supported", support: "pending"}})).key, "custom_status_stale");
});

test("T4 a confirmed strength reads the same sentence whichever schema carried it", () => {
	const base = {interfaceResolved: "anthropic_messages", validationOk: true};
	for (const candidateId of ["anthropic_on_adaptive_low", "anthropic_on_budget_1024"]) {
		const status = resolveCustomProviderStatus(Object.assign({}, base, {reasoning: {mode: "on", availability: "supported", support: "accepted", evidence: "confirmed", candidateId}}));
		assert.deepEqual(status, {key: "custom_status_thinking_on_confirmed", tone: "ok", decorator: null}, candidateId + " must not change what the user is told");
	}
});

test("T5 a strength label is the upstream value itself, only spelled for a human", () => {
	assert.equal(formatThinkingRawLabel("minimal"), "minimal");
	assert.equal(formatThinkingRawLabel("xhigh"), "xhigh", "never merged into a neighbouring tier");
	assert.equal(formatThinkingRawLabel("max"), "max");
	assert.equal(formatThinkingRawLabel(-1), "dynamic (-1)", "the one value that needs a word carries the number with it");
	assert.equal(formatThinkingRawLabel(12000), "12000");
	assert.equal(formatThinkingRawLabel(true), "true");
	assert.equal(formatThinkingRawLabel(false), "false");
	assert.equal(formatThinkingRawLabel(""), "");
	assert.equal(formatThinkingRawLabel(null), "");
});
