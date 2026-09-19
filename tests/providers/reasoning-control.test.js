const test = require("node:test");
const assert = require("node:assert/strict");
const {
	normalizeReasoningMode,
	normalizeReasoningModelMode,
	resolveReasoningOnRaw,
	normalizeReasoningProfile,
	inferReasoningProfile,
	getReasoningProfileSpec,
	getReasoningProfileCandidates,
	isEquivalentReasoningCandidate,
	createReasoningCapabilityKey,
	createLegacyReasoningCapabilityKey,
	createReasoningSchemaId,
	createReasoningCapabilityCache,
	isUnsupportedReasoningFieldError,
	isUnsupportedReasoningValueError
} = require("../../src/providers/reasoning-control");

test("reasoning modes and profiles normalize to behavior-preserving defaults", () => {
	assert.equal(normalizeReasoningMode("off"), "off");
	assert.equal(normalizeReasoningMode("disabled"), "auto");
	assert.equal(normalizeReasoningProfile("qwen"), "qwen");
	assert.equal(normalizeReasoningProfile("ollama"), "ollama");
	assert.equal(normalizeReasoningProfile("gemini"), "gemini");
	assert.equal(normalizeReasoningProfile("anthropic"), "anthropic");
	assert.equal(normalizeReasoningProfile("future"), "auto");
});

test("per-model reasoning modes preserve legacy auto as follow and only an absent raw falls back", () => {
	assert.equal(normalizeReasoningModelMode("auto"), "follow");
	assert.equal(normalizeReasoningModelMode("follow"), "follow");
	assert.equal(normalizeReasoningModelMode("off"), "off");
	assert.equal(normalizeReasoningModelMode("on"), "on");
	assert.equal(normalizeReasoningModelMode("invalid"), "follow");
	assert.equal(resolveReasoningOnRaw("minimal"), "minimal");
	assert.equal(resolveReasoningOnRaw("high"), "high");
	assert.equal(resolveReasoningOnRaw("xhigh"), "xhigh", "an unlisted raw is kept, not folded");
	assert.equal(resolveReasoningOnRaw(12000), 12000, "a number keeps its type");
	assert.equal(resolveReasoningOnRaw(true), true, "so does a boolean");
	assert.equal(resolveReasoningOnRaw(""), "low", "only an absent value falls back");
	assert.equal(resolveReasoningOnRaw(undefined, true), true, "and it falls back to the ladder default");
});

test("reasoning profiles emit one exact protocol field and truthful support semantics", () => {
	assert.deepEqual(getReasoningProfileSpec("deepseek"), {profile: "deepseek", extras: {thinking: {type: "disabled"}}, fields: ["thinking"], success: "accepted"});
	assert.deepEqual(getReasoningProfileSpec("qwen"), {profile: "qwen", extras: {enable_thinking: false}, fields: ["enable_thinking"], success: "accepted"});
	assert.deepEqual(getReasoningProfileSpec("openai"), {profile: "openai", extras: {reasoning_effort: "none"}, fields: ["reasoning_effort"], success: "accepted"});
	assert.equal(getReasoningProfileSpec("auto"), null);
});

