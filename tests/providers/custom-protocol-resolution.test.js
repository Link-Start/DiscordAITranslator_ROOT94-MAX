const test = require("node:test");
const assert = require("node:assert/strict");
const {
	normalizeCustomInterfaceFormat,
	resolveCustomProtocol,
	createInterfaceDetection
} = require("../../src/providers/custom-protocol-resolution");

function registry(ids = ["openai_chat", "openai_responses", "ollama_native", "gemini_native", "anthropic_messages"]) {
	const map = new Map(ids.map(id => [id, Object.freeze({id, version: 1})]));
	return Object.freeze({get: id => map.get(id) || null});
}

test("custom protocol format normalization treats missing and unknown additive values as auto", () => {
	assert.equal(normalizeCustomInterfaceFormat(undefined), "auto");
	assert.equal(normalizeCustomInterfaceFormat("auto"), "auto");
	assert.equal(normalizeCustomInterfaceFormat("openai_chat"), "openai_chat");
	assert.equal(normalizeCustomInterfaceFormat("openai_responses"), "openai_responses");
	assert.equal(normalizeCustomInterfaceFormat("ollama_native"), "ollama_native");
	assert.equal(normalizeCustomInterfaceFormat("gemini_native"), "gemini_native");
	assert.equal(normalizeCustomInterfaceFormat("anthropic_messages"), "anthropic_messages");
	assert.equal(normalizeCustomInterfaceFormat("future"), "auto");
});

test("Anthropic Messages is inferred from its native path or official host without stealing OpenAI paths", () => {
	for (const endpoint of ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages", "https://relay.test/v1/messages"]) assert.equal(resolveCustomProtocol({endpoint, interfaceFormat: "auto", registry: registry()}).resolved, "anthropic_messages", endpoint);
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1/chat/completions", interfaceFormat: "auto", registry: registry()}).resolved, "openai_chat");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1", interfaceFormat: "anthropic_messages", registry: registry()}).resolved, "anthropic_messages");
});

test("Gemini native is inferred from generateContent and native models paths without stealing other formats", () => {
	for (const endpoint of ["https://generativelanguage.googleapis.com/v1beta/models", "https://relay.test/v1beta/models", "https://relay.test/v1beta/models/gemini-2.5-flash:generateContent"]) {
		assert.equal(resolveCustomProtocol({endpoint, interfaceFormat: "auto", registry: registry()}).resolved, "gemini_native", endpoint);
	}
	assert.equal(resolveCustomProtocol({endpoint: "http://localhost:11434/api/chat", interfaceFormat: "auto", registry: registry()}).resolved, "ollama_native");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1/responses", interfaceFormat: "auto", registry: registry()}).resolved, "openai_responses");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1", interfaceFormat: "gemini_native", registry: registry()}).resolved, "gemini_native");
});

test("Ollama native is inferred only from its native path or default local port", () => {
	for (const endpoint of ["http://localhost:11434", "http://127.0.0.1:11434/", "https://relay.test/api/chat", "https://relay.test/api/tags"]) {
		assert.equal(resolveCustomProtocol({endpoint, interfaceFormat: "auto", registry: registry()}).resolved, "ollama_native", endpoint);
	}
	assert.equal(resolveCustomProtocol({endpoint: "http://localhost:11434/v1", interfaceFormat: "auto", registry: registry()}).resolved, "openai_chat", "OpenAI compatibility paths remain Chat");
	assert.equal(resolveCustomProtocol({endpoint: "http://localhost:11434/v1/chat/completions", interfaceFormat: "auto", registry: registry()}).resolved, "openai_chat");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1/responses", interfaceFormat: "auto", registry: registry()}).resolved, "openai_responses");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1", interfaceFormat: "ollama_native", registry: registry()}).resolved, "ollama_native");
});

test("path evidence revives an old Responses endpoint while ordinary legacy endpoints stay on Chat", () => {
	const endpoint = "https://relay.test/v1/responses";
	assert.deepEqual(resolveCustomProtocol({endpoint, interfaceFormat: undefined, registry: registry()}), {
		requested: "auto", resolved: "openai_responses", evidence: "path", endpointKey: endpoint, adapterVersion: 1
	});
	assert.deepEqual(resolveCustomProtocol({endpoint, interfaceFormat: "auto", registry: registry()}), {
		requested: "auto", resolved: "openai_responses", evidence: "path", endpointKey: endpoint, adapterVersion: 1
	});
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1", interfaceFormat: undefined, registry: registry()}).resolved, "openai_chat");
});

test("explicit format wins and auto reuses only matching persisted detection", () => {
	const endpoint = "https://relay.test/v1";
	assert.equal(resolveCustomProtocol({endpoint, interfaceFormat: "openai_responses", registry: registry()}).resolved, "openai_responses");
	const detection = createInterfaceDetection({resolved: "openai_responses", endpointKey: endpoint, evidence: "validation", adapterVersion: 1, checkedAt: 10});
	assert.equal(resolveCustomProtocol({endpoint, interfaceFormat: "auto", interfaceDetection: detection, registry: registry()}).resolved, "openai_responses");
	assert.equal(resolveCustomProtocol({endpoint: "https://other.test/v1", interfaceFormat: "auto", interfaceDetection: detection, registry: registry()}).resolved, "openai_chat", "endpoint changes retire protocol evidence");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1/chat/completions", interfaceFormat: "auto", interfaceDetection: detection, registry: registry()}).resolved, "openai_chat", "deterministic path evidence outranks persisted detection");
});

test("unavailable or ambiguous formats safely resolve to legacy Chat without a request", () => {
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1/responses", interfaceFormat: "auto", registry: registry(["openai_chat"])}).resolved, "openai_chat");
	assert.equal(resolveCustomProtocol({endpoint: "https://relay.test/v1", interfaceFormat: "auto", registry: registry()}).resolved, "openai_chat");
	assert.equal(resolveCustomProtocol({endpoint: "not a url", interfaceFormat: "auto", registry: registry()}).resolved, "openai_chat");
});
