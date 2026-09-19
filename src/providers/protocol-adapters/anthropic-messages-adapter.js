// Pure Anthropic Messages transport. The adapter filters thinking blocks from
// translated text and owns the required version header, but no plugin state.

const ANTHROPIC_REASONING_FAMILIES = Object.freeze(["anthropic"]);
// Messages has no minimal tier in any generation: adaptive takes low|medium|high and
// enabled takes a token budget. Both facts are declarations, not local rewrites.
const ANTHROPIC_REASONING_CONTROL = Object.freeze({
	controlKind: "enum_or_number",
	tiers: Object.freeze(["low", "medium", "high"]),
	defaultRaw: "low",
	offSentinels: Object.freeze(["disabled"]),
	rejected: Object.freeze([Object.freeze({raws: Object.freeze(["minimal"])})]),
	custom: Object.freeze({kind: "number", min: 1024, max: 32768})
});
const ANTHROPIC_UI = Object.freeze({labelKey: "api_format_anthropic_messages", credentialPlaceholderKey: "api_key_anthropic_placeholder"});
const ANTHROPIC_CAPABILITIES = Object.freeze({single: true, batch: true, validation: true, catalog: true, errorClassification: true});
// Older Claude models and unknown aliases may reject structured output fields.
const ANTHROPIC_JSON_MODELS = /(?:^|\/)claude-(?:opus-(?:4[.-][5-8]|5)|sonnet-(?:4[.-][56]|5)|haiku-4[.-]5|(?:fable|mythos)-5(?:[.-]1)?|mythos-preview)(?=$|[-:@])/i;

function createAnthropicMessagesAdapter({normalizeEndpoint, getCatalogEndpoint, parseBatch} = {}) {
	if (typeof normalizeEndpoint != "function" || typeof getCatalogEndpoint != "function" || typeof parseBatch != "function") throw new TypeError("Anthropic adapter requires endpoint and batch helpers");
	const parseBody = body => {
		try {return typeof body == "string" ? JSON.parse(body) : body || null;}
		catch (error) {return null;}
	};
	const buildHeaders = (apiKey, contentType = true) => Object.assign(contentType ? {"Content-Type": "application/json"} : {}, {"x-api-key": String(apiKey || "").trim(), "anthropic-version": "2023-06-01"});
	const buildRequest = ({endpoint, apiKey, model, systemPrompt, userPrompt, maxTokens = 4096, temperature}) => ({
		url: normalizeEndpoint(endpoint),
		requestOptions: {method: "post", headers: buildHeaders(apiKey)},
		payload: {model, system: systemPrompt, messages: [{role: "user", content: userPrompt}], max_tokens: Math.max(1, Math.floor(Number(maxTokens) || 4096)), temperature, stream: false}
	});
	return Object.freeze({
		id: "anthropic_messages",
		version: 1,
		uiReady: true,
		ui: ANTHROPIC_UI,
		capabilities: ANTHROPIC_CAPABILITIES,
		credentialPolicy: "required",
		catalogDistinctive: true,
		reasoningFamilies: ANTHROPIC_REASONING_FAMILIES,
		reasoningControl: ANTHROPIC_REASONING_CONTROL,
		supportedEfforts: Object.freeze(["low", "medium", "high"]),
		normalizeEndpoint,
		getCatalogEndpoint,
		getReasoningWireSpec(spec) {
			if (!spec || spec.profile !== "anthropic") return null;
			return Object.freeze({patch: spec.extras || {}, fields: [...(spec.fields || [])], values: [...(spec.values || [])]});
		},
		applyReasoning(payload, wireSpec) {
			if (!wireSpec) return payload;
			const merged = Object.assign({}, payload, wireSpec.patch);
			if (payload.output_config || wireSpec.patch.output_config) merged.output_config = Object.assign({}, payload.output_config, wireSpec.patch.output_config);
			const thinking = merged.thinking;
			if (thinking && (thinking.type === "enabled" || thinking.type === "adaptive")) merged.temperature = 1;
			if (thinking && thinking.type === "enabled" && Number.isFinite(Number(thinking.budget_tokens)) && Number(merged.max_tokens) <= Number(thinking.budget_tokens)) merged.max_tokens = Number(thinking.budget_tokens) + Math.max(1, Number(merged.max_tokens) || 1);
			return merged;
		},
		buildSingleRequest(options) {return buildRequest(Object.assign({}, options, {maxTokens: 4096, temperature: 0.2}));},
		buildValidationRequest(options) {return buildRequest(Object.assign({}, options, {temperature: 0}));},
		buildBatchRequest(options) {
			const request = buildRequest(Object.assign({}, options, {maxTokens: 4096, temperature: 0.1}));
			if (options.jsonObject === true && ANTHROPIC_JSON_MODELS.test(String(options.model || ""))) {
				// A stable shape lets the server reuse its grammar across batch sizes and IDs.
				request.payload.output_config = {format: {type: "json_schema", schema: {
					type: "object",
					properties: {messages: {type: "array", items: {
						type: "object",
						properties: {
							id: {type: "string"},
							segments: {type: "array", items: {type: "object", properties: {id: {type: "string"}, translation: {type: "string"}}, required: ["id", "translation"], additionalProperties: false}}
						},
						required: ["id", "segments"],
						additionalProperties: false
					}}},
					required: ["messages"],
					additionalProperties: false
				}}};
			}
			return request;
		},
		buildCatalogRequest({endpoint, apiKey}) {return {url: getCatalogEndpoint(normalizeEndpoint(endpoint)), requestOptions: {method: "get", headers: buildHeaders(apiKey, false)}};},
		parseText(body) {
			const parsed = parseBody(body);
			return ((parsed && parsed.content) || []).filter(block => block && block.type === "text" && typeof block.text == "string").map(block => block.text).join("").trim();
		},
		parseUsage(body) {
			const parsed = parseBody(body);
			const usage = parsed && parsed.usage;
			if (!usage) return null;
			const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
			const promptTokens = numberOrNull(usage.input_tokens);
			const completionTokens = numberOrNull(usage.output_tokens);
			const reasoningTokens = numberOrNull(usage.output_tokens_details && usage.output_tokens_details.thinking_tokens);
			if (promptTokens == null && completionTokens == null && reasoningTokens == null) return null;
			return Object.freeze({promptTokens, completionTokens, reasoningTokens});
		},
		parseBatch,
		parseCatalog(body) {
			const parsed = parseBody(body);
			return ((parsed && parsed.data) || []).filter(item => item && (item.type === "model" || typeof item.display_name == "string")).map(item => item.id).filter(item => typeof item == "string" && item.trim());
		},
		isCatalogResponse(body) {
			const parsed = parseBody(body);
			return !!(parsed && Array.isArray(parsed.data) && parsed.data.some(item => item && typeof item.id == "string" && (item.type === "model" || typeof item.display_name == "string")));
		},
		getReasoningEvidence(body, spec) {
			if (!spec || !spec.closesThinking && !spec.opensThinking) return null;
			const parsed = parseBody(body);
			if (!parsed || !Array.isArray(parsed.content)) return "none";
			const hasThinking = parsed.content.some(block => block && (block.type === "thinking" || block.type === "redacted_thinking"));
			if (spec.opensThinking) return hasThinking ? "confirmed" : "contradicted";
			return hasThinking ? "contradicted" : "confirmed";
		}
	});
}

module.exports = {createAnthropicMessagesAdapter};