test("reasoning profile candidates keep persisted profile names while probing exact values in order", () => {
	assert.deepEqual(getReasoningProfileCandidates("openai").map(spec => [spec.candidateId, spec.resolvedValue, spec.success, spec.extras]), [
		["openai_none", "none", "accepted", {reasoning_effort: "none"}]
	]);
	assert.deepEqual(getReasoningProfileCandidates("qwen").map(spec => [spec.candidateId, spec.resolvedValue, spec.continueOnFieldUnsupported === true]), [
		["qwen_enable_thinking", "enable_thinking=false", true],
		["qwen_chat_template", "chat_template_kwargs.enable_thinking=false", false]
	]);
	assert.deepEqual(getReasoningProfileCandidates("deepseek").map(spec => spec.candidateId), ["deepseek_disabled"]);
	assert.deepEqual(getReasoningProfileCandidates("ollama", {model: "qwen3:8b"}).map(spec => [spec.candidateId, spec.extras, spec.success]), [
		["ollama_think_false", {think: false}, "accepted"]
	]);
	assert.deepEqual(getReasoningProfileCandidates("ollama", {model: "gpt-oss:20b"}).map(spec => spec.candidateId), ["ollama_think_false"]);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {model: "gemini-2.5-flash"}).map(spec => [spec.candidateId, spec.success]), [["gemini_budget_0", "accepted"]]);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {model: "gemini-3.5-flash"}).map(spec => spec.candidateId), []);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {model: "gemini-3.1-pro"}).map(spec => spec.candidateId), []);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {model: "unknown"}).map(spec => spec.candidateId), ["gemini_budget_0"]);
	assert.equal(getReasoningProfileCandidates("anthropic", {model: "claude-sonnet-5"})[0].candidateId, "anthropic_disabled");
	assert.equal(getReasoningProfileCandidates("anthropic", {model: "claude-opus-5"})[0].candidateId, "anthropic_disabled");
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {model: "claude-fable-5"}).map(spec => spec.candidateId), []);
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {model: "claude-mythos-preview"}).map(spec => spec.candidateId), []);
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {model: "unknown"}).map(spec => spec.candidateId), ["anthropic_disabled"]);
	assert.equal(getReasoningProfileCandidates("anthropic", {model: "future-thinking-model"})[0].continueOnFieldUnsupported, true, "a second genuine off spelling may still be tried when one exists");
	for (const model of ["", "unknown-alias", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.5-flash", "gemini-3.1-pro"]) assert.ok(getReasoningProfileCandidates("gemini", {model}).length <= 3, `${model || "empty"} must stay inside the global probe budget`);
	assert.deepEqual(getReasoningProfileSpec("openai", "openai_none").extras, {reasoning_effort: "none"});
	assert.equal(getReasoningProfileSpec("openai", "openai_minimal"), null, "minimal still thinks and is not an off candidate");
	assert.equal(getReasoningProfileSpec("openai", "missing"), null);
	assert.deepEqual(getReasoningProfileCandidates("auto"), []);
});

