const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

function createProviderPlugin(authKeys, requestHandler) {
	const plugin = createPluginInstance({
		bdfdb: {
			DataUtils: {
				load: (_plugin, key) => key == "authKeys" ? authKeys : {},
				save: () => {}
			},
			LibraryRequires: {
				request: requestHandler
			}
		}
	});
	plugin.forceUpdateAll();
	return plugin;
}

test("OpenAI, Gemini, and OpenAI-compatible providers stay distinct", () => {
	const plugin = createProviderPlugin({
		openai: {key: "openai-key"},
		gemini: {key: "gemini-key"},
		oaicompat: {key: "compat-key"}
	}, () => {});

	assert.equal(plugin.getEngineLabel("openai"), "OpenAI (Official API)");
	assert.equal(plugin.getEngineLabel("gemini"), "Google Gemini (Official API)");
	assert.equal(plugin.getEngineLabel("oaicompat"), "Custom API (OpenAI Compatible)");
	assert.equal(plugin.supportsAiAutoTranslateDecisionEngine("openai"), true);
	assert.equal(plugin.supportsAiAutoTranslateDecisionEngine("gemini"), true);
	assert.equal(plugin.isEngineConfiguredForRuntime("openai"), true);
	assert.equal(plugin.isEngineConfiguredForRuntime("gemini"), true);
	assert.equal(plugin.normalizeApiEndpoint("openai", "https://api.openai.com/v1"), "https://api.openai.com/v1/responses");
	assert.equal(plugin.normalizeApiEndpoint("oaicompat", "https://example.test/v1"), "https://example.test/v1/chat/completions");
});

test("OpenAI-compatible runtime rejects placeholder endpoint and model values", async () => {
	let requestCount = 0;
	const plugin = createProviderPlugin({
		oaicompat: {key: "compat-key"}
	}, (_url, _options, callback) => {
		requestCount++;
		callback(null, {statusCode: 404}, "not found");
	});

	assert.equal(plugin.isEngineConfiguredForRuntime("oaicompat"), false);
	assert.equal((await plugin.validateEngineConfig("oaicompat")).ok, false);
	assert.equal(requestCount, 0);

	const configured = createProviderPlugin({
		oaicompat: {
			key: "compat-key",
			endpoint: "https://translator.example.test/v1/chat/completions",
			model: "translator-model"
		}
	}, () => {});
	assert.equal(configured.isEngineConfiguredForRuntime("oaicompat"), true);
});

test("global settings keep channel-only provider credentials directly accessible", () => {
	const plugin = createProviderPlugin({}, () => {});
	plugin.settings.engines.translator = "googleapi";
	plugin.settings.engines.backup = "----";

	const keys = plugin.getAdditionalCredentialEngineKeys();
	assert.equal(keys.includes("openai"), true);
	assert.equal(keys.includes("gemini"), true);
	assert.equal(keys.includes("oaicompat"), true);

	plugin.settings.engines.translator = "openai";
	assert.equal(plugin.getAdditionalCredentialEngineKeys().includes("openai"), false);
});

test("AI decision availability follows configured channel engine overrides", () => {
	const plugin = createProviderPlugin({
		openai: {key: "openai-key"}
	}, () => {});
	plugin.settings.engines.translator = "googleapi";
	plugin.settings.engines.backup = "----";
	plugin.setChannelPrimaryEngine("channel-ai", "openai");

	assert.equal(plugin.isAiAutoTranslateDecisionAvailable(), true);
	assert.equal(plugin.isAiAutoTranslateDecisionAvailable("channel-ai"), true);

	const unconfigured = createProviderPlugin({}, () => {});
	unconfigured.settings.engines.translator = "openai";
	unconfigured.settings.engines.backup = "----";
	assert.equal(unconfigured.isAiAutoTranslateDecisionAvailable(), false);
});

test("official OpenAI provider uses the Responses API and parses output items", async () => {
	let captured = null;
	const plugin = createProviderPlugin({
		openai: {
			key: "openai-key",
			endpoint: "https://api.openai.com/v1/responses",
			model: "gpt-5.6-luna"
		}
	}, (url, options, callback) => {
		captured = {url, options};
		callback(null, {statusCode: 200}, JSON.stringify({
			output: [{type: "message", content: [{type: "output_text", text: "你好"}]}]
		}));
	});

	const translated = await new Promise(resolve => plugin.openAiTranslate({
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"},
		text: "hello",
		autoDecision: false
	}, resolve));
	const body = JSON.parse(captured.options.body);

	assert.equal(captured.url, "https://api.openai.com/v1/responses");
	assert.equal(captured.options.headers.Authorization, "Bearer openai-key");
	assert.equal(body.model, "gpt-5.6-luna");
	assert.equal(body.store, false);
	assert.equal(typeof body.instructions, "string");
	assert.match(body.input, /hello/);
	assert.equal(translated, "你好");
});

