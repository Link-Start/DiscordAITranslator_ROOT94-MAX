const test = require("node:test");
const assert = require("node:assert/strict");
const {createGeminiNativeAdapter} = require("../../src/providers/protocol-adapters/gemini-native-adapter");

function createAdapter() {
	return createGeminiNativeAdapter({
		normalizeEndpoint: endpoint => String(endpoint || "").replace(/\/+$/, ""),
		getCatalogEndpoint: endpoint => String(endpoint || "").replace(/\/+$/, ""),
		parseBatch: (body, ids) => ({text: JSON.parse(body).candidates[0].content.parts[0].text, ids})
	});
}

test("Gemini typed batches constrain the existing shape without fixing IDs or changing other request families", () => {
	const adapter = createAdapter();
	const options = {endpoint: "https://gemini.test/models", apiKey: "fixture", model: "gemini-2.5-flash", systemPrompt: "Return JSON.", userPrompt: "BATCH", jsonObject: true};
	const typed = adapter.buildBatchRequest(options).payload;
	const schema = {
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
	assert.equal(typed.generationConfig.responseMimeType, "application/json");
	assert.deepEqual(typed.generationConfig.responseSchema, schema);
	assert.equal(Object.hasOwn(typed.generationConfig, "responseJsonSchema"), false);
	assert.deepEqual(typed.system_instruction, {parts: [{text: options.systemPrompt}]});
	assert.deepEqual(typed.contents, [{role: "user", parts: [{text: options.userPrompt}]}]);
	assert.deepEqual(adapter.buildBatchRequest({...options, userPrompt: "A DIFFERENT BATCH"}).payload.generationConfig.responseSchema, schema);
	assert.deepEqual(adapter.applyReasoning(typed, {patch: {generationConfig: {thinkingConfig: {thinkingBudget: 0}}}}).generationConfig, {temperature: 0.1, topP: 0.8, responseMimeType: "application/json", responseSchema: schema, thinkingConfig: {thinkingBudget: 0}});
	for (const payload of [adapter.buildBatchRequest({...options, jsonObject: false}).payload, adapter.buildSingleRequest(options).payload, adapter.buildValidationRequest(options).payload]) {
		assert.equal(Object.hasOwn(payload.generationConfig, "responseMimeType"), false);
		assert.equal(Object.hasOwn(payload.generationConfig, "responseSchema"), false);
	}
});

test("Gemini native adapter builds single validation batch and distinctive catalog requests", () => {
	const adapter = createAdapter();
	const common = {endpoint: "https://generativelanguage.googleapis.com/v1beta/models", apiKey: "gem-key", model: "models/gemini-2.5-flash"};
	const single = adapter.buildSingleRequest({...common, systemPrompt: "SYSTEM", userPrompt: "USER"});
	assert.equal(single.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
	assert.deepEqual(single.requestOptions, {method: "post", headers: {"Content-Type": "application/json", "x-goog-api-key": "gem-key"}});
	assert.equal(JSON.stringify(single.payload), '{"system_instruction":{"parts":[{"text":"SYSTEM"}]},"contents":[{"role":"user","parts":[{"text":"USER"}]}],"generationConfig":{"temperature":0.2,"topP":0.8}}');

	const validation = adapter.buildValidationRequest({...common, systemPrompt: "VALIDATE", userPrompt: "FIXTURE", maxTokens: 512});
	assert.equal(JSON.stringify(validation.payload), '{"system_instruction":{"parts":[{"text":"VALIDATE"}]},"contents":[{"role":"user","parts":[{"text":"FIXTURE"}]}],"generationConfig":{"temperature":0,"maxOutputTokens":512}}');
	const batch = adapter.buildBatchRequest({...common, systemPrompt: "BATCH", userPrompt: "ITEMS"});
	assert.equal(JSON.stringify(batch.payload), '{"system_instruction":{"parts":[{"text":"BATCH"}]},"contents":[{"role":"user","parts":[{"text":"ITEMS"}]}],"generationConfig":{"temperature":0.1,"topP":0.8}}');
	assert.deepEqual(adapter.buildCatalogRequest(common), {url: "https://generativelanguage.googleapis.com/v1beta/models", requestOptions: {method: "get", headers: {"x-goog-api-key": "gem-key"}}});
});

test("Gemini native adapter parses text models and usage metadata", () => {
	const adapter = createAdapter();
	assert.equal(Object.isFrozen(adapter), true);
	assert.equal(adapter.id, "gemini_native");
	assert.equal(adapter.uiReady, true);
	assert.equal(adapter.ui.labelKey, "api_format_gemini_native");
	assert.equal(adapter.ui.credentialPlaceholderKey, "api_key_gemini_placeholder");
	assert.equal(adapter.catalogDistinctive, true);
	assert.equal(adapter.credentialPolicy, "required");
	assert.deepEqual(adapter.reasoningFamilies, ["gemini"]);
	assert.deepEqual(adapter.supportedEfforts, ["minimal", "low", "medium", "high"]);
	assert.equal(adapter.parseText('{"candidates":[{"content":{"parts":[{"text":"one"},{"text":" two"}]}}]}'), "one two");
	assert.deepEqual(adapter.parseCatalog('{"models":[{"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]}]}'), ["gemini-2.5-flash"]);
	assert.deepEqual(adapter.parseUsage('{"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7,"thoughtsTokenCount":3}}'), {promptTokens: 12, completionTokens: 7, reasoningTokens: 3});
	assert.equal(adapter.isCatalogResponse({models: [{name: "models/gemini-x", supportedGenerationMethods: ["generateContent"]}]}), true);
	assert.equal(adapter.isCatalogResponse({models: [{name: "models/gemini-x"}]}), true);
	assert.equal(adapter.isCatalogResponse({models: [{name: "qwen3:8b", model: "qwen3:8b", modified_at: "now"}]}), false, "Ollama tags never become Gemini catalog evidence");

	const off = {profile: "gemini", extras: {generationConfig: {thinkingConfig: {thinkingBudget: 0}}}, fields: ["thinkingConfig", "thinkingBudget"], values: ["0"], closesThinking: true};
	const on = {profile: "gemini", extras: {generationConfig: {thinkingConfig: {thinkingLevel: "low"}}}, fields: ["thinkingConfig", "thinkingLevel"], values: ["low"], opensThinking: true};
	assert.deepEqual(adapter.applyReasoning({generationConfig: {temperature: 0.2}}, adapter.getReasoningWireSpec(off)), {generationConfig: {temperature: 0.2, thinkingConfig: {thinkingBudget: 0}}});
	assert.equal(adapter.getReasoningEvidence('{"usageMetadata":{"thoughtsTokenCount":0}}', off), "confirmed");
	assert.equal(adapter.getReasoningEvidence('{"usageMetadata":{"thoughtsTokenCount":3}}', off), "contradicted");
	assert.equal(adapter.getReasoningEvidence('{"usageMetadata":{"thoughtsTokenCount":3}}', on), "confirmed");
	assert.equal(adapter.getReasoningEvidence('{"usageMetadata":{"thoughtsTokenCount":0}}', on), "none");
	assert.equal(adapter.getReasoningEvidence('{"usageMetadata":{}}', on), "none", "a simple prompt may legitimately use no thinking");
	assert.equal(adapter.getReasoningEvidence('{}', off), "none");
});
