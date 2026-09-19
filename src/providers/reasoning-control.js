// Pure OpenAI-compatible reasoning-control policy. It owns no plugin state and never
// sees credentials or message text: callers pass only engine identity, normalized
// endpoint/model strings and provider error bodies already held at the transport seam.

const REASONING_MODE_AUTO = "auto";
const REASONING_MODE_OFF = "off";
const REASONING_MODE_FOLLOW = "follow";
const REASONING_MODE_ON = "on";
const REASONING_PROFILE_AUTO = "auto";
const REASONING_PROFILES = Object.freeze(["auto", "openai", "deepseek", "qwen", "ollama", "gemini", "anthropic"]);
// The same raw value means different requests under different wire schemas: "low" is
// reasoning_effort for chat, thinkingLevel for Gemini and output_config.effort for an
// adaptive Claude model. The schema id is that wire identity and never reaches a
// user-visible surface. Nine key segments: the legacy eight keep their meaning and the
// schema id is appended, so a record written before it existed can still be found.
const NUL = String.fromCharCode(0);
const REASONING_SUPPORT = Object.freeze(["accepted", "reduced", "unsupported"]);
const REASONING_EVIDENCE = Object.freeze(["none", "confirmed", "contradicted"]);

function freezeCandidate(spec) {
	return Object.freeze(Object.assign({}, spec, {
		extras: Object.freeze(spec.extras),
		fields: Object.freeze(spec.fields.slice()),
		values: Object.freeze((spec.values || []).slice())
	}));
}

const GEMINI_BUDGET_0 = freezeCandidate({profile: "gemini", candidateId: "gemini_budget_0", resolvedValue: "budget=0", extras: {generationConfig: Object.freeze({thinkingConfig: Object.freeze({thinkingBudget: 0})})}, fields: ["thinkingConfig", "thinkingBudget"], values: ["0"], success: "accepted", closesThinking: true, continueOnFieldUnsupported: true, legacy: true});
const GEMINI_BUDGET_MIN = freezeCandidate({profile: "gemini", candidateId: "gemini_budget_min", resolvedValue: "budget=128", extras: {generationConfig: Object.freeze({thinkingConfig: Object.freeze({thinkingBudget: 128})})}, fields: ["thinkingConfig", "thinkingBudget"], values: ["128"], success: "reduced", continueOnFieldUnsupported: true});
const GEMINI_LEVEL_MINIMAL = freezeCandidate({profile: "gemini", candidateId: "gemini_level_minimal", resolvedValue: "level=minimal", extras: {generationConfig: Object.freeze({thinkingConfig: Object.freeze({thinkingLevel: "minimal"})})}, fields: ["thinkingConfig", "thinkingLevel"], values: ["minimal"], success: "reduced"});
const GEMINI_LEVEL_LOW = freezeCandidate({profile: "gemini", candidateId: "gemini_level_low", resolvedValue: "level=low", extras: {generationConfig: Object.freeze({thinkingConfig: Object.freeze({thinkingLevel: "low"})})}, fields: ["thinkingConfig", "thinkingLevel"], values: ["low"], success: "reduced"});
const ANTHROPIC_DISABLED = freezeCandidate({profile: "anthropic", candidateId: "anthropic_disabled", resolvedValue: "thinking=disabled", extras: {thinking: Object.freeze({type: "disabled"})}, fields: ["thinking"], values: ["disabled"], success: "accepted", closesThinking: true, continueOnFieldUnsupported: true, legacy: true});
const ANTHROPIC_ADAPTIVE_LOW = freezeCandidate({profile: "anthropic", candidateId: "anthropic_adaptive_low", resolvedValue: "adaptive=low", extras: {thinking: Object.freeze({type: "adaptive", display: "omitted"}), output_config: Object.freeze({effort: "low"})}, fields: ["thinking", "output_config", "effort"], values: ["adaptive", "low"], success: "reduced"});

