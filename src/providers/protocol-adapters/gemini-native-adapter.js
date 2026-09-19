// Pure Gemini generateContent adapter for custom providers. The official Gemini
// engine remains separate; this adapter receives all environment policy by input.

const GEMINI_REASONING_FAMILIES = Object.freeze(["gemini"]);
// 3.x takes a thinkingLevel word, 2.5 takes a thinkingBudget number, and Pro does
// not accept the cheapest level at all. The rejection is declared, never rewritten.
const GEMINI_REASONING_CONTROL = Object.freeze({
	controlKind: "enum_or_number",
	tiers: Object.freeze(["minimal", "low", "medium", "high"]),
	defaultRaw: "low",
	modelTiers: Object.freeze([Object.freeze({model: "gemini-2\\.5|2\\.5-(?:flash|pro)", tiers: Object.freeze([-1]), defaultRaw: -1})]),
	rejected: Object.freeze([Object.freeze({model: "\\bpro\\b", raws: Object.freeze(["minimal"])})]),
	custom: Object.freeze({kind: "number", min: 0, max: 32768})
});
const GEMINI_UI = Object.freeze({labelKey: "api_format_gemini_native", credentialPlaceholderKey: "api_key_gemini_placeholder"});
const GEMINI_CAPABILITIES = Object.freeze({single: true, batch: true, validation: true, catalog: true, errorClassification: true});

function createGeminiNativeAdapter({normalizeEndpoint, getCatalogEndpoint, parseBatch} = {}) {
	if (typeof normalizeEndpoint != "function" || typeof getCatalogEndpoint != "function" || typeof parseBatch != "function") throw new TypeError("Gemini adapter requires endpoint and batch helpers");
	const parseBody = body => {
		try {return typeof body == "string" ? JSON.parse(body) : body || null;}
		catch (error) {return null;}
	};
	const buildHeaders = (apiKey, contentType = true) => Object.assign(contentType ? {"Content-Type": "application/json"} : {}, {"x-goog-api-key": String(apiKey || "").trim()});
	const buildRequest = ({endpoint, apiKey, model, systemPrompt, userPrompt, temperature, topP = null, maxTokens = null}) => {
		const generationConfig = {temperature};
		if (topP != null) generationConfig.topP = topP;
		if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) generationConfig.maxOutputTokens = Math.floor(Number(maxTokens));
		const modelId = String(model || "").trim().replace(/^models\//, "");
		return {
			url: `${normalizeEndpoint(endpoint)}/${encodeURIComponent(modelId)}:generateContent`,
			requestOptions: {method: "post", headers: buildHeaders(apiKey)},
			payload: {system_instruction: {parts: [{text: systemPrompt}]}, contents: [{role: "user", parts: [{text: userPrompt}]}], generationConfig}
		};
	};
	return Object.freeze({
		id: "gemini_native",
		version: 1,
		uiReady: true,
		ui: GEMINI_UI,
		capabilities: GEMINI_CAPABILITIES,
		credentialPolicy: "required",
		catalogDistinctive: true,
		reasoningFamilies: GEMINI_REASONING_FAMILIES,
		reasoningControl: GEMINI_REASONING_CONTROL,
		supportedEfforts: Object.freeze(["minimal", "low", "medium", "high"]),
		normalizeEndpoint,
		getCatalogEndpoint,
		getReasoningWireSpec(spec) {
			if (!spec || spec.profile !== "gemini") return null;
			return Object.freeze({patch: spec.extras || {}, fields: [...(spec.fields || [])], values: [...(spec.values || [])]});
		},
		applyReasoning(payload, wireSpec) {
			if (!wireSpec) return payload;
			const patch = wireSpec.patch || {};
			return Object.assign({}, payload, {generationConfig: Object.assign({}, payload.generationConfig || {}, patch.generationConfig || {})});
		},
		buildSingleRequest(options) {return buildRequest(Object.assign({}, options, {temperature: 0.2, topP: 0.8}));},
		buildValidationRequest(options) {return buildRequest(Object.assign({}, options, {temperature: 0, topP: null}));},
		buildBatchRequest(options) {
			const request = buildRequest(Object.assign({}, options, {temperature: 0.1, topP: 0.8}));
			if (options.jsonObject === true) {
				request.payload.generationConfig.responseMimeType = "application/json";
				// Keep the existing shape stable across batches. The native responseSchema
				// field also works on gateways that accept but ignore responseJsonSchema.
				request.payload.generationConfig.responseSchema = {
					type: "object",
					properties: {messages: {type: "array", items: {
						type: "object",
						properties: {
							id: {type: "string"},
							segments: {type: "array", items: {type: "object", properties: {id: {type: "string"}, translation: {type: "string"}}, required: ["id", "translation"]}}
						},
						required: ["id", "segments"]
					}}},
					required: ["messages"]
				};
			}
			return request;
		},
		buildCatalogRequest({endpoint, apiKey}) {return {url: getCatalogEndpoint(normalizeEndpoint(endpoint)), requestOptions: {method: "get", headers: buildHeaders(apiKey, false)}};},
		parseText(body) {
			const parsed = parseBody(body);
			return ((parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts) || []).map(part => part && typeof part.text == "string" ? part.text : "").join("").trim();
		},
		parseUsage(body) {
			const parsed = parseBody(body);
			const usage = parsed && parsed.usageMetadata;
			if (!usage) return null;
			const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
			const promptTokens = numberOrNull(usage.promptTokenCount);
			const completionTokens = numberOrNull(usage.candidatesTokenCount);
			const reasoningTokens = numberOrNull(usage.thoughtsTokenCount);
			if (promptTokens == null && completionTokens == null && reasoningTokens == null) return null;
			return Object.freeze({promptTokens, completionTokens, reasoningTokens});
		},
		parseBatch,
		parseCatalog(body) {
			const parsed = parseBody(body);
			return ((parsed && parsed.models) || []).filter(item => !item || !Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes("generateContent")).map(item => item && item.name && item.name.replace(/^models\//, "")).filter(Boolean);
		},
		isCatalogResponse(body) {
			const parsed = parseBody(body);
			return !!(parsed && Array.isArray(parsed.models) && parsed.models.some(item => item && (typeof item.name == "string" && item.name.startsWith("models/") || Array.isArray(item.supportedGenerationMethods))));
		},
		getReasoningEvidence(body, spec) {
			if (!spec || !spec.closesThinking && !spec.opensThinking) return null;
			const parsed = parseBody(body);
			const usage = parsed && parsed.usageMetadata;
			if (!usage || typeof usage != "object") return "none";
			// Gemini omits thoughtsTokenCount when zero, so an existing usage block with
			// no field is affirmative zero evidence rather than missing telemetry.
			const thoughts = Number.isFinite(Number(usage.thoughtsTokenCount)) ? Math.max(0, Number(usage.thoughtsTokenCount)) : 0;
			if (spec.opensThinking) return thoughts > 0 ? "confirmed" : "none";
			return thoughts > 0 ? "contradicted" : "confirmed";
		}
	});
}

module.exports = {createGeminiNativeAdapter};