test("Gemini provider uses generateContent and parses candidate parts", async () => {
	let captured = null;
	const plugin = createProviderPlugin({
		gemini: {
			key: "gemini-key",
			endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
			model: "gemini-2.5-flash"
		}
	}, (url, options, callback) => {
		captured = {url, options};
		callback(null, {statusCode: 200}, JSON.stringify({
			candidates: [{content: {parts: [{text: "你好"}]}}]
		}));
	});

	const translated = await new Promise(resolve => plugin.geminiTranslate({
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"},
		text: "hello",
		autoDecision: false
	}, resolve));
	const body = JSON.parse(captured.options.body);

	assert.match(captured.url, /models\/gemini-2\.5-flash:generateContent\?key=gemini-key$/);
	assert.equal(body.contents[0].role, "user");
	assert.match(body.contents[0].parts[0].text, /hello/);
	assert.equal(translated, "你好");
});

test("official OpenAI batch translation keeps message IDs on the Responses API", async () => {
	const plugin = createProviderPlugin({
		openai: {key: "openai-key", endpoint: "https://api.openai.com/v1/responses", model: "gpt-5.6-luna"}
	}, (_url, _options, callback) => {
		callback(null, {statusCode: 200}, JSON.stringify({
			output: [{type: "message", content: [{type: "output_text", text: JSON.stringify([
				{id: "100", translation: "第一条"},
				{id: "200", translation: "第二条"}
			])}]}]
		}));
	});
	const preparedItems = ["100", "200"].map(id => ({
		message: {id},
		protectedText: `message ${id}`,
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"}
	}));

	assert.deepEqual(await plugin.requestAiBatchTranslation("openai", preparedItems), {
		"100": "第一条",
		"200": "第二条"
	});
});

test("Gemini batch translation uses its native response schema", async () => {
	let requestUrl = "";
	const plugin = createProviderPlugin({
		gemini: {key: "gemini-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.5-flash"}
	}, (url, _options, callback) => {
		requestUrl = url;
		callback(null, {statusCode: 200}, JSON.stringify({
			candidates: [{content: {parts: [{text: JSON.stringify([{id: "100", translation: "第一条"}])}]}}]
		}));
	});
	const preparedItems = [{
		message: {id: "100"},
		protectedText: "message 100",
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"}
	}];

	assert.deepEqual(await plugin.requestAiBatchTranslation("gemini", preparedItems), {"100": "第一条"});
	assert.match(requestUrl, /:generateContent\?key=gemini-key$/);
});

test("provider model catalogs use provider-specific endpoints and schemas", async () => {
	let capturedUrl = "";
	const plugin = createProviderPlugin({
		gemini: {key: "gemini-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models"}
	}, (url, _options, callback) => {
		capturedUrl = url;
		callback(null, {statusCode: 200}, JSON.stringify({
			models: [
				{name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"]},
				{name: "models/text-embedding", supportedGenerationMethods: ["embedContent"]}
			]
		}));
	});

	assert.equal(plugin.getModelCatalogEndpoint("openai", "https://api.openai.com/v1/responses"), "https://api.openai.com/v1/models");
	assert.deepEqual((await plugin.fetchModelCatalog("gemini")).items, ["gemini-2.5-flash"]);
	assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key");
});

test("official provider connection checks use their native generation APIs", async () => {
	const openAiPlugin = createProviderPlugin({
		openai: {key: "openai-key", endpoint: "https://api.openai.com/v1/responses", model: "gpt-5.6-luna"}
	}, (_url, _options, callback) => callback(null, {statusCode: 200}, JSON.stringify({output_text: "Guten Morgen"})));
	assert.equal((await openAiPlugin.validateEngineConfig("openai")).ok, true);

	let geminiUrl = "";
	const geminiPlugin = createProviderPlugin({
		gemini: {key: "gemini-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.5-flash"}
	}, (url, _options, callback) => {
		geminiUrl = url;
		callback(null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "Guten Morgen"}]}}]}));
	});
	assert.equal((await geminiPlugin.validateEngineConfig("gemini")).ok, true);
	assert.match(geminiUrl, /gemini-2\.5-flash:generateContent\?key=gemini-key$/);
});