const REASONING_PROFILE_CANDIDATES = Object.freeze({
	openai: Object.freeze([
		freezeCandidate({profile: "openai", candidateId: "openai_none", resolvedValue: "none", extras: {reasoning_effort: "none"}, fields: ["reasoning_effort"], values: ["none"], success: "accepted", closesThinking: true, legacy: true}),
		freezeCandidate({profile: "openai", candidateId: "openai_minimal", resolvedValue: "minimal", extras: {reasoning_effort: "minimal"}, fields: ["reasoning_effort"], values: ["minimal"], success: "reduced"}),
		freezeCandidate({profile: "openai", candidateId: "openai_low", resolvedValue: "low", extras: {reasoning_effort: "low"}, fields: ["reasoning_effort"], values: ["low"], success: "reduced", legacy: true})
	]),
	deepseek: Object.freeze([
		freezeCandidate({profile: "deepseek", candidateId: "deepseek_disabled", resolvedValue: "thinking.disabled", extras: {thinking: Object.freeze({type: "disabled"})}, fields: ["thinking"], values: ["disabled"], success: "accepted", closesThinking: true, legacy: true})
	]),
	qwen: Object.freeze([
		freezeCandidate({profile: "qwen", candidateId: "qwen_enable_thinking", resolvedValue: "enable_thinking=false", extras: {enable_thinking: false}, fields: ["enable_thinking"], values: ["false"], success: "accepted", closesThinking: true, continueOnFieldUnsupported: true, legacy: true}),
		freezeCandidate({profile: "qwen", candidateId: "qwen_chat_template", resolvedValue: "chat_template_kwargs.enable_thinking=false", extras: {chat_template_kwargs: Object.freeze({enable_thinking: false})}, fields: ["chat_template_kwargs"], values: ["enable_thinking", "false"], success: "accepted", closesThinking: true})
	]),
	ollama: Object.freeze([
		freezeCandidate({profile: "ollama", candidateId: "ollama_think_false", resolvedValue: "think=false", extras: {think: false}, fields: ["think"], values: ["false"], success: "accepted", closesThinking: true, legacy: true}),
		freezeCandidate({profile: "ollama", candidateId: "ollama_think_low", resolvedValue: "think=low", extras: {think: "low"}, fields: ["think"], values: ["low"], success: "reduced"})
	]),
	gemini: Object.freeze([GEMINI_BUDGET_0, GEMINI_BUDGET_MIN, GEMINI_LEVEL_LOW]),
	anthropic: Object.freeze([ANTHROPIC_DISABLED, ANTHROPIC_ADAPTIVE_LOW])
});

const REASONING_ON_PROFILE_CANDIDATES = Object.freeze({
	deepseek: Object.freeze([
		freezeCandidate({profile: "deepseek", candidateId: "deepseek_enabled", resolvedValue: "thinking.enabled", extras: {thinking: Object.freeze({type: "enabled"})}, fields: ["thinking"], values: ["enabled"], success: "accepted", opensThinking: true})
	]),
	qwen: Object.freeze([
		freezeCandidate({profile: "qwen", candidateId: "qwen_enable_thinking_on", resolvedValue: "enable_thinking=true", extras: {enable_thinking: true}, fields: ["enable_thinking"], values: ["true"], success: "accepted", opensThinking: true, continueOnFieldUnsupported: true}),
		freezeCandidate({profile: "qwen", candidateId: "qwen_chat_template_on", resolvedValue: "chat_template_kwargs.enable_thinking=true", extras: {chat_template_kwargs: Object.freeze({enable_thinking: true})}, fields: ["chat_template_kwargs"], values: ["enable_thinking", "true"], success: "accepted", opensThinking: true})
	])
});

function normalizeReasoningMode(value) {
	return value === REASONING_MODE_OFF ? REASONING_MODE_OFF : REASONING_MODE_AUTO;
}

function normalizeReasoningModelMode(value) {
	if (value === REASONING_MODE_OFF || value === REASONING_MODE_ON) return value;
	return REASONING_MODE_FOLLOW;
}

// The exact value the user chose is what rides the wire. Only an absent value falls
// back, and it falls back to the ladder default rather than to a folded enum: folding
// an unlisted raw to "low" would mean the label no longer names the dispatched value.
function resolveReasoningOnRaw(value, fallback = "low") {
	if (typeof value == "boolean") return value;
	if (typeof value == "number") return Number.isFinite(value) ? value : fallback;
	const trimmed = String(value == null ? "" : value).trim();
	return trimmed || fallback;
}

