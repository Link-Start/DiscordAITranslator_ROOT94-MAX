const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
	createOpenAiChatAdapter,
	createOpenAiResponsesAdapter,
	createProtocolAdapterRegistry
} = require("../../src/providers/protocol-adapters");
const {
	normalizeApiEndpoint,
	getModelCatalogEndpoint,
	getRegisteredCustomProtocolAdapters,
	parseOpenAiResponseText,
	parseAiBatchTranslationResponse
} = require("../../src/providers/provider-client");

function createFixtureAdapter() {
	return createOpenAiChatAdapter({
		normalizeEndpoint: endpoint => normalizeApiEndpoint("oaicompat", endpoint),
		getCatalogEndpoint: endpoint => getModelCatalogEndpoint("oaicompat", endpoint),
		parseText: parseOpenAiResponseText,
		parseUsage: body => ({fixture: JSON.parse(body).usage.total_tokens}),
		parseBatch: (body, ids) => parseAiBatchTranslationResponse(parseOpenAiResponseText(body), ids)
	});
}

function createResponsesFixtureAdapter() {
	return createOpenAiResponsesAdapter({
		normalizeEndpoint: endpoint => normalizeApiEndpoint("openai", endpoint),
		getCatalogEndpoint: endpoint => getModelCatalogEndpoint("openai", endpoint),
		parseText: parseOpenAiResponseText,
		parseUsage: body => ({fixture: JSON.parse(body).usage.output_tokens}),
		parseBatch: (body, ids) => parseAiBatchTranslationResponse(parseOpenAiResponseText(body), ids)
	});
}

test("OpenAI Chat adapter builds byte-stable custom single validation batch and catalog requests", () => {
	const adapter = createFixtureAdapter();
	const common = {endpoint: "https://relay.test/v1", apiKey: "fixture-key", model: "fixture-model"};

	const single = adapter.buildSingleRequest({...common, systemPrompt: "SYSTEM", userPrompt: "USER"});
	assert.equal(single.url, "https://relay.test/v1/chat/completions");
	assert.deepEqual(single.requestOptions, {method: "post", headers: {"Content-Type": "application/json", "Authorization": "Bearer fixture-key"}});
	assert.equal(JSON.stringify(single.payload), '{"model":"fixture-model","messages":[{"role":"system","content":"SYSTEM"},{"role":"user","content":"USER"}],"temperature":0.2,"top_p":0.8}');

	const validation = adapter.buildValidationRequest({...common, systemPrompt: "You are a translation validator.", userPrompt: "Translate fixture", maxTokens: 512});
	assert.equal(validation.url, "https://relay.test/v1/chat/completions");
	assert.deepEqual(validation.requestOptions, {method: "post", headers: {"Content-Type": "application/json", "Authorization": "Bearer fixture-key"}});
	assert.equal(JSON.stringify(validation.payload), '{"model":"fixture-model","messages":[{"role":"system","content":"You are a translation validator."},{"role":"user","content":"Translate fixture"}],"temperature":0,"max_tokens":512}');

	const batch = adapter.buildBatchRequest({...common, systemPrompt: "BATCH SYSTEM", userPrompt: "BATCH USER"});
	assert.equal(batch.url, "https://relay.test/v1/chat/completions");
	assert.deepEqual(batch.requestOptions, {method: "post", headers: {"Content-Type": "application/json", "Authorization": "Bearer fixture-key"}});
	assert.equal(JSON.stringify(batch.payload), '{"model":"fixture-model","messages":[{"role":"system","content":"BATCH SYSTEM"},{"role":"user","content":"BATCH USER"}],"temperature":0.1,"top_p":0.8}');

	const catalog = adapter.buildCatalogRequest(common);
	assert.deepEqual(catalog, {
		url: "https://relay.test/v1/models",
		requestOptions: {method: "get", headers: {"Content-Type": "application/json", "Authorization": "Bearer fixture-key"}}
	});
});

test("OpenAI Chat adapter parses fixed response fixtures and exposes no stateful dependency", () => {
	const adapter = createFixtureAdapter();
	assert.equal(Object.isFrozen(adapter), true);
	assert.equal(adapter.id, "openai_chat");
	assert.equal(adapter.version, 1);
	assert.equal(adapter.uiReady, true);
	assert.equal(adapter.ui.labelKey, "api_format_openai_chat");
	assert.deepEqual(adapter.capabilities, {single: true, batch: true, validation: true, catalog: true, errorClassification: true});
	assert.deepEqual(adapter.reasoningFamilies, ["openai", "deepseek", "qwen"]);
	assert.equal(adapter.parseText('{"choices":[{"message":{"content":"translated"}}]}'), "translated");
	assert.deepEqual(adapter.parseUsage('{"usage":{"total_tokens":9}}'), {fixture: 9});
	assert.deepEqual(adapter.parseBatch('{"choices":[{"message":{"content":"[{\\"id\\":\\"1\\",\\"translation\\":\\"one\\"}]"}}]}', ["1"]), {"1": "one"});
	assert.deepEqual(adapter.parseCatalog('{"data":[{"id":"z"},{"id":"a"},{"id":""},{}]}'), ["z", "a"]);
	const chatSpec = {profile: "openai", resolvedValue: "none", extras: {reasoning_effort: "none"}, fields: ["reasoning_effort"], values: ["none"]};
	const chatWire = adapter.getReasoningWireSpec(chatSpec);
	assert.deepEqual(chatWire, {patch: {reasoning_effort: "none"}, fields: ["reasoning_effort"], values: ["none"]});
	assert.deepEqual(adapter.applyReasoning({model: "m"}, chatWire), {model: "m", reasoning_effort: "none"});

	const source = fs.readFileSync(path.join(__dirname, "../../src/providers/protocol-adapters/openai-chat-adapter.js"), "utf8");
	assert.doesNotMatch(source, /BDFDB|settings-store|Date\.now|Math\.random|plugin\./);
});

