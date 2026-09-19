const {createOpenAiChatAdapter} = require("./openai-chat-adapter");
const {createOpenAiResponsesAdapter} = require("./openai-responses-adapter");
const {createOllamaNativeAdapter} = require("./ollama-native-adapter");
const {createGeminiNativeAdapter} = require("./gemini-native-adapter");
const {createAnthropicMessagesAdapter} = require("./anthropic-messages-adapter");

function createProtocolAdapterRegistry(adapters = []) {
	const byId = new Map();
	for (const adapter of adapters) {
		if (!adapter || typeof adapter.id != "string" || !adapter.id || byId.has(adapter.id)) continue;
		byId.set(adapter.id, adapter);
	}
	const items = Object.freeze(Array.from(byId.values()));
	return Object.freeze({
		get: id => byId.get(String(id || "")) || null,
		list: ({uiReadyOnly = false} = {}) => uiReadyOnly ? Object.freeze(items.filter(adapter => adapter.uiReady)) : items
	});
}

module.exports = {createOpenAiChatAdapter, createOpenAiResponsesAdapter, createOllamaNativeAdapter, createGeminiNativeAdapter, createAnthropicMessagesAdapter, createProtocolAdapterRegistry};