// Values that mean "no thinking" on one wire or another. Under mode=on they are
// refused locally: a control that reads "thinking on" must never dispatch the field
// value that switches thinking off. The off path sends them deliberately and is
// therefore never checked against this list.
const REASONING_OFF_SENTINELS = Object.freeze([false, 0, "0", "false", "none", "off", "no", "disabled"]);
const REASONING_LEGACY_EFFORTS = Object.freeze(["minimal", "low", "medium", "high"]);

// One verdict vocabulary for the per-value record: what the endpoint did with this
// exact value. The storage layer derives the same states when it migrates an old
// single-value capability record, and the two tables are pinned to each other by test.
function deriveReasoningTierState(support, evidence) {
	if (support === "unsupported") return "rejected";
	if (support === "reduced") return "reduced";
	if (support === "accepted") return evidence === "confirmed" ? "confirmed" : evidence === "contradicted" ? "ignored" : "sent";
	return "pending";
}

function isLegacyReasoningEffort(raw) {
	return typeof raw == "string" && REASONING_LEGACY_EFFORTS.includes(raw);
}

// Typed discriminator: a numeric budget and its spelling are two different tiers, so
// they can never share a row, a verdict or a rejection.
function reasoningRawDiscriminator(raw) {
	return `${typeof raw}:${String(raw)}`;
}

function normalizeReasoningControlDeclaration(declaration) {
	declaration = declaration && typeof declaration == "object" ? declaration : {};
	return {
		controlKind: typeof declaration.controlKind == "string" && declaration.controlKind ? declaration.controlKind : "enum",
		tiers: Array.isArray(declaration.tiers) ? declaration.tiers : [],
		modelTiers: Array.isArray(declaration.modelTiers) ? declaration.modelTiers : [],
		rejected: Array.isArray(declaration.rejected) ? declaration.rejected : [],
		offSentinels: Array.isArray(declaration.offSentinels) ? declaration.offSentinels : [],
		defaultRaw: declaration.defaultRaw,
		custom: declaration.custom && typeof declaration.custom == "object" ? declaration.custom : null
	};
}

function matchesReasoningModelRule(rule, model) {
	if (!rule || !rule.model) return true;
	try {return new RegExp(rule.model, "i").test(String(model || ""));}
	catch (error) {return false;}
}

function getRejectedReasoningRaws(declaration, model) {
	const rejected = [];
	for (const rule of normalizeReasoningControlDeclaration(declaration).rejected) {
		if (!matchesReasoningModelRule(rule, model)) continue;
		for (const raw of Array.isArray(rule.raws) ? rule.raws : []) rejected.push(reasoningRawDiscriminator(raw));
	}
	return rejected;
}

// The tier ladder this format implements for this model, minus the values the model
// officially rejects. This is the fallback when nothing has been saved or observed.
function getReasoningRawTiers(declaration, {model = ""} = {}) {
	const spec = normalizeReasoningControlDeclaration(declaration);
	const override = spec.modelTiers.find(rule => rule.model && matchesReasoningModelRule(rule, model) && Array.isArray(rule.tiers));
	const rejected = getRejectedReasoningRaws(declaration, model);
	return Object.freeze((override ? override.tiers : spec.tiers).filter(raw => !rejected.includes(reasoningRawDiscriminator(raw))));
}

// A local availability verdict: "unsupported" means the model is documented to reject
// this exact raw, so nothing should be dispatched. An unlisted raw is not rejected -
// a gateway may well accept it, and only the provider can say otherwise.
function getReasoningRawAvailability(declaration, {model = "", raw, mode = "on"} = {}) {
	const discriminator = reasoningRawDiscriminator(raw);
	if (mode === "on") {
		const sentinels = REASONING_OFF_SENTINELS.concat(normalizeReasoningControlDeclaration(declaration).offSentinels);
		if (sentinels.some(sentinel => reasoningRawDiscriminator(sentinel) === discriminator)) return "unsupported";
	}
	return getRejectedReasoningRaws(declaration, model).includes(discriminator) ? "unsupported" : "supported";
}

