const test = require("node:test");
const assert = require("node:assert/strict");
const {createOllamaNativeAdapter} = require("../../src/providers/protocol-adapters/ollama-native-adapter");

function createAdapter() {
	return createOllamaNativeAdapter({
		normalizeEndpoint: endpoint => String(endpoint || "").replace(/\/+$/, "") + (/\/api\/chat$/i.test(String(endpoint || "")) ? "" : "/api/chat"),
		getCatalogEndpoint: endpoint => String(endpoint || "").replace(/\/api\/chat\/?$/i, "/api/tags"),
		parseBatch: (body, ids) => ({text: JSON.parse(body).message.content, ids})
	});
}

test("Ollama typed batches enable JSON format while preserving think and legacy requests", () => {
	const adapter = createAdapter();
	const options = {endpoint: "http://localhost:11434", apiKey: "", model: "qwen3:8b", systemPrompt: "Return JSON.", userPrompt: "BATCH", jsonObject: true};
	const typed = adapter.buildBatchRequest(options).payload;
	assert.equal(typed.format, "json");
	assert.equal(adapter.applyReasoning(typed, {patch: {think: false}}).format, "json");
	for (const payload of [adapter.buildBatchRequest({...options, jsonObject: false}).payload, adapter.buildSingleRequest(options).payload, adapter.buildValidationRequest(options).payload]) assert.equal(Object.hasOwn(payload, "format"), false);
});

test("Ollama native adapter builds non-streaming single validation batch and catalog requests", () => {
	const adapter = createAdapter();
	const common = {endpoint: "http://localhost:11434", apiKey: "", model: "qwen3:8b"};
	const single = adapter.buildSingleRequest({...common, systemPrompt: "SYSTEM", userPrompt: "USER"});
	assert.equal(single.url, "http://localhost:11434/api/chat");
	assert.deepEqual(single.requestOptions, {method: "post", headers: {"Content-Type": "application/json"}});
	assert.equal(JSON.stringify(single.payload), '{"model":"qwen3:8b","messages":[{"role":"system","content":"SYSTEM"},{"role":"user","content":"USER"}],"stream":false,"options":{"temperature":0.2,"top_p":0.8}}');

	const keyed = adapter.buildSingleRequest({...common, apiKey: "cloud-key", systemPrompt: "S", userPrompt: "U"});
	assert.equal(keyed.requestOptions.headers.Authorization, "Bearer cloud-key");

	const validation = adapter.buildValidationRequest({...common, systemPrompt: "VALIDATE", userPrompt: "FIXTURE", maxTokens: 512});
	assert.equal(JSON.stringify(validation.payload), '{"model":"qwen3:8b","messages":[{"role":"system","content":"VALIDATE"},{"role":"user","content":"FIXTURE"}],"stream":false,"options":{"temperature":0,"num_predict":512}}');
	const batch = adapter.buildBatchRequest({...common, systemPrompt: "BATCH", userPrompt: "ITEMS"});
	assert.equal(JSON.stringify(batch.payload), '{"model":"qwen3:8b","messages":[{"role":"system","content":"BATCH"},{"role":"user","content":"ITEMS"}],"stream":false,"options":{"temperature":0.1,"top_p":0.8}}');
	assert.deepEqual(adapter.buildCatalogRequest(common), {url: "http://localhost:11434/api/tags", requestOptions: {method: "get", headers: {}}});
});

test("Ollama native adapter parses content models usage and truthful thinking evidence", () => {
	const adapter = createAdapter();
	assert.equal(Object.isFrozen(adapter), true);
	assert.equal(adapter.id, "ollama_native");
	assert.equal(adapter.uiReady, true);
	assert.equal(adapter.ui.labelKey, "api_format_ollama_native");
	assert.equal(adapter.apiKeyOptional, true);
	assert.equal(adapter.credentialPolicy, "optional");
	assert.equal(adapter.catalogDistinctive, true);
	assert.deepEqual(adapter.reasoningFamilies, ["ollama"]);
	assert.equal(adapter.parseText('{"message":{"content":"translated"}}'), "translated");
	assert.deepEqual(adapter.parseCatalog('{"models":[{"name":"qwen3:8b"},{"model":"gpt-oss:20b"},{}]}'), ["qwen3:8b", "gpt-oss:20b"]);
	assert.deepEqual(adapter.parseUsage('{"prompt_eval_count":12,"eval_count":7}'), {promptTokens: 12, completionTokens: 7, reasoningTokens: null});
	assert.equal(adapter.isCatalogResponse({models: [{name: "qwen3:8b", model: "qwen3:8b", modified_at: "now"}]}), true);
	assert.equal(adapter.isCatalogResponse({models: [{name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"]}]}), false, "Gemini models.list never becomes Ollama catalog evidence");

	const off = {profile: "ollama", extras: {think: false}, fields: ["think"], values: ["false"], closesThinking: true};
	const on = {profile: "ollama", extras: {think: true}, fields: ["think"], values: ["true"], opensThinking: true};
	assert.deepEqual(adapter.getReasoningWireSpec(off), {patch: {think: false}, fields: ["think"], values: ["false"]});
	assert.deepEqual(adapter.applyReasoning({model: "m"}, adapter.getReasoningWireSpec(off)), {model: "m", think: false});
	assert.equal(adapter.getReasoningEvidence('{"message":{"content":"ok","thinking":""}}', off), "confirmed");
	assert.equal(adapter.getReasoningEvidence('{"message":{"content":"ok","thinking":"trace"}}', off), "contradicted");
	assert.equal(adapter.getReasoningEvidence('{"message":{"content":"ok","thinking":"trace"}}', on), "confirmed");
	assert.equal(adapter.getReasoningEvidence('{"message":{"content":"ok","thinking":""}}', on), "contradicted");
	assert.equal(adapter.getReasoningEvidence('{"message":{"content":"ok"}}', off), "none");
});
