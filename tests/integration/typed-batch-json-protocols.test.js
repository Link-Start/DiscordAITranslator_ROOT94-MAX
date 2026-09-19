const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {createPluginInstance} = require("../helpers/createPluginInstance");

const BUNDLE = process.env.DTA_PLUGIN_PATH ? path.resolve(process.env.DTA_PLUGIN_PATH) : path.resolve(__dirname, "../../DiscordAITranslator.plugin.js");
const LEGACY_MARKER = "Messages JSON:\n";
const PROTOCOLS = [
	{protocol: "openai_chat", model: "fixture-model", endpoint: "https://json.test/v1/chat/completions"},
	{protocol: "openai_chat", model: "gemini-3.7-flash-high", endpoint: "https://json.test/v1/chat/completions"},
	{protocol: "openai_responses", model: "fixture-model", endpoint: "https://json.test/v1/responses"},
	{protocol: "gemini_native", model: "gemini-3.7-flash", endpoint: "https://json.test/v1beta/models"},
	{protocol: "ollama_native", model: "qwen3", endpoint: "http://localhost:11434/api/chat"},
	{protocol: "anthropic_messages", model: "claude-sonnet-4-6", endpoint: "https://json.test/v1/messages"},
	{engine: "openai", protocol: "openai_responses", model: "gpt-5.6", endpoint: "https://json.test/v1/responses"},
	{engine: "gemini", protocol: "gemini_native", model: "gemini-3.7-flash", endpoint: "https://json.test/v1beta/models"},
	{engine: "deepseek", protocol: "openai_chat", model: "deepseek-v4-flash", endpoint: "https://json.test/chat/completions"}
];

function userText(protocol, payload) {
	if (protocol === "openai_responses") return payload.input;
	if (protocol === "gemini_native") return payload.contents[0].parts[0].text;
	return payload.messages.at(-1).content;
}

function envelope(protocol, content) {
	if (protocol === "openai_responses") return {status: "completed", output: [{type: "message", content: [{type: "output_text", text: content}]}]};
	if (protocol === "gemini_native") return {candidates: [{content: {parts: [{text: content}]}, finishReason: "STOP"}]};
	if (protocol === "ollama_native") return {message: {content}, done: true};
	if (protocol === "anthropic_messages") return {content: [{type: "text", text: content}], stop_reason: "end_turn"};
	return {choices: [{message: {content}, finish_reason: "stop"}]};
}

function assertJsonFormat(protocol, payload, enabled) {
	const actual = {
		response_format: payload.response_format?.type === "json_schema" ? {type: "json_schema"} : payload.response_format,
		text: payload.text,
		responseMimeType: payload.generationConfig?.responseMimeType,
		format: payload.format,
		outputFormatType: payload.output_config?.format?.type
	};
	const expected = {response_format: undefined, text: undefined, responseMimeType: undefined, format: undefined, outputFormatType: undefined};
	if (enabled) {
		if (protocol === "openai_chat") expected.response_format = {type: payload.model === "gemini-3.7-flash-high" ? "json_schema" : "json_object"};
		if (protocol === "openai_responses") expected.text = {format: {type: "json_object"}};
		if (protocol === "gemini_native") expected.responseMimeType = "application/json";
		if (protocol === "ollama_native") expected.format = "json";
		if (protocol === "anthropic_messages") expected.outputFormatType = "json_schema";
	}
	assert.deepEqual(actual, expected);
	if (enabled && protocol === "openai_chat" && payload.model === "gemini-3.7-flash-high") {
		assert.equal(payload.response_format.json_schema.strict, true);
		assert.deepEqual(payload.response_format.json_schema.schema.required, ["messages"]);
		assert.deepEqual(payload.response_format.json_schema.schema.properties.messages.items.properties.segments.items.required, ["id", "translation"]);
	}
	if (enabled && protocol === "gemini_native") {
		const schema = payload.generationConfig.responseSchema;
		assert.equal(schema?.type, "object");
		assert.deepEqual(schema.required, ["messages"]);
		assert.deepEqual(schema.properties.messages.items.required, ["id", "segments"]);
		assert.deepEqual(schema.properties.messages.items.properties.segments.items.required, ["id", "translation"]);
	}
	else assert.equal(payload.generationConfig?.responseSchema, undefined);
}