// The value this format falls back to for this model: what an older build dispatched
// when the stored enum word could not be expressed on this wire.
function getReasoningDefaultRaw(declaration, {model = ""} = {}) {
	const spec = normalizeReasoningControlDeclaration(declaration);
	const override = spec.modelTiers.find(rule => rule.model && matchesReasoningModelRule(rule, model));
	const declared = override && override.defaultRaw !== undefined ? override.defaultRaw : spec.defaultRaw;
	if (declared !== undefined && declared !== null) return declared;
	const tiers = getReasoningRawTiers(declaration, {model});
	return tiers.length ? tiers[0] : "low";
}

// A record written before exact raws existed only records which legacy enum word was
// chosen. What the old build actually sent for that word is what we keep sending, so
// an upgrade never turns a working configuration into a refused one.
function reconcileLegacyReasoningRaw(declaration, {model = "", raw} = {}) {
	if (!declaration) return raw;
	const tiers = getReasoningRawTiers(declaration, {model});
	if (!tiers.length) return raw;
	const discriminator = reasoningRawDiscriminator(raw);
	if (tiers.some(tier => reasoningRawDiscriminator(tier) === discriminator)) return raw;
	return getReasoningDefaultRaw(declaration, {model});
}

// Three sources, in this order: the declared ladder, the exact raw already saved, and
// any raw a verdict was recorded for. Deduped by typed discriminator, so nothing the
// user picked can disappear and nothing gets merged into a neighbouring tier.
function buildReasoningTierOptions(declaration, {model = "", savedRaw = null, evidenceRaws = [], tierStates = {}, createRawKey = null, mode = "on"} = {}) {
	const spec = normalizeReasoningControlDeclaration(declaration);
	const rawKeyOf = typeof createRawKey == "function" ? createRawKey : () => "";
	const states = tierStates && typeof tierStates == "object" ? tierStates : {};
	const savedDiscriminator = savedRaw === null || savedRaw === undefined || savedRaw === "" ? null : reasoningRawDiscriminator(savedRaw);
	const seen = new Set();
	const options = [];
	const push = raw => {
		if (raw === null || raw === undefined || raw === "") return;
		const discriminator = reasoningRawDiscriminator(raw);
		if (seen.has(discriminator)) return;
		const availability = getReasoningRawAvailability(declaration, {model, raw, mode});
		// A raw this model is documented to reject earns a menu row only while it is
		// still the saved choice: there it explains itself and asks to be replaced.
		// Once the user moves off it, a dead option would just be noise.
		if (availability === "unsupported" && discriminator !== savedDiscriminator) return;
		seen.add(discriminator);
		const rawKey = rawKeyOf(raw);
		const recorded = rawKey && states[rawKey] && typeof states[rawKey].state == "string" ? states[rawKey].state : "";
		options.push(Object.freeze({raw, rawKey, state: recorded || "pending", availability}));
	};
	for (const raw of getReasoningRawTiers(declaration, {model})) push(raw);
	push(savedRaw);
	for (const raw of Array.isArray(evidenceRaws) ? evidenceRaws : []) push(raw);
	// Custom is always last and exists only where the adapter declares it.
	if (spec.custom) options.push(Object.freeze(Object.assign({custom: true}, spec.custom)));
	return Object.freeze(options);
}

function normalizeReasoningProfile(value) {
	return REASONING_PROFILES.includes(value) ? value : REASONING_PROFILE_AUTO;
}

function inferReasoningProfile({endpoint = "", model = ""} = {}) {
	const fingerprint = `${endpoint} ${model}`.toLowerCase();
	if (/deepseek/.test(fingerprint)) return "deepseek";
	if (/qwen|dashscope|aliyun|model[ -]?studio/.test(fingerprint)) return "qwen";
	return "openai";
}