test("explicit on candidates mirror each protocol without inventing an auto effort", () => {
	assert.deepEqual(getReasoningProfileCandidates("openai", {mode: "on", effort: "medium"}).map(spec => [spec.candidateId, spec.resolvedValue, spec.opensThinking, spec.extras]), [
		["openai_on_medium", "medium", true, {reasoning_effort: "medium"}]
	]);
	assert.deepEqual(getReasoningProfileCandidates("deepseek", {mode: "on"}).map(spec => spec.extras), [{thinking: {type: "enabled"}}]);
	assert.deepEqual(getReasoningProfileCandidates("qwen", {mode: "on"}).map(spec => spec.extras), [
		{enable_thinking: true},
		{chat_template_kwargs: {enable_thinking: true}}
	]);
	assert.deepEqual(getReasoningProfileCandidates("ollama", {mode: "on", model: "qwen3:8b", effort: "high"}).map(spec => spec.extras), [{think: true}]);
	assert.deepEqual(getReasoningProfileCandidates("ollama", {mode: "on", model: "gpt-oss:20b", effort: "high"}).map(spec => spec.extras), [{think: "high"}]);
	// T3: the raw reaches the wire as itself. Ollama has no minimal level, and that fact
	// now lives in the adapter declaration, which keeps it out of the option table and
	// stops the dispatch, instead of being rewritten to a neighbouring value here.
	assert.deepEqual(getReasoningProfileCandidates("ollama", {mode: "on", model: "gpt-oss:20b", effort: "minimal"}).map(spec => spec.extras), [{think: "minimal"}]);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {mode: "on", model: "gemini-2.5-flash", effort: "high"}).map(spec => spec.extras), [{generationConfig: {thinkingConfig: {thinkingBudget: -1}}}]);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {mode: "on", model: "gemini-3.5-flash", effort: "minimal"}).map(spec => spec.extras), [{generationConfig: {thinkingConfig: {thinkingLevel: "minimal"}}}]);
	assert.deepEqual(getReasoningProfileCandidates("gemini", {mode: "on", model: "gemini-3.1-pro", effort: "minimal"}).map(spec => spec.extras), [{generationConfig: {thinkingConfig: {thinkingLevel: "minimal"}}}], "Gemini 3 Pro rejects minimal by declaration, not by local rewrite");
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {mode: "on", model: "claude-sonnet-5", effort: "medium"}).map(spec => spec.extras), [{thinking: {type: "adaptive", display: "omitted"}, output_config: {effort: "medium"}}]);
	// a raw the budget schema cannot express gets no budget candidate at all
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {mode: "on", model: "claude-sonnet-4-5", effort: "minimal"}).map(spec => spec.candidateId), ["anthropic_on_adaptive_minimal"]);
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {mode: "on", model: "claude-sonnet-4-5", effort: "low"}).map(spec => spec.extras), [{thinking: {type: "enabled", budget_tokens: 1024, display: "omitted"}}]);
	assert.deepEqual(getReasoningProfileCandidates("anthropic", {mode: "on", model: "unknown", effort: "low"}).map(spec => spec.candidateId), ["anthropic_on_adaptive_low", "anthropic_on_budget_1024"]);
	assert.deepEqual(getReasoningProfileCandidates("openai", {mode: "follow"}), []);
	assert.deepEqual(getReasoningProfileSpec("openai", "openai_on_high", {mode: "on", effort: "high"}).extras, {reasoning_effort: "high"});
	const medium = getReasoningProfileCandidates("openai", {mode: "on", effort: "medium"})[0];
	assert.equal(isEquivalentReasoningCandidate(medium, {mode: "on", raw: "medium"}), true);
	assert.equal(isEquivalentReasoningCandidate(medium, {mode: "on", raw: "low"}), false, "a rewrite cannot cross raw strengths");
	assert.equal(isEquivalentReasoningCandidate(getReasoningProfileCandidates("openai")[0], {mode: "off", raw: "low"}), true);
});

test("capability keys isolate follow off on and explicit effort values", () => {
	const base = {engineKey: "oaicompat", endpoint: "https://a.test/v1/chat/completions", model: "m", profile: "openai"};
	const off = createReasoningCapabilityKey({...base, mode: "off", effort: "low", resolvedValue: "none"});
	const onLow = createReasoningCapabilityKey({...base, mode: "on", effort: "low", resolvedValue: "low"});
	const onHigh = createReasoningCapabilityKey({...base, mode: "on", effort: "high", resolvedValue: "high"});
	assert.notEqual(off, onLow);
	assert.notEqual(onLow, onHigh);
});

