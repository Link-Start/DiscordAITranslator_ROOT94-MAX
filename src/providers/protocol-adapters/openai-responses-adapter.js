// Pure OpenAI Responses wire-format adapter. M3 exposes it only through the
// completed custom-provider adapter registry and keeps all settings/state outside.

const OPENAI_RESPONSES_REASONING_CONTROL = Object.freeze({
	controlKind: "enum",
	tiers: Object.freeze(["minimal", "low", "medium", "high"]),
	defaultRaw: "low",
	offSentinels: Object.freeze(["none"]),
	custom: Object.freeze({kind: "enum"})
});
const OPENAI_RESPONSES_REASONING_FAMILIES = Object.freeze(["openai"]);
const OPENAI_RESPONSES_UI = Object.freeze({labelKey: "api_format_openai_responses"});
const OPENAI_RESPONSES_CAPABILITIES = Object.freeze({single: true, batch: true, validation: true, catalog: true, errorClassification: true});

function createOpenAiResponsesAdapter({normalizeEndpoint, getCatalogEndpoint, parseText, parseUsage, parseBatch} = {}) {
	if (typeof normalizeEndpoint != "function" || typeof getCatalogEndpoint != "function" || typeof parseText != "function" || typeof parseUsage != "function" || typeof parseBatch != "function") {
		throw new TypeError("OpenAI Responses adapter requires endpoint and response helpers");
	}

	const buildHeaders = apiKey => ({"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`});
	const buildRequest = ({endpoint, apiKey, model, systemPrompt, userPrompt, reasoningEffort = null}) => {
		const payload = {model, instructions: systemPrompt, input: userPrompt, store: false};
		if (reasoningEffort) payload.reasoning = {effort: reasoningEffort};
		return {url: normalizeEndpoint(endpoint), requestOptions: {method: "post", headers: buildHeaders(apiKey)}, payload};
	};
	const buildValidationRequest = options => {
		const request = buildRequest(options);
		if (Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0) request.payload.max_output_tokens = Math.floor(Number(options.maxTokens));
		return request;
	};

	return Object.freeze({
		id: "openai_responses",
		version: 1,
		uiReady: true,
		ui: OPENAI_RESPONSES_UI,
		capabilities: OPENAI_RESPONSES_CAPABILITIES,
		credentialPolicy: "required",
		catalogDistinctive: false,
		reasoningFamilies: OPENAI_RESPONSES_REASONING_FAMILIES,
		reasoningControl: OPENAI_RESPONSES_REASONING_CONTROL,
		normalizeEndpoint,
		getCatalogEndpoint,
		getReasoningWireSpec(spec) {
			if (!spec || spec.profile !== "openai" || !spec.resolvedValue) return null;
			return Object.freeze({patch: {reasoning: {effort: spec.resolvedValue}}, fields: ["reasoning"], values: [spec.resolvedValue]});
		},
		applyReasoning(payload, wireSpec) {
			return wireSpec ? Object.assign({}, payload, wireSpec.patch) : payload;
		},
		buildSingleRequest: buildRequest,
		buildValidationRequest,
		buildBatchRequest(options) {
			const request = buildRequest(options);
			if (options.jsonObject === true) request.payload.text = {format: {type: "json_object"}};
			return request;
		},
		buildCatalogRequest({endpoint, apiKey}) {
			return {url: getCatalogEndpoint(endpoint), requestOptions: {method: "get", headers: buildHeaders(apiKey)}};
		},
		parseText,
		parseUsage,
		parseBatch,
		getReasoningEvidence(body, spec) {
			if (!spec || !spec.closesThinking && !spec.opensThinking) return null;
			let parsed = null;
			try {parsed = typeof body == "string" ? JSON.parse(body) : body;}
			catch (error) {return null;}
			// The Responses wire echoes the effort in force. An echo naming a thinking level
			// after an off request is the server's own statement that off was replaced, so it
			// is hard evidence even when the usage block is missing or zeroed. An echoed off
			// value proves nothing by itself: a rewriting relay can rewrite the echo too.
			const echo = parsed && parsed.reasoning && typeof parsed.reasoning.effort == "string" ? parsed.reasoning.effort.trim().toLowerCase() : "";
			if (echo && spec.closesThinking && !OPENAI_RESPONSES_REASONING_CONTROL.offSentinels.includes(echo)) return "contradicted";
			const raw = parsed && parsed.usage && parsed.usage.output_tokens_details && parsed.usage.output_tokens_details.reasoning_tokens;
			// No positive signal here is "no opinion", never a verdict: relays that convert
			// other backends report usage in chat shape on this wire, and only the generic
			// classifier reads every shape. Returning "none" would mask it.
			if (raw == null || !Number.isFinite(Number(raw)) || Number(raw) <= 0) return null;
			return spec.opensThinking ? "confirmed" : "contradicted";
		},
		// The echoed reasoning.effort, when the response carries one: the server's own
		// statement of the level actually in force, which chat-format responses never report.
		getReasoningEchoRaw(body) {
			let parsed = null;
			try {parsed = typeof body == "string" ? JSON.parse(body) : body;}
			catch (error) {return null;}
			const effort = parsed && parsed.reasoning && typeof parsed.reasoning.effort == "string" ? parsed.reasoning.effort.trim() : "";
			return effort || null;
		},
		parseCatalog(body) {
			try {body = typeof body == "string" ? JSON.parse(body) : body;}
			catch (error) {return [];}
			return ((body && body.data) || []).map(item => typeof item == "string" ? item : item && item.id).filter(item => typeof item == "string" && item.trim());
		}
	});
}

module.exports = {createOpenAiResponsesAdapter};