function getReasoningProfileCandidates(profile, {mode = REASONING_MODE_OFF, effort = "low", model = ""} = {}) {
	profile = normalizeReasoningProfile(profile);
	mode = normalizeReasoningModelMode(mode);
	if (mode === REASONING_MODE_FOLLOW) return Object.freeze([]);
	if (mode === REASONING_MODE_ON) {
		if (profile === "openai") {
			const raw = resolveReasoningOnRaw(effort);
			const value = String(raw);
			return Object.freeze([freezeCandidate({profile: "openai", candidateId: `openai_on_${value}`, resolvedValue: value, extras: {reasoning_effort: raw}, fields: ["reasoning_effort"], values: [value], success: "accepted", opensThinking: true, requestedRaw: raw})]);
		}
		if (profile === "ollama") {
			const gptOss = /gpt[-_ ]?oss/i.test(String(model || ""));
			const raw = resolveReasoningOnRaw(effort, true);
			// think is an enum on GPT-OSS and a boolean everywhere else, so the raw is used
			// where the field can express it and the declared tier where it cannot.
			const think = gptOss ? typeof raw == "boolean" ? "low" : raw : typeof raw == "boolean" ? raw : true;
			const value = String(think);
			return Object.freeze([freezeCandidate({profile: "ollama", candidateId: `ollama_on_${value}`, resolvedValue: `think=${value}`, extras: {think}, fields: ["think"], values: [value], success: "accepted", opensThinking: true, requestedRaw: raw})]);
		}
		if (profile === "gemini") {
			const modelName = String(model || "").toLowerCase();
			if (/gemini-3/.test(modelName)) {
				const raw = resolveReasoningOnRaw(effort);
				const value = String(raw);
				return Object.freeze([freezeCandidate({profile: "gemini", candidateId: `gemini_on_level_${value}`, resolvedValue: `level=${value}`, extras: {generationConfig: Object.freeze({thinkingConfig: Object.freeze({thinkingLevel: raw})})}, fields: ["thinkingConfig", "thinkingLevel"], values: [value], success: "accepted", opensThinking: true, requestedRaw: raw})]);
			}
			// 2.5 has no level field: an exact budget number is sent as itself, anything else
			// means the declared dynamic budget.
			const budget = typeof resolveReasoningOnRaw(effort, -1) == "number" ? resolveReasoningOnRaw(effort, -1) : -1;
			return Object.freeze([freezeCandidate({profile: "gemini", candidateId: budget === -1 ? "gemini_on_dynamic_budget" : `gemini_on_budget_${budget}`, resolvedValue: `budget=${budget}`, extras: {generationConfig: Object.freeze({thinkingConfig: Object.freeze({thinkingBudget: budget})})}, fields: ["thinkingConfig", "thinkingBudget"], values: [String(budget)], success: "accepted", opensThinking: true, requestedRaw: resolveReasoningOnRaw(effort, -1)})]);
		}
		if (profile === "anthropic") {
			const modelName = String(model || "").toLowerCase();
			const raw = resolveReasoningOnRaw(effort);
			const value = String(raw);
			const adaptive = /(?:fable|mythos)|claude-(?:opus|sonnet)-4-[6-9]|claude-(?:opus|sonnet)-5/.test(modelName);
			// heuristic effort to budget table, not an official mapping
			const budgetByEffort = {low: 1024, medium: 4096, high: 16384};
			const adaptiveCandidate = () => freezeCandidate({profile: "anthropic", candidateId: `anthropic_on_adaptive_${value}`, resolvedValue: `adaptive=${value}`, extras: {thinking: Object.freeze({type: "adaptive", display: "omitted"}), output_config: Object.freeze({effort: raw})}, fields: ["thinking", "output_config", "effort"], values: ["adaptive", value], success: "accepted", opensThinking: true, continueOnFieldUnsupported: true, requestedRaw: raw});
			// the budget schema can only carry a number: an exact numeric raw rides as
			// itself, the three mapped words use the table, and anything else has no budget
			// form at all rather than being folded into a neighbouring tier.
			const budget = typeof raw == "number" ? raw : budgetByEffort[value] || null;
			const budgetCandidate = () => freezeCandidate({profile: "anthropic", candidateId: `anthropic_on_budget_${budget}`, resolvedValue: `budget=${budget}`, extras: {thinking: Object.freeze({type: "enabled", budget_tokens: budget, display: "omitted"})}, fields: ["thinking", "budget_tokens"], values: ["enabled", String(budget)], success: "accepted", opensThinking: true, requestedRaw: raw});
			if (adaptive || budget === null) return Object.freeze([adaptiveCandidate()]);
			if (/claude-(?:opus|sonnet|haiku)-4-[0-5]/.test(modelName)) return Object.freeze([budgetCandidate()]);
			return Object.freeze([adaptiveCandidate(), budgetCandidate()]);
		}
		const requestedRaw = resolveReasoningOnRaw(effort);
		return Object.freeze((REASONING_ON_PROFILE_CANDIDATES[profile] || []).map(candidate => freezeCandidate(Object.assign({}, candidate, {requestedRaw}))));
	}
	let candidates = null;
	if (profile === "ollama" && /gpt[-_ ]?oss/i.test(String(model || ""))) candidates = [...REASONING_PROFILE_CANDIDATES.ollama].reverse();
	if (profile === "gemini") {
		const modelName = String(model || "").toLowerCase();
		if (/gemini-3/.test(modelName)) candidates = /\bpro\b/.test(modelName) ? [GEMINI_LEVEL_LOW] : [GEMINI_LEVEL_MINIMAL, GEMINI_LEVEL_LOW];
		else if (/gemini-2\.5|2\.5-(?:flash|pro)/.test(modelName)) candidates = [GEMINI_BUDGET_0, GEMINI_BUDGET_MIN];
	}
	if (profile === "anthropic" && /(?:fable|mythos)/.test(String(model || "").toLowerCase())) candidates = [ANTHROPIC_ADAPTIVE_LOW];
	if (!candidates) candidates = REASONING_PROFILE_CANDIDATES[profile] || [];
	// "Off" is strict: a smaller budget or a low effort still thinks. Such a value
	// is never an equivalent fallback for a control that promises thinking is closed.
	return Object.freeze(candidates.filter(candidate => candidate.closesThinking === true));
}