test("auto inference uses endpoint and model only to choose a probe profile", () => {
	assert.equal(inferReasoningProfile({model: "deepseek-r1"}), "deepseek");
	assert.equal(inferReasoningProfile({endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max"}), "qwen");
	assert.equal(inferReasoningProfile({endpoint: "http://localhost:7078/v1/chat/completions", model: "gpt-5.6-luna"}), "openai");
	assert.equal(inferReasoningProfile({endpoint: "http://localhost:11434/api/chat", model: "qwen3:8b"}), "qwen", "transport-specific families are selected by the resolved adapter, not this Chat inference helper");
	assert.equal(inferReasoningProfile({endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-3.5-flash"}), "openai");
});

test("unknown-field retry requires 400 or 422, an allowlisted phrase and the exact sent field", () => {
	assert.equal(isUnsupportedReasoningFieldError(400, {error: {message: "Unknown parameter: reasoning_effort"}}, ["reasoning_effort"]), true);
	assert.equal(isUnsupportedReasoningFieldError(400, {error: {status: "INVALID_ARGUMENT", message: "Unknown name thinkingConfig"}}, ["thinkingConfig"]), true);
	assert.equal(isUnsupportedReasoningFieldError(422, {detail: [{loc: ["body", "enable_thinking"], type: "extra_forbidden", msg: "Extra inputs are not permitted"}]}, ["enable_thinking"]), true);
	assert.equal(isUnsupportedReasoningFieldError(400, "model is not supported", ["reasoning_effort"]), false, "the exact field must be named");
	assert.equal(isUnsupportedReasoningFieldError(401, "Unknown parameter reasoning_effort", ["reasoning_effort"]), false);
	assert.equal(isUnsupportedReasoningFieldError(400, "Invalid value for reasoning_effort", ["reasoning_effort"]), false, "an invalid value is not an unknown field");
	assert.equal(isUnsupportedReasoningFieldError(400, "Unknown parameter enable_thinking", ["thinking"]), false, "field names may not match by substring");
});

test("unsupported-value detection requires a value error plus this candidate field or value", () => {
	const none = getReasoningProfileSpec("openai", "openai_none");
	assert.equal(isUnsupportedReasoningValueError(400, {error: {message: "Invalid value: 'none' for reasoning_effort. Must be one of low, medium, high."}}, none), true);
	assert.equal(isUnsupportedReasoningValueError(422, "reasoning_effort is not a valid enum: none", none), true);
	assert.equal(isUnsupportedReasoningValueError(400, "Unknown parameter reasoning_effort", none), false, "unknown fields use the field classifier");
	assert.equal(isUnsupportedReasoningValueError(400, "Invalid value for temperature", none), false, "another field may not advance the ladder");
	assert.equal(isUnsupportedReasoningValueError(429, "Invalid value none for reasoning_effort", none), false);
	assert.equal(isUnsupportedReasoningValueError(400, "model is not supported", none), false);
});

test("capability cache is profile-keyed, LRU-bounded and engine-clearable", () => {
	let timestamp = 10;
	const cache = createReasoningCapabilityCache({capacity: 2, now: () => ++timestamp});
	const openai = createReasoningCapabilityKey({engineKey: "oaicompat", endpoint: "https://a/v1/chat/completions", model: "m", profile: "openai"});
	const deepseek = createReasoningCapabilityKey({engineKey: "oaicompat", endpoint: "https://a/v1/chat/completions", model: "m", profile: "deepseek"});
	const qwen = createReasoningCapabilityKey({engineKey: "custom-a", endpoint: "https://b/v1/chat/completions", model: "q", profile: "qwen"});
	cache.set(openai, "reduced", {candidateId: "openai_low", resolvedValue: "low", evidence: "none"});
	cache.set(deepseek, "accepted");
	assert.deepEqual(cache.get(openai), {support: "reduced", candidateId: "openai_low", resolvedValue: "low", evidence: "none", checkedAt: 11}, "get refreshes LRU order and preserves resolved capability details");
	cache.set(qwen, "accepted");
	assert.equal(cache.get(deepseek), null, "the least recently used entry is evicted");
	assert.equal(cache.size(), 2);
	assert.equal(cache.deleteEngine("oaicompat"), 1);
	assert.deepEqual(cache.keys(), [qwen]);
	assert.equal(cache.delete(qwen), true);
	assert.equal(cache.get(qwen), null);
});

test("a wire schema identity keeps the same raw apart across field paths", () => {
	assert.equal(createReasoningSchemaId({format: "openai_chat", fieldPath: "reasoning_effort"}), "openai_chat/reasoning_effort/v1");
	assert.equal(createReasoningSchemaId({format: "gemini_native", fieldPath: "generationConfig.thinkingConfig.thinkingLevel"}), "gemini_native/generationConfig.thinkingConfig.thinkingLevel/v1");
	assert.equal(createReasoningSchemaId({format: "anthropic_messages", fieldPath: "output_config.effort+thinking.adaptive", version: 2}), "anthropic_messages/output_config.effort+thinking.adaptive/v2");
	assert.equal(createReasoningSchemaId({}), "");
	assert.equal(createReasoningSchemaId({format: "openai_chat"}), "");
	// a candidate carries its own field path, so the id can be derived from policy data
	assert.equal(createReasoningSchemaId({format: "openai_chat", spec: getReasoningProfileSpec("openai", "openai_none")}), "openai_chat/reasoning_effort/v1");
});

test("the capability key isolates the same raw under different wire schemas", () => {
	const base = {engineKey: "oaicompat", endpoint: "https://host.test/v1", model: "m", mode: "on", effort: "low", resolvedValue: "low"};
	const chat = createReasoningCapabilityKey({...base, format: "openai_chat", profile: "openai", schemaId: "openai_chat/reasoning_effort/v1"});
	const gemini = createReasoningCapabilityKey({...base, format: "gemini_native", profile: "gemini", schemaId: "gemini_native/generationConfig.thinkingConfig.thinkingLevel/v1"});
	const adaptive = createReasoningCapabilityKey({...base, format: "anthropic_messages", profile: "anthropic", schemaId: "anthropic_messages/output_config.effort+thinking.adaptive/v1"});
	const budget = createReasoningCapabilityKey({...base, format: "anthropic_messages", profile: "anthropic", schemaId: "anthropic_messages/thinking.budget_tokens/v1"});
	const keys = [chat, gemini, adaptive, budget];
	assert.equal(new Set(keys).size, 4, "same raw low, four wire schemas, four identities");
	assert.equal(createReasoningCapabilityKey({...base, format: "openai_chat", profile: "openai", schemaId: "openai_chat/reasoning_effort/v1"}), chat, "the key is stable for the same inputs");
	// the pre-schema key form stays constructible so a stored record can still be found
	const legacy = createLegacyReasoningCapabilityKey({...base, format: "openai_chat", profile: "openai"});
	assert.notEqual(legacy, chat);
	assert.equal(legacy.split("\u0000").length, 8);
	assert.equal(chat.split("\u0000").length, 9);
	assert.equal(createLegacyReasoningCapabilityKey({...base, format: "openai_chat", profile: "openai", schemaId: "openai_chat/reasoning_effort/v1"}), legacy, "the legacy form ignores the schema segment");
});

test("typed raw values address distinct capability keys", () => {
	const base = {engineKey: "oaicompat", endpoint: "https://host.test/v1beta/models", model: "gemini-2.5-flash", format: "gemini_native", profile: "gemini", mode: "on", schemaId: "gemini_native/generationConfig.thinkingConfig.thinkingBudget/v1"};
	const numeric = createReasoningCapabilityKey({...base, rawKey: "n:12000"});
	const spelled = createReasoningCapabilityKey({...base, rawKey: "s:12000"});
	assert.notEqual(numeric, spelled, "a budget and its spelling never share a verdict");
});

// --- T3: exact raw pass-through and adapter-declared availability ---

const reasoningControlModule = require("../../src/providers/reasoning-control");
const {getReasoningRawTiers, getReasoningRawAvailability, buildReasoningTierOptions, reconcileLegacyReasoningRaw, deriveReasoningTierState} = reasoningControlModule;
const {createReasoningRawKey} = require("../../src/settings/reasoning-raw-value");
const {createOpenAiChatAdapter, createOllamaNativeAdapter, createGeminiNativeAdapter, createAnthropicMessagesAdapter} = require("../../src/providers/protocol-adapters");

const ADAPTER_DEPS = Object.freeze({normalizeEndpoint: value => String(value || ""), getCatalogEndpoint: value => String(value || ""), parseBatch: () => null, parseText: () => "", parseUsage: () => null, classifyError: () => null});

function declarationFor(id) {
	const adapters = {
		openai_chat: createOpenAiChatAdapter(ADAPTER_DEPS),
		ollama_native: createOllamaNativeAdapter(ADAPTER_DEPS),
		gemini_native: createGeminiNativeAdapter(ADAPTER_DEPS),
		anthropic_messages: createAnthropicMessagesAdapter(ADAPTER_DEPS)
	};
	return adapters[id].reasoningControl;
}

test("unknown exact raw is preserved and never normalized to low", () => {
	assert.equal(reasoningControlModule.normalizeReasoningEffort, undefined, "the enum fold-down is gone from the module surface");

	const openai = getReasoningProfileCandidates("openai", {mode: "on", effort: "xhigh", model: "gateway-model"});
	assert.equal(openai[0].extras.reasoning_effort, "xhigh", "a gateway raw reaches the wire verbatim");
	assert.equal(openai[0].resolvedValue, "xhigh");
	assert.equal(openai[0].candidateId, "openai_on_xhigh", "the candidate id is derived from the raw");

	const level = getReasoningProfileCandidates("gemini", {mode: "on", effort: "max", model: "gemini-3-flash"});
	assert.equal(level[0].extras.generationConfig.thinkingConfig.thinkingLevel, "max");

	// the two local rewrites are gone: minimal stays minimal on both surfaces
	const geminiPro = getReasoningProfileCandidates("gemini", {mode: "on", effort: "minimal", model: "gemini-3-pro-preview"});
	assert.equal(geminiPro[0].extras.generationConfig.thinkingConfig.thinkingLevel, "minimal", "no local minimal to low rewrite");
	const claude = getReasoningProfileCandidates("anthropic", {mode: "on", effort: "minimal", model: "claude-opus-5"});
	assert.equal(claude[0].extras.output_config.effort, "minimal", "no local minimal to low rewrite");

	// a numeric raw rides the budget schema as the number the user chose
	const budget = getReasoningProfileCandidates("anthropic", {mode: "on", effort: 12000, model: "claude-opus-4-1"});
	assert.equal(budget[0].extras.thinking.budget_tokens, 12000);
	assert.equal(budget[0].resolvedValue, "budget=12000");
});

test("known Gemini and Anthropic option tables never offer their officially rejected values", () => {
	const gemini = declarationFor("gemini_native");
	const anthropic = declarationFor("anthropic_messages");

	assert.equal(getReasoningRawTiers(gemini, {model: "gemini-3-pro-preview"}).includes("minimal"), false, "Gemini Pro rejects minimal");
	assert.equal(getReasoningRawTiers(gemini, {model: "gemini-3-flash"}).includes("minimal"), true, "Flash keeps it");
	assert.equal(getReasoningRawTiers(anthropic, {model: "claude-opus-5"}).includes("minimal"), false, "Anthropic has no minimal tier");

	assert.equal(getReasoningRawAvailability(gemini, {model: "gemini-3-pro-preview", raw: "minimal"}), "unsupported");
	assert.equal(getReasoningRawAvailability(gemini, {model: "gemini-3-flash", raw: "minimal"}), "supported");
	assert.equal(getReasoningRawAvailability(anthropic, {model: "claude-opus-5", raw: "minimal"}), "unsupported");
	assert.equal(getReasoningRawAvailability(anthropic, {model: "claude-opus-5", raw: "low"}), "supported");
	// an unknown raw is not a rejected raw: only officially documented rejections count
	assert.equal(getReasoningRawAvailability(declarationFor("openai_chat"), {model: "gw", raw: "xhigh"}), "supported");

	// a rejected raw already saved stays visible and stays itself
	const options = buildReasoningTierOptions(anthropic, {model: "claude-opus-5", savedRaw: "minimal"});
	const rejected = options.find(option => option.raw === "minimal");
	assert.ok(rejected, "the saved raw is still offered so the user can see what is stored");
	assert.equal(rejected.availability, "unsupported");
	assert.equal(rejected.state, "pending", "an availability verdict is not evidence");
});

test("T3 documented generational ladders, and dead options leave with the selection", () => {
	const chat = declarationFor("openai_chat");
	assert.deepEqual([...getReasoningRawTiers(chat, {model: "gpt-5.4"})], ["low", "medium", "high", "xhigh"], "the 5.2-5.5 line has no minimal and gains xhigh");
	assert.deepEqual([...getReasoningRawTiers(chat, {model: "gpt-5.6-sol"})], ["low", "medium", "high", "xhigh", "max"], "5.6 adds max");
	assert.deepEqual([...getReasoningRawTiers(chat, {model: "gpt-5.1"})], ["low", "medium", "high"], "plain 5.1 dropped minimal and has no xhigh");
	assert.deepEqual([...getReasoningRawTiers(chat, {model: "gpt-5.1-codex-max"})], ["low", "medium", "high", "xhigh"], "codex-max introduced xhigh");
	assert.deepEqual([...getReasoningRawTiers(chat, {model: "gpt-5-pro"})], ["high"], "pro only accepts high");
	assert.deepEqual([...getReasoningRawTiers(chat, {model: "gpt-5"})], ["minimal", "low", "medium", "high"], "the original GPT-5 ladder is untouched");
	assert.equal(getReasoningRawAvailability(chat, {model: "gpt-5.4", raw: "minimal", mode: "on"}), "unsupported", "5.1+ documents the minimal rejection");
	// while the rejected raw is still the saved choice it stays on the menu to explain itself
	const stillSaved = buildReasoningTierOptions(chat, {model: "gpt-5.4", savedRaw: "minimal", createRawKey: createReasoningRawKey});
	assert.equal(stillSaved.find(option => option.raw === "minimal").availability, "unsupported");
	// once the user moves off it, the dead option leaves even though a verdict was recorded
	const movedOff = buildReasoningTierOptions(chat, {model: "gpt-5.4", savedRaw: "low", evidenceRaws: ["minimal"], createRawKey: createReasoningRawKey});
	assert.equal(movedOff.some(option => option.raw === "minimal"), false, "a documented-rejected raw is never offered as a fresh choice");
});

test("an unknown model falls back to the implemented format default tiers, all pending, with Custom last", () => {
	const options = buildReasoningTierOptions(declarationFor("openai_chat"), {model: "some-unlisted-gateway-model"});
	assert.deepEqual(options.filter(option => !option.custom).map(option => option.raw), ["minimal", "low", "medium", "high"], "the production ladder, not a fixture");
	assert.equal(options.filter(option => !option.custom).every(option => option.state === "pending" && option.availability === "supported"), true, "nothing is tested yet");
	assert.equal(options[options.length - 1].custom, true, "Custom is last");
	assert.equal(options.filter(option => option.custom).length, 1);

	// Custom only exists where the adapter declares it
	const ollama = buildReasoningTierOptions(declarationFor("ollama_native"), {model: "qwen3:8b"});
	assert.equal(ollama.some(option => option.custom), false, "no declaration, no Custom row");
	assert.deepEqual(ollama.map(option => option.raw), [true], "a boolean control declares a boolean tier");
	assert.deepEqual(buildReasoningTierOptions(declarationFor("ollama_native"), {model: "gpt-oss:20b"}).map(option => option.raw), ["low", "medium", "high"], "gpt-oss is enum only");

	// three-source union: declared tiers, the saved exact raw and evidence raws, deduped by type
	const union = buildReasoningTierOptions(declarationFor("openai_chat"), {model: "gw", savedRaw: "max", evidenceRaws: ["xhigh", "low", 12000], createRawKey: createReasoningRawKey});
	assert.deepEqual(union.filter(option => !option.custom).map(option => option.raw), ["minimal", "low", "medium", "high", "max", "xhigh", 12000], "saved and evidence raws append without duplicating low");
	const numeric = buildReasoningTierOptions(declarationFor("openai_chat"), {model: "gw", evidenceRaws: [12000, "12000"], createRawKey: createReasoningRawKey});
	assert.equal(numeric.filter(option => option.raw === 12000 || option.raw === "12000").length, 2, "a number and its spelling are two tiers");
});

test("T3 an off sentinel is refused under mode on and the legacy word maps to what was sent", () => {
	const chat = declarationFor("openai_chat");
	const ollama = declarationFor("ollama_native");
	const gemini = declarationFor("gemini_native");
	const anthropic = declarationFor("anthropic_messages");

	// mode-aware: the off path sends these on purpose, the on path never may
	for (const [declaration, raw] of [[chat, "none"], [chat, false], [ollama, false], [gemini, 0], [gemini, "0"], [anthropic, "disabled"]]) {
		assert.equal(getReasoningRawAvailability(declaration, {model: "m", raw, mode: "on"}), "unsupported", String(raw));
		assert.equal(getReasoningRawAvailability(declaration, {model: "m", raw, mode: "off"}), "supported", `${String(raw)} is legitimate while closing thinking`);
	}
	assert.equal(getReasoningRawAvailability(gemini, {model: "gemini-2.5-flash", raw: 12000, mode: "on"}), "supported", "a real budget is not a sentinel");
	// a sentinel never appears as an offered tier under mode on either
	assert.equal(buildReasoningTierOptions(gemini, {model: "gemini-2.5-flash", savedRaw: 0, createRawKey: createReasoningRawKey}).find(option => option.raw === 0).availability, "unsupported");

	// the legacy word maps to the raw an older build actually dispatched for it
	assert.equal(reconcileLegacyReasoningRaw(ollama, {model: "qwen3:8b", raw: "low"}), true, "generic Ollama only understood the boolean");
	assert.equal(reconcileLegacyReasoningRaw(ollama, {model: "gpt-oss:20b", raw: "low"}), "low", "GPT-OSS understood the enum");
	assert.equal(reconcileLegacyReasoningRaw(ollama, {model: "gpt-oss:20b", raw: "minimal"}), "low", "and folded anything outside it");
	assert.equal(reconcileLegacyReasoningRaw(gemini, {model: "gemini-2.5-flash", raw: "high"}), -1, "2.5 had no level field");
	assert.equal(reconcileLegacyReasoningRaw(gemini, {model: "gemini-3-flash", raw: "minimal"}), "minimal", "3.x Flash did send minimal");
	assert.equal(reconcileLegacyReasoningRaw(gemini, {model: "gemini-3-pro-preview", raw: "minimal"}), "low", "Pro was quietly sent low");
	assert.equal(reconcileLegacyReasoningRaw(anthropic, {model: "claude-opus-5", raw: "minimal"}), "low");
	assert.equal(reconcileLegacyReasoningRaw(chat, {model: "gw", raw: "xhigh"}), "low", "an unlisted word was folded to low by the old build");
	assert.equal(reconcileLegacyReasoningRaw(chat, {model: "gw", raw: "high"}), "high", "an expressible word is left alone");
	assert.equal(reconcileLegacyReasoningRaw(null, {model: "gw", raw: "xhigh"}), "xhigh", "with no declaration there is nothing to reconcile");
});

test("T4 the per-value verdict vocabulary matches what the storage layer derives for a migrated record", () => {
	const {createSettingsStore} = require("../../src/settings/settings-store");
	const store = createSettingsStore({
		now: () => 1,
		isKnownEngine: () => true,
		sortLanguages: table => table,
		resolveGuildId: () => null,
		loadFavorites: () => null,
		persistFavorites: () => null,
		loadAuthKeys: () => ({"custom-a": {key: "k", model: "m"}}),
		persistAuthKeys: () => null,
		loadLanguages: () => null,
		persistLanguages: () => null,
		loadChannelTitles: () => null,
		persistChannelTitles: () => null,
		loadModelCatalogs: () => null,
		persistModelCatalogs: () => null
	});
	store.reload();
	for (const support of ["accepted", "reduced", "unsupported", "pending"]) {
		for (const evidence of ["none", "confirmed", "contradicted"]) {
			const modelId = support + "-" + evidence;
			store.setReasoningModelPref("custom-a", modelId, {mode: "on", profile: "openai", effort: "low", capability: {support, evidence, candidateId: "openai_on_low", resolvedValue: "low", endpointKey: "e", format: "openai_chat", checkedAt: 1}});
			const migrated = store.getReasoningModelPref("custom-a", modelId);
			const derived = deriveReasoningTierState(support, evidence);
			const stored = migrated.controlProfile && migrated.controlProfile.tierStates && Object.values(migrated.controlProfile.tierStates)[0];
			if (stored) assert.equal(stored.state, derived, support + "/" + evidence + " must mean the same thing in both layers");
			else assert.equal(derived, "pending", support + "/" + evidence + " has no verdict to record");
		}
	}
});
