// Pure Ollama /api/chat transport adapter. Endpoint policy, batching parser and
// plugin state are injected or owned by callers; this module only shapes wires.

// think is a boolean on ordinary thinking models and an enum on the GPT-OSS family,
// so the control has two declared shapes rather than one folded enum.
const OLLAMA_REASONING_CONTROL = Object.freeze({
	controlKind: "bool_or_enum",
	tiers: Object.freeze([true]),
	defaultRaw: true,
	modelTiers: Object.freeze([Object.freeze({model: "gpt[-_ ]?oss", tiers: Object.freeze(["low", "medium", "high"]), defaultRaw: "low"})]),
	custom: null
});
const OLLAMA_REASONING_FAMILIES = Object.freeze(["ollama"]);
const OLLAMA_UI = Object.freeze({labelKey: "api_format_ollama_native"});
const OLLAMA_CAPABILITIES = Object.freeze({single: true, batch: true, validation: true, catalog: true, errorClassification: true});

function createOllamaNativeAdapter({normalizeEndpoint, getCatalogEndpoint, parseBatch} = {}) {
	if (typeof normalizeEndpoint != "function" || typeof getCatalogEndpoint != "function" || typeof parseBatch != "function") throw new TypeError("Ollama adapter requires endpoint and batch helpers");
	const parseBody = body => {
		try {return typeof body == "string" ? JSON.parse(body) : body || null;}
		catch (error) {return null;}
	};
	const buildHeaders = (apiKey, contentType = true) => {
		const headers = {};
		if (contentType) headers["Content-Type"] = "application/json";
		if (String(apiKey || "").trim()) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
		return headers;
	};
	const buildRequest = ({endpoint, apiKey, model, systemPrompt, userPrompt, temperature, topP = null, maxTokens = null}) => {
		const options = {temperature};
		if (topP != null) options.top_p = topP;
		if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) options.num_predict = Math.floor(Number(maxTokens));
		return {
			url: normalizeEndpoint(endpoint),
			requestOptions: {method: "post", headers: buildHeaders(apiKey)},
			payload: {model, messages: [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}], stream: false, options}
		};
	};
	return Object.freeze({
		id: "ollama_native",
		version: 1,
		uiReady: true,
		ui: OLLAMA_UI,
		capabilities: OLLAMA_CAPABILITIES,
		credentialPolicy: "optional",
		apiKeyOptional: true,
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		catalogDistinctive: true,
		reasoningFamilies: OLLAMA_REASONING_FAMILIES,
		reasoningControl: OLLAMA_REASONING_CONTROL,
		normalizeEndpoint,
		getCatalogEndpoint,
		getReasoningWireSpec(spec) {
			if (!spec || spec.profile !== "ollama") return null;
			return Object.freeze({patch: spec.extras || {}, fields: [...(spec.fields || [])], values: [...(spec.values || [])]});
		},
		applyReasoning(payload, wireSpec) {return wireSpec ? Object.assign({}, payload, wireSpec.patch) : payload;},
		buildSingleRequest(options) {return buildRequest(Object.assign({}, options, {temperature: 0.2, topP: 0.8}));},
		buildValidationRequest(options) {return buildRequest(Object.assign({}, options, {temperature: 0, topP: null}));},
		buildBatchRequest(options) {
			const request = buildRequest(Object.assign({}, options, {temperature: 0.1, topP: 0.8}));
			if (options.jsonObject === true) request.payload.format = "json";
			return request;
		},
		buildCatalogRequest({endpoint, apiKey}) {return {url: getCatalogEndpoint(normalizeEndpoint(endpoint)), requestOptions: {method: "get", headers: buildHeaders(apiKey, false)}};},
		parseText(body) {
			const parsed = parseBody(body);
			const text = parsed && parsed.message && parsed.message.content != null ? parsed.message.content : parsed && parsed.response;
			return typeof text == "string" ? text.trim() : "";
		},
		parseUsage(body) {
			const parsed = parseBody(body);
			if (!parsed) return null;
			const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
			const promptTokens = numberOrNull(parsed.prompt_eval_count);
			const completionTokens = numberOrNull(parsed.eval_count);
			if (promptTokens == null && completionTokens == null) return null;
			return Object.freeze({promptTokens, completionTokens, reasoningTokens: null});
		},
		parseBatch,
		parseCatalog(body) {
			const parsed = parseBody(body);
			return ((parsed && parsed.models) || []).map(item => item && (item.name || item.model)).filter(item => typeof item == "string" && item.trim());
		},
		isCatalogResponse(body) {
			const parsed = parseBody(body);
			return !!(parsed && Array.isArray(parsed.models) && parsed.models.some(item => item && (typeof item.model == "string" || typeof item.modified_at == "string")));
		},
		getReasoningEvidence(body, spec) {
			if (!spec || !spec.closesThinking && !spec.opensThinking) return null;
			const parsed = parseBody(body);
			const message = parsed && parsed.message;
			if (!message || !Object.prototype.hasOwnProperty.call(message, "thinking")) return "none";
			const hasThinking = typeof message.thinking == "string" && !!message.thinking.trim();
			if (spec.opensThinking) return hasThinking ? "confirmed" : "contradicted";
			return hasThinking ? "contradicted" : "confirmed";
		}
	});
}

module.exports = {createOllamaNativeAdapter};