// Rewrites may change only the spelling/schema of the same request. In particular,
// "off" never advances to a value that merely reduces thinking, and "on" never
// advances to a candidate bound to a neighbouring raw strength.
function isEquivalentReasoningCandidate(candidate, {mode = REASONING_MODE_FOLLOW, raw = null} = {}) {
	mode = normalizeReasoningModelMode(mode);
	if (!candidate || mode === REASONING_MODE_FOLLOW) return false;
	if (mode === REASONING_MODE_OFF) return candidate.closesThinking === true;
	return candidate.opensThinking === true && reasoningRawDiscriminator(candidate.requestedRaw) === reasoningRawDiscriminator(resolveReasoningOnRaw(raw));
}

function getReasoningProfileSpec(profile, candidateId = null, options = {}) {
	const candidates = getReasoningProfileCandidates(profile, options);
	if (candidateId) return candidates.find(candidate => candidate.candidateId === candidateId) || null;
	const legacy = candidates.find(candidate => candidate.legacy) || null;
	if (!legacy) return null;
	return {profile: legacy.profile, extras: legacy.extras, fields: [...legacy.fields], success: legacy.success};
}

function createReasoningSchemaId({format = "", fieldPath = "", spec = null, version = 1} = {}) {
	const path = String(fieldPath || spec && Array.isArray(spec.fields) && spec.fields.join("+") || "").trim();
	if (!format || !path) return "";
	return format + "/" + path + "/v" + Math.max(1, Number(version) || 1);
}

function buildReasoningKeySegments({engineKey = "", endpoint = "", model = "", profile = "auto", mode = "follow", effort = "low", resolvedValue = "", format = "openai_chat", rawKey = ""} = {}) {
	return [engineKey, endpoint, model, format, normalizeReasoningProfile(profile), normalizeReasoningModelMode(mode), effort, rawKey || resolvedValue].map(value => String(value || ""));
}

function createReasoningCapabilityKey(options = {}) {
	return buildReasoningKeySegments(options).concat([String(options && options.schemaId || "")]).join(NUL);
}

function createLegacyReasoningCapabilityKey(options = {}) {
	return buildReasoningKeySegments(options).join(NUL);
}

