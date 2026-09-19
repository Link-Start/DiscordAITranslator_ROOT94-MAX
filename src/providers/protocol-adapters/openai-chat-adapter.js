// Pure OpenAI Chat Completions wire-format adapter for custom providers.
// All environment-specific normalization and parsing helpers are injected so this
// module owns no settings, credentials, clocks, queues or plugin state.

// What the thinking control looks like on this wire: which exact raw values the
// format implements, which ones a given model officially rejects, and whether the
// user may type one of their own. Availability is declared here so nothing has to
// be rewritten behind the user's back further down.
const OPENAI_CHAT_REASONING_CONTROL = Object.freeze({
	controlKind: "enum",
	tiers: Object.freeze(["minimal", "low", "medium", "high"]),
	defaultRaw: "low",
	// Documented per-generation ladders (OpenAI reasoning guide): GPT-5.6 and later
	// add max; GPT-5.1-codex-max and the 5.2-5.5 line add xhigh; plain GPT-5.1
	// dropped minimal (its floor moved into the off value "none"); gpt-5-pro only
	// accepts high. Anything unmatched keeps the original GPT-5 ladder above.
	modelTiers: Object.freeze([
		Object.freeze({model: "gpt-5\\.[6-9]|gpt-[6-9]", tiers: Object.freeze(["low", "medium", "high", "xhigh", "max"])}),
		Object.freeze({model: "codex-max|gpt-5\\.[2-5]", tiers: Object.freeze(["low", "medium", "high", "xhigh"])}),
		Object.freeze({model: "gpt-5\\.1", tiers: Object.freeze(["low", "medium", "high"])}),
		Object.freeze({model: "gpt-5-pro", tiers: Object.freeze(["high"]), defaultRaw: "high"})
	]),
	// 5.1 dropped minimal by documentation, so a stored minimal on these models is a
	// known local rejection: the UI says "pick another strength" instead of billing a
	// request that returns HTTP 400.
	rejected: Object.freeze([Object.freeze({model: "gpt-5\\.[1-9]|gpt-[6-9]", raws: Object.freeze(["minimal"])})]),
	offSentinels: Object.freeze(["none"]),
	custom: Object.freeze({kind: "enum"})
});
const OPENAI_CHAT_REASONING_FAMILIES = Object.freeze(["openai", "deepseek", "qwen"]);
const OPENAI_CHAT_UI = Object.freeze({labelKey: "api_format_openai_chat"});
const OPENAI_CHAT_CAPABILITIES = Object.freeze({single: true, batch: true, validation: true, catalog: true, errorClassification: true});

function batchJsonFormat(model) {
	// These Flash families passed actual Chat schema-enforcement probes. Unknown
	// models (including JSON-only providers) retain the established JSON mode.
	if (!/^gemini-3\.[67]-flash(?:-|$)/i.test(String(model || ""))) return {type: "json_object"};
	return {type: "json_schema", json_schema: {name: "translation_batch", strict: true, schema: {
		type: "object",
		properties: {messages: {type: "array", items: {
			type: "object",
			properties: {
				id: {type: "string"},
				segments: {type: "array", items: {type: "object", properties: {id: {type: "string"}, translation: {type: "string"}}, required: ["id", "translation"], additionalProperties: false}}
			},
			required: ["id", "segments"], additionalProperties: false
		}}},
		required: ["messages"], additionalProperties: false
	}}};
}

function createOpenAiChatAdapter({
	normalizeEndpoint,
	getCatalogEndpoint,
	parseText,
	parseUsage,
	parseBatch
} = {}) {
	if (typeof normalizeEndpoint != "function" || typeof getCatalogEndpoint != "function" || typeof parseText != "function" || typeof parseUsage != "function" || typeof parseBatch != "function") {
		throw new TypeError("OpenAI Chat adapter requires endpoint and response helpers");
	}

	const buildHeaders = apiKey => ({"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`});
	const buildRequest = ({endpoint, apiKey, payload}) => ({
		url: normalizeEndpoint(endpoint),
		requestOptions: {method: "post", headers: buildHeaders(apiKey)},
		payload
	});

	return Object.freeze({
		id: "openai_chat",
		version: 1,
		uiReady: true,
		ui: OPENAI_CHAT_UI,
		capabilities: OPENAI_CHAT_CAPABILITIES,
		credentialPolicy: "required",
		catalogDistinctive: false,
		reasoningFamilies: OPENAI_CHAT_REASONING_FAMILIES,
		reasoningControl: OPENAI_CHAT_REASONING_CONTROL,
		normalizeEndpoint,
		getCatalogEndpoint,
		getReasoningWireSpec(spec) {
			if (!spec || !OPENAI_CHAT_REASONING_FAMILIES.includes(spec.profile)) return null;
			return Object.freeze({patch: spec.extras || {}, fields: [...(spec.fields || [])], values: [...(spec.values || [])]});
		},
		applyReasoning(payload, wireSpec) {
			return wireSpec ? Object.assign({}, payload, wireSpec.patch) : payload;
		},
		buildSingleRequest({endpoint, apiKey, model, systemPrompt, userPrompt}) {
			return buildRequest({endpoint, apiKey, payload: {
				model,
				messages: [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}],
				temperature: 0.2,
				top_p: 0.8
			}});
		},
		buildValidationRequest({endpoint, apiKey, model, systemPrompt, userPrompt, maxTokens}) {
			return buildRequest({endpoint, apiKey, payload: {
				model,
				messages: [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}],
				temperature: 0,
				max_tokens: maxTokens
			}});
		},
		buildBatchRequest({endpoint, apiKey, model, systemPrompt, userPrompt, jsonObject = false}) {
			return buildRequest({endpoint, apiKey, payload: {
				model,
				messages: [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}],
				temperature: 0.1,
				top_p: 0.8,
				...(jsonObject === true ? {response_format: batchJsonFormat(model)} : {})
			}});
		},
		buildCatalogRequest({endpoint, apiKey}) {
			return {
				url: getCatalogEndpoint(endpoint),
				requestOptions: {method: "get", headers: buildHeaders(apiKey)}
			};
		},
		parseText,
		parseUsage,
		parseBatch,
		getReasoningEvidence: () => null,
		parseCatalog(body) {
			try {body = typeof body == "string" ? JSON.parse(body) : body;}
			catch (error) {return [];}
			return ((body && body.data) || []).map(item => typeof item == "string" ? item : item && item.id).filter(item => typeof item == "string" && item.trim());
		}
	});
}

module.exports = {createOpenAiChatAdapter};