test("verified Gemini Flash Chat batches use a small structural schema without fixing IDs or adding requests", () => {
	const adapter = createFixtureAdapter();
	const options = {endpoint: "https://relay.test/v1", apiKey: "fixture-key", model: "gemini-3.7-flash-high", systemPrompt: "Return JSON.", userPrompt: "BATCH", jsonObject: true};
	for (const model of ["gemini-3.7-flash-high", "gemini-3.6-flash-high"]) {
		const payload = adapter.buildBatchRequest({...options, model}).payload;
		assert.equal(payload.response_format.type, "json_schema");
		assert.equal(payload.response_format.json_schema.strict, true);
		const schema = payload.response_format.json_schema.schema;
		assert.deepEqual(schema.required, ["messages"]);
		assert.equal(schema.additionalProperties, false);
		const message = schema.properties.messages.items, segment = message.properties.segments.items;
		assert.deepEqual(message.required, ["id", "segments"]);
		assert.deepEqual(segment.required, ["id", "translation"]);
		assert.deepEqual(message.properties.id, {type: "string"});
		assert.deepEqual(segment.properties.id, {type: "string"});
		assert.equal(schema.properties.messages.maxItems, undefined);
		assert.equal(message.properties.segments.minItems, undefined);
		assert.ok(Buffer.byteLength(JSON.stringify(payload.response_format)) < 550);
		assert.equal(payload.temperature, 0.1);
		assert.equal(payload.top_p, 0.8);
	}
	assert.deepEqual(adapter.buildBatchRequest({...options, model: "deepseek-v4-flash"}).payload.response_format, {type: "json_object"});
	assert.deepEqual(adapter.buildBatchRequest({...options, model: "unknown-alias"}).payload.response_format, {type: "json_object"});
	assert.equal(adapter.buildBatchRequest({...options, jsonObject: false}).payload.response_format, undefined);
	assert.equal(adapter.buildSingleRequest(options).payload.response_format, undefined);
});

test("protocol adapter registry is frozen and filters only complete UI-ready adapters", () => {
	const adapter = createFixtureAdapter();
	const hidden = Object.freeze({id: "hidden", uiReady: false});
	const registry = createProtocolAdapterRegistry([adapter, hidden]);
	assert.equal(Object.isFrozen(registry), true);
	assert.equal(registry.get("openai_chat"), adapter);
	assert.deepEqual(registry.list().map(item => item.id), ["openai_chat", "hidden"]);
	assert.deepEqual(registry.list({uiReadyOnly: true}).map(item => item.id), ["openai_chat"]);
	assert.equal(registry.get("future-adapter"), null);
});

test("OpenAI Responses adapter builds its native request shapes with nested reasoning", () => {
	const adapter = createResponsesFixtureAdapter();
	const common = {endpoint: "https://relay.test/v1", apiKey: "fixture-key", model: "fixture-model"};
	const single = adapter.buildSingleRequest({...common, systemPrompt: "SYSTEM", userPrompt: "USER", reasoningEffort: "low"});
	assert.equal(single.url, "https://relay.test/v1/responses");
	assert.deepEqual(single.requestOptions, {method: "post", headers: {"Content-Type": "application/json", "Authorization": "Bearer fixture-key"}});
	assert.equal(JSON.stringify(single.payload), '{"model":"fixture-model","instructions":"SYSTEM","input":"USER","store":false,"reasoning":{"effort":"low"}}');

	const validation = adapter.buildValidationRequest({...common, systemPrompt: "VALIDATE", userPrompt: "FIXTURE", maxTokens: 512});
	assert.equal(JSON.stringify(validation.payload), '{"model":"fixture-model","instructions":"VALIDATE","input":"FIXTURE","store":false,"max_output_tokens":512}');
	const batch = adapter.buildBatchRequest({...common, systemPrompt: "BATCH SYSTEM", userPrompt: "BATCH USER"});
	assert.equal(JSON.stringify(batch.payload), '{"model":"fixture-model","instructions":"BATCH SYSTEM","input":"BATCH USER","store":false}');
	assert.deepEqual(adapter.buildCatalogRequest(common), {
		url: "https://relay.test/v1/models",
		requestOptions: {method: "get", headers: {"Content-Type": "application/json", "Authorization": "Bearer fixture-key"}}
	});
});