function createReasoningCapabilityCache({capacity = 20, now = Date.now} = {}) {
	capacity = Math.max(1, Math.min(100, Number(capacity) || 20));
	const entries = new Map();
	const normalizeSupport = support => REASONING_SUPPORT.includes(support) ? support : null;
	const normalizeEvidence = evidence => REASONING_EVIDENCE.includes(evidence) ? evidence : "none";

	function get(key) {
		if (!entries.has(key)) return null;
		const value = entries.get(key);
		entries.delete(key);
		entries.set(key, value);
		return value;
	}

	function set(key, support, details = {}) {
		support = normalizeSupport(support);
		if (!key || !support) return null;
		if (entries.has(key)) entries.delete(key);
		const valueData = {
			support,
			candidateId: typeof details.candidateId == "string" && details.candidateId ? details.candidateId : null,
			resolvedValue: typeof details.resolvedValue == "string" && details.resolvedValue ? details.resolvedValue : null,
			evidence: normalizeEvidence(details.evidence),
			checkedAt: now()
		};
		if (typeof details.format == "string" && details.format) valueData.format = details.format;
		const value = Object.freeze(valueData);
		entries.set(key, value);
		while (entries.size > capacity) entries.delete(entries.keys().next().value);
		return value;
	}

	function deleteEngine(engineKey) {
		const prefix = `${String(engineKey || "")}\u0000`;
		let removed = 0;
		for (const key of [...entries.keys()]) if (key.startsWith(prefix)) {entries.delete(key); removed++;}
		return removed;
	}

	return Object.freeze({
		get,
		set,
		delete: key => entries.delete(key),
		deleteEngine,
		clear: () => entries.clear(),
		size: () => entries.size,
		keys: () => [...entries.keys()]
	});
}

function stringifyReasoningErrorBody(body) {
	if (!body) return "";
	try {return (typeof body == "string" ? body : JSON.stringify(body)).slice(0, 12000).toLowerCase();}
	catch (error) {return "";}
}

function mentionsReasoningToken(text, token) {
	const escaped = String(token || "").toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return !!escaped && new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(text);
}

function isUnsupportedReasoningFieldError(statusCode, body, fields = []) {
	if (statusCode !== 400 && statusCode !== 422 || !body || !fields.length) return false;
	const text = stringifyReasoningErrorBody(body);
	const unsupported = /unknown\s+(?:name|parameter|field|argument)|unrecognized(?:\s+request)?\s+(?:parameter|field|argument)|unsupported\s+(?:parameter|field|argument)|not\s+supported|extra inputs are not permitted|extra_forbidden|unexpected keyword argument|additional propert(?:y|ies).*(?:not allowed|forbidden)/i.test(text);
	if (!unsupported) return false;
	return fields.some(field => mentionsReasoningToken(text, field));
}

function isUnsupportedReasoningValueError(statusCode, body, spec) {
	if ((statusCode !== 400 && statusCode !== 422) || !spec) return false;
	const text = stringifyReasoningErrorBody(body);
	if (!text) return false;
	const invalidValue = /invalid\s+(?:value|enum)|unsupported\s+value|must\s+be\s+one\s+of|not\s+(?:a\s+)?valid(?:\s+(?:value|enum))?|value\s+is\s+not\s+permitted|must\s+be\s+true/i.test(text);
	if (!invalidValue) return false;
	return [...(spec.fields || []), ...(spec.values || [])].some(token => mentionsReasoningToken(text, token));
}

module.exports = {
	REASONING_MODE_AUTO,
	REASONING_MODE_OFF,
	REASONING_MODE_FOLLOW,
	REASONING_MODE_ON,
	REASONING_PROFILE_AUTO,
	REASONING_PROFILES,
	normalizeReasoningMode,
	normalizeReasoningModelMode,
	resolveReasoningOnRaw,
	getReasoningRawTiers,
	getReasoningRawAvailability,
	getReasoningDefaultRaw,
	reconcileLegacyReasoningRaw,
	isLegacyReasoningEffort,
	deriveReasoningTierState,
	buildReasoningTierOptions,
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
};
