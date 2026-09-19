const test = require("node:test");
const assert = require("node:assert/strict");
const {createAnthropicMessagesAdapter} = require("../../src/providers/protocol-adapters/anthropic-messages-adapter");

function createAdapter() {
	return createAnthropicMessagesAdapter({
		normalizeEndpoint: endpoint => String(endpoint || "").replace(/\/+$/, "") + (/\/v1\/messages$/i.test(String(endpoint || "")) ? "" : "/v1/messages"),
		getCatalogEndpoint: endpoint => String(endpoint || "").replace(/\/v1\/messages\/?$/i, "/v1/models"),
		parseBatch: (body, ids) => ({text: JSON.parse(body).content.find(block => block.type === "text").text, ids})
	});
}

test("Anthropic supported typed batches constrain the existing shape and keep format with adaptive effort", () => {
	const adapter = createAdapter();
	const options = {endpoint: "https://anthropic.test", apiKey: "fixture", model: "claude-sonnet-4-6", systemPrompt: "Return JSON.", userPrompt: '{"messages":[{"id":"m1"}]}', jsonObject: true};
	const typed = adapter.buildBatchRequest(options).payload;
	assert.equal(typed.output_config?.format?.type, "json_schema");
	const schema = typed.output_config.format.schema;
	assert.deepEqual(schema.required, ["messages"]);
	assert.deepEqual(schema.properties.messages.items.required, ["id", "segments"]);
	assert.deepEqual(schema.properties.messages.items.properties.segments.items, {type: "object", properties: {id: {type: "string"}, translation: {type: "string"}}, required: ["id", "translation"], additionalProperties: false});
	assert.deepEqual(adapter.buildBatchRequest({...options, userPrompt: '{"messages":[{"id":"m7"},{"id":"m9"}]}'}).payload.output_config.format, typed.output_config.format, "schema must not grow with batch size or pin message IDs");
	const reasoning = adapter.getReasoningWireSpec({profile: "anthropic", extras: {thinking: {type: "adaptive"}, output_config: {effort: "low"}}, fields: ["thinking", "output_config"], values: ["adaptive", "low"]});
	assert.deepEqual(adapter.applyReasoning(typed, reasoning).output_config, {format: typed.output_config.format, effort: "low"});
	assert.equal(Object.hasOwn(typed.output_config, "effort"), false, "reasoning must not mutate the reusable request");
	for (const model of ["claude-opus-4-5-20251101", "claude-opus-4.8", "claude-opus-5", "claude-sonnet-4-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-preview", "anthropic/claude-sonnet-4.6"]) assert.equal(adapter.buildBatchRequest({...options, model}).payload.output_config?.format?.type, "json_schema", model);
	for (const model of ["claude-3-7-sonnet-latest", "claude-sonnet-4-20250514", "claude-opus-4-1", "claude-haiku-3-5", "gemini-3.7-flash-high", "unknown-model"]) assert.equal(Object.hasOwn(adapter.buildBatchRequest({...options, model}).payload, "output_config"), false, "unverified models keep their existing prompt contract: " + model);
	for (const payload of [adapter.buildBatchRequest({...options, jsonObject: false}).payload, adapter.buildSingleRequest(options).payload, adapter.buildValidationRequest(options).payload]) assert.equal(Object.hasOwn(payload, "output_config"), false);
});

test("Anthropic Messages adapter builds single validation batch and model catalog requests", () => {
	const adapter = createAdapter();
	const common = {endpoint: "https://api.anthropic.com", apiKey: "ant-key", model: "claude-sonnet-4-6"};
	const single = adapter.buildSingleRequest({...common, systemPrompt: "SYSTEM", userPrompt: "USER"});
	assert.equal(single.url, "https://api.anthropic.com/v1/messages");
	assert.deepEqual(single.requestOptions, {method: "post", headers: {"Content-Type": "application/json", "x-api-key": "ant-key", "anthropic-version": "2023-06-01"}});
	assert.equal(JSON.stringify(single.payload), '{"model":"claude-sonnet-4-6","system":"SYSTEM","messages":[{"role":"user","content":"USER"}],"max_tokens":4096,"temperature":0.2,"stream":false}');

	const validation = adapter.buildValidationRequest({...common, systemPrompt: "VALIDATE", userPrompt: "FIXTURE", maxTokens: 512});
	assert.equal(JSON.stringify(validation.payload), '{"model":"claude-sonnet-4-6","system":"VALIDATE","messages":[{"role":"user","content":"FIXTURE"}],"max_tokens":512,"temperature":0,"stream":false}');
	const batch = adapter.buildBatchRequest({...common, systemPrompt: "BATCH", userPrompt: "ITEMS"});
	assert.equal(JSON.stringify(batch.payload), '{"model":"claude-sonnet-4-6","system":"BATCH","messages":[{"role":"user","content":"ITEMS"}],"max_tokens":4096,"temperature":0.1,"stream":false}');
	assert.deepEqual(adapter.buildCatalogRequest(common), {url: "https://api.anthropic.com/v1/models", requestOptions: {method: "get", headers: {"x-api-key": "ant-key", "anthropic-version": "2023-06-01"}}});
});