async function runBatch(provider, malformed, extraBrace = false, formatted = false) {
	const requests = [], primary = "custom-jsonprotocol", engine = provider.engine || primary;
	const fetch = async (_url, options) => {
		const payload = JSON.parse(options.body);
		requests.push(payload);
		const prompt = userText(provider.protocol, payload);
		let wire; try {wire = JSON.parse(prompt);} catch {}
		let content;
		if (wire) {
			const messages = wire.messages.slice().reverse().map(message => ({id: message.id, segments: message.plan.segments.map(segment => ({id: segment.id, translation: formatted ? (message.id === "m1" ? "请在周五之前⟦F0⟧不要发布⟦/F0⟧这份草稿。" : "请在明天开会之前阅读⟦F0⟧更新后的日程表⟦/F0⟧。") : `译 ${message.id} ${segment.id}`}))}));
			content = malformed ? "Unreadable batch answer" : extraBrace ? '{"messages":[' + messages.map(message => JSON.stringify(message)).join("},") + "]}" : JSON.stringify({messages});
		}
		else {
			const start = prompt.indexOf(LEGACY_MARKER);
			assert.ok(start >= 0, "only the existing legacy fallback may follow a malformed answer");
			content = JSON.stringify(JSON.parse(prompt.slice(start + LEGACY_MARKER.length)).map(item => ({id: item.id, translation: `旧译 ${item.id}`})));
		}
		return {status: 200, headers: {get: () => "application/json"}, text: async () => JSON.stringify(envelope(provider.protocol, content))};
	};
	const request = (url, options, callback) => {let cancelled = false; fetch(url, options).then(async result => {if (!cancelled) callback(null, {statusCode: result.status, headers: {}}, await result.text());}, error => {if (!cancelled) callback(error);}); return {abort() {cancelled = true;}};};
	const css = new Proxy({}, {get: (_, name) => typeof name === "symbol" ? undefined : "." + String(name)});
	// Built-ins can receive prepared typed items from a custom primary's backup path.
	// Keep the production eligibility gate: this does not enable typed mode for built-in primaries.
	const settings = {engines: {translator: primary, backup: provider.engine || "----", customProviders: [{id: primary, name: "Fixture"}]}, choices: {received: {input: "en", output: "zh-CN"}, sent: {input: "en", output: "zh-CN"}}};
	const plugin = createPluginInstance({pluginPath: BUNDLE, callSetLanguages: false, settings, bdfdb: {LibraryRequires: {request}, dotCN: css, dotCNS: css}});
	global.BdApi.Net = {fetch};
	try {
		plugin.onLoad();
		Object.assign(plugin.settings, settings);
		plugin.setLanguages();
		const auth = {key: "fixture-key", endpoint: provider.endpoint, model: provider.model, interfaceFormat: provider.protocol};
		plugin.ensureSettingsStore().replaceAuthKeys({[primary]: auth, [engine]: auth});
		plugin.isTranslationEnabled = () => true;
		const sources = formatted ? ["Please **do not publish** the draft before Friday.", "Please read [the updated schedule](https://example.com/schedule) before the meeting tomorrow."] : ["Please review the updated schedule.", "The delivery will arrive tomorrow."];
		const items = sources.map((source, index) => {
			const semanticRequest = plugin.createAtomicSemanticRevisionContract(source, {place: "received", engineKey: engine, inputLanguageId: "en", targetLanguageId: "zh-CN", fieldPath: "body", attempt: 1, maxAttempts: 3});
			assert.ok(semanticRequest.enabled);
			const legacy = plugin.removeExceptions(source, "received");
			return {message: {id: String(9001 + index)}, channelId: "json-protocols", input: {id: "en", name: "English"}, output: {id: "zh-CN", name: "Chinese"}, semanticRequest, protectedText: semanticRequest.wire, legacyProtectedText: legacy[0], legacyExceptions: legacy[1]};
		});
		const outcome = await plugin.ensureProviderClient().requestAiBatchTranslationDetailed(engine, items);
		const restored = formatted ? items.map(item => plugin.validateAtomicSemanticResponse(item.semanticRequest, {segments: outcome.translations[item.message.id].semanticSegments})) : [];
		return {requests, outcome, restored};
	}
	finally {try {await plugin.onStop();} finally {delete global.BdApi.Net;}}
}

for (const provider of PROTOCOLS) for (const malformed of [false, true]) test(`${provider.engine || "custom " + provider.protocol + " " + provider.model}: typed JSON parameter ${malformed ? "is removed for the existing legacy fallback" : "reaches the network in one request"}`, async () => {
	const {requests, outcome} = await runBatch(provider, malformed);
	assert.equal(outcome.failureKind, null);
	assert.equal(requests.length, malformed ? 2 : 1, "no capability probe or extra retry");
	assertJsonFormat(provider.protocol, requests[0], true);
	if (malformed) {
		assertJsonFormat(provider.protocol, requests[1], false);
		assert.deepEqual(outcome.translations, {"9001": "旧译 9001", "9002": "旧译 9002"});
	}
	else assert.deepEqual(outcome.translations, {"9001": {semanticSegments: [{id: "s1", translation: "译 m1 s1"}]}, "9002": {semanticSegments: [{id: "s1", translation: "译 m2 s1"}]}}, "reordered answers still map by ID");
});

for (const provider of PROTOCOLS) test(`${provider.protocol} ${provider.model}: formatted sentences retain meaning and local destinations in one batch request`, async () => {
	const {requests, outcome, restored} = await runBatch(provider, false, false, true);
	assert.equal(outcome.failureKind, null);
	assert.equal(requests.length, 1);
	assertJsonFormat(provider.protocol, requests[0], true);
	const wire = JSON.parse(userText(provider.protocol, requests[0]));
	assert.deepEqual(wire.messages.map(message => message.plan.segments.map(segment => segment.text)), [
		["Please ⟦F0⟧do not publish⟦/F0⟧ the draft before Friday."],
		["Please read ⟦F0⟧the updated schedule⟦/F0⟧ before the meeting tomorrow."]
	]);
	assert.doesNotMatch(JSON.stringify(requests[0]), /https:\/\/example\.com\/schedule/);
	assert.equal((JSON.stringify(requests[0]).match(/Paired ⟦F0⟧/g) || []).length, 1, "one instruction for the whole batch");
	assert.ok(restored.every(result => result.ok));
	assert.deepEqual(restored.map(result => result.translation), ["请在周五之前**不要发布**这份草稿。", "请在明天开会之前阅读[更新后的日程表](https://example.com/schedule)。"]);
});

for (const provider of PROTOCOLS) test(`${provider.engine || "custom " + provider.protocol}: an extra closing brace does not resend complete translations`, async () => {
	const {requests, outcome} = await runBatch(provider, false, true);
	assert.equal(outcome.failureKind, null);
	assert.equal(requests.length, 1, "intact message objects must avoid the legacy fallback request");
	assert.deepEqual(outcome.translations, {"9001": {semanticSegments: [{id: "s1", translation: "译 m1 s1"}]}, "9002": {semanticSegments: [{id: "s1", translation: "译 m2 s1"}]}});
});