test("OpenAI Responses adapter parses native text usage batch and catalog fixtures", () => {
	const adapter = createResponsesFixtureAdapter();
	assert.equal(Object.isFrozen(adapter), true);
	assert.equal(adapter.id, "openai_responses");
	assert.equal(adapter.version, 1);
	assert.deepEqual(adapter.reasoningFamilies, ["openai"]);
	assert.equal(adapter.uiReady, true, "M3 exposes the completed Responses contract through Advanced settings");
	assert.equal(adapter.ui.labelKey, "api_format_openai_responses");
	assert.deepEqual(adapter.capabilities, {single: true, batch: true, validation: true, catalog: true, errorClassification: true});
	assert.equal(adapter.parseText('{"output_text":"direct"}'), "direct");
	assert.equal(adapter.parseText('{"output":[{"type":"message","content":[{"type":"output_text","text":"nested"}]}]}'), "nested");
	assert.deepEqual(adapter.parseUsage('{"usage":{"output_tokens":7}}'), {fixture: 7});
	assert.deepEqual(adapter.parseBatch('{"output_text":"[{\\"id\\":\\"1\\",\\"translation\\":\\"one\\"}]"}', ["1"]), {"1": "one"});
	assert.deepEqual(adapter.parseCatalog('{"data":[{"id":"gpt-b"},{"id":"gpt-a"}]}'), ["gpt-b", "gpt-a"]);
	const spec = {profile: "openai", resolvedValue: "none", closesThinking: true};
	const wire = adapter.getReasoningWireSpec(spec);
	assert.deepEqual(wire, {patch: {reasoning: {effort: "none"}}, fields: ["reasoning"], values: ["none"]});
	assert.deepEqual(adapter.applyReasoning({model: "m"}, wire), {model: "m", reasoning: {effort: "none"}});
	assert.equal(adapter.getReasoningWireSpec({profile: "qwen", resolvedValue: "false"}), null);
	assert.equal(adapter.getReasoningEvidence('{"usage":{"output_tokens_details":{"reasoning_tokens":0}}}', spec), null, "no positive signal defers to the generic classifier instead of masking it");
	assert.equal(adapter.getReasoningEvidence('{"usage":{"output_tokens_details":{"reasoning_tokens":4}}}', spec), "contradicted");
	assert.equal(adapter.getReasoningEvidence('{"reasoning":{"effort":"low"},"usage":{"output_tokens_details":{"reasoning_tokens":0}}}', spec), "contradicted", "an echoed level after an off request is the server saying off was replaced");
	assert.equal(adapter.getReasoningEvidence('{"reasoning":{"effort":"none"}}', spec), null, "an echoed off value stays observation only - a rewriting relay can rewrite the echo too");
	assert.equal(adapter.getReasoningEchoRaw('{"reasoning":{"effort":"high"}}'), "high");
	assert.equal(adapter.getReasoningEchoRaw('{"usage":{"output_tokens":7}}'), null);
});

test("Responses requests JSON mode only for typed batches and preserves it with reasoning", () => {
	const adapter = createResponsesFixtureAdapter();
	const options = {endpoint: "https://relay.test/v1", apiKey: "fixture-key", model: "fixture-model", systemPrompt: "Return JSON.", userPrompt: "BATCH", jsonObject: true};
	const typed = adapter.buildBatchRequest(options).payload;
	assert.deepEqual(typed.text, {format: {type: "json_object"}});
	assert.equal(Object.hasOwn(typed, "response_format"), false);
	assert.deepEqual(adapter.applyReasoning(typed, {patch: {reasoning: {effort: "none"}}}).text, typed.text);
	assert.equal(Object.hasOwn(adapter.buildBatchRequest({...options, jsonObject: false}).payload, "text"), false, "legacy batches still return arrays");
	assert.equal(Object.hasOwn(adapter.buildSingleRequest(options).payload, "text"), false);
	assert.equal(Object.hasOwn(adapter.buildValidationRequest(options).payload, "text"), false);
});

test("M3 registry exposes both completed OpenAI wire formats", () => {
	const chat = createFixtureAdapter();
	const responses = createResponsesFixtureAdapter();
	const registry = createProtocolAdapterRegistry([chat, responses]);
	assert.deepEqual(registry.list().map(item => item.id), ["openai_chat", "openai_responses"]);
	assert.deepEqual(registry.list({uiReadyOnly: true}).map(item => item.id), ["openai_chat", "openai_responses"]);
	assert.equal(registry.get("openai_responses"), responses);
	assert.equal(chat.uiReady, true);
	assert.equal(responses.uiReady, true);
	assert.deepEqual(getRegisteredCustomProtocolAdapters({uiReadyOnly: true}).map(item => ({id: item.id, labelKey: item.labelKey})), [
		{id: "openai_chat", labelKey: "api_format_openai_chat"},
		{id: "openai_responses", labelKey: "api_format_openai_responses"},
		{id: "ollama_native", labelKey: "api_format_ollama_native"},
		{id: "gemini_native", labelKey: "api_format_gemini_native"},
		{id: "anthropic_messages", labelKey: "api_format_anthropic_messages"}
	]);
});