test("Anthropic adapter extracts only text blocks and parses model and usage metadata", () => {
	const adapter = createAdapter();
	assert.equal(Object.isFrozen(adapter), true);
	assert.equal(adapter.id, "anthropic_messages");
	assert.equal(adapter.uiReady, true);
	assert.equal(adapter.ui.labelKey, "api_format_anthropic_messages");
	assert.equal(adapter.ui.credentialPlaceholderKey, "api_key_anthropic_placeholder");
	assert.equal(adapter.credentialPolicy, "required");
	assert.equal(adapter.catalogDistinctive, true);
	assert.deepEqual(adapter.reasoningFamilies, ["anthropic"]);
	assert.deepEqual(adapter.supportedEfforts, ["low", "medium", "high"]);
	assert.equal(adapter.parseText('{"content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"translated"},{"type":"text","text":" text"}]}'), "translated text");
	assert.deepEqual(adapter.parseCatalog('{"data":[{"id":"claude-sonnet-4-6","type":"model"},{"id":"not-a-model","type":"other"}]}'), ["claude-sonnet-4-6"]);
	assert.deepEqual(adapter.parseUsage('{"usage":{"input_tokens":12,"output_tokens":7,"output_tokens_details":{"thinking_tokens":3}}}'), {promptTokens: 12, completionTokens: 7, reasoningTokens: 3});
	assert.equal(adapter.isCatalogResponse({data: [{id: "claude-sonnet-4-6", type: "model"}]}), true);
	assert.equal(adapter.isCatalogResponse({data: [{id: "gpt-x", object: "model"}]}), false, "OpenAI-style data arrays are not Anthropic catalog evidence");

	const disabled = {profile: "anthropic", extras: {thinking: {type: "disabled"}}, fields: ["thinking"], values: ["disabled"], closesThinking: true};
	const budget = {profile: "anthropic", extras: {thinking: {type: "enabled", budget_tokens: 4096, display: "omitted"}}, fields: ["thinking", "budget_tokens"], values: ["enabled", "4096"], opensThinking: true};
	const adaptive = {profile: "anthropic", extras: {thinking: {type: "adaptive", display: "omitted"}, output_config: {effort: "low"}}, fields: ["thinking", "output_config", "effort"], values: ["adaptive", "low"], opensThinking: true};
	assert.deepEqual(adapter.applyReasoning({max_tokens: 512, temperature: 0}, adapter.getReasoningWireSpec(disabled)), {max_tokens: 512, temperature: 0, thinking: {type: "disabled"}});
	assert.deepEqual(adapter.applyReasoning({max_tokens: 512, temperature: 0}, adapter.getReasoningWireSpec(budget)), {max_tokens: 4608, temperature: 1, thinking: {type: "enabled", budget_tokens: 4096, display: "omitted"}});
	assert.equal(adapter.applyReasoning({max_tokens: 512, temperature: 0}, adapter.getReasoningWireSpec({...budget, extras: {thinking: {type: "enabled", budget_tokens: 1024, display: "omitted"}}})).max_tokens, 1536);
	assert.equal(adapter.applyReasoning({max_tokens: 4096, temperature: 0.2}, adapter.getReasoningWireSpec({...budget, extras: {thinking: {type: "enabled", budget_tokens: 16384, display: "omitted"}}})).max_tokens, 20480);
	assert.deepEqual(adapter.applyReasoning({max_tokens: 4096, temperature: 0.2}, adapter.getReasoningWireSpec(adaptive)), {max_tokens: 4096, temperature: 1, thinking: {type: "adaptive", display: "omitted"}, output_config: {effort: "low"}});
	assert.equal(adapter.getReasoningEvidence('{"content":[{"type":"text","text":"ok"}]}', disabled), "confirmed");
	assert.equal(adapter.getReasoningEvidence('{"content":[{"type":"thinking","thinking":"summary"},{"type":"text","text":"ok"}]}', disabled), "contradicted");
	assert.equal(adapter.getReasoningEvidence('{"content":[{"type":"redacted_thinking","data":"x"},{"type":"text","text":"ok"}]}', adaptive), "confirmed");
	assert.equal(adapter.getReasoningEvidence('{"content":[{"type":"thinking","thinking":"","signature":"sig"},{"type":"text","text":"ok"}]}', adaptive), "confirmed", "display omitted keeps a thinking block whose empty text is still affirmative evidence");
	assert.equal(adapter.getReasoningEvidence('{"content":[{"type":"text","text":"ok"}]}', adaptive), "contradicted");
});
