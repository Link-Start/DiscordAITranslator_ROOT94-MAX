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

	// Rail vocabulary from the approved redesign draft: short provider names.
	assert.equal(plugin.getEngineLabel("openai"), "OpenAI");
	assert.equal(plugin.getEngineLabel("gemini"), "Gemini");
	assert.equal(plugin.getEngineLabel("oaicompat"), "Custom provider");
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

test("retired provider selections migrate to the keyless default and no backup", () => {
	const plugin = createProviderPlugin({}, () => {});
	const saves = [];
	plugin._testBdfdb.DataUtils.save = (value, _plugin, key) => saves.push({value: {...value}, key});
	plugin.settings.engines.translator = "itranslate";
	plugin.settings.engines.backup = "yandex";

	plugin.setLanguages();

	assert.equal(plugin.settings.engines.translator, "googleapi");
	assert.equal(plugin.settings.engines.backup, "----");
	assert.deepEqual(saves.at(-1), {value: {translator: "googleapi", backup: "----"}, key: "engines"});
});

test("a primary and backup collision clears the backup instead of choosing another provider", () => {
	const plugin = createProviderPlugin({}, () => {});
	const saves = [];
	plugin._testBdfdb.DataUtils.save = (value, _plugin, key) => saves.push({value: {...value}, key});
	plugin.settings.engines.translator = "deepseek";
	plugin.settings.engines.backup = "deepseek";

	plugin.setLanguages();

	assert.deepEqual(plugin.settings.engines, {translator: "deepseek", backup: "----"});
	assert.deepEqual(saves.at(-1), {value: {translator: "deepseek", backup: "----"}, key: "engines"});
});

test("Papago exposes only documented fixed language pairs to runtime selection", () => {
	const plugin = createProviderPlugin({}, () => {});
	assert.equal(plugin.engineSupportsLanguagePair("papago", {id: "en"}, {id: "ja"}), true);
	assert.equal(plugin.engineSupportsLanguagePair("papago", {id: "ko"}, {id: "zh-CN"}), true);
	assert.equal(plugin.engineSupportsLanguagePair("papago", {id: "es"}, {id: "fr"}), false);
	assert.equal(plugin.engineSupportsLanguagePair("papago", {id: "auto", auto: true}, {id: "ko"}), true, "auto detection is validated after Papago reports the source");
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

	assert.match(captured.url, /models\/gemini-2\.5-flash:generateContent$/);
	assert.equal(captured.options.headers["x-goog-api-key"], "gemini-key");
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
	let captured = null;
	const plugin = createProviderPlugin({
		gemini: {key: "gemini-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.5-flash"}
	}, (url, options, callback) => {
		captured = {url, options};
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
	assert.match(captured.url, /:generateContent$/);
	assert.equal(captured.options.headers["x-goog-api-key"], "gemini-key");
});

test("provider model catalogs use provider-specific endpoints and schemas", async () => {
	let captured = null;
	const plugin = createProviderPlugin({
		gemini: {key: "gemini-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models"}
	}, (url, options, callback) => {
		captured = {url, options};
		callback(null, {statusCode: 200}, JSON.stringify({
			models: [
				{name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"]},
				{name: "models/text-embedding", supportedGenerationMethods: ["embedContent"]}
			]
		}));
	});

	assert.equal(plugin.getModelCatalogEndpoint("openai", "https://api.openai.com/v1/responses"), "https://api.openai.com/v1/models");
	assert.deepEqual((await plugin.fetchModelCatalog("gemini")).items, ["gemini-2.5-flash"]);
	assert.equal(captured.url, "https://generativelanguage.googleapis.com/v1beta/models");
	assert.equal(captured.options.headers["x-goog-api-key"], "gemini-key");
});

test("official provider connection checks use their native generation APIs", async () => {
	const openAiPlugin = createProviderPlugin({
		openai: {key: "openai-key", endpoint: "https://api.openai.com/v1/responses", model: "gpt-5.6-luna"}
	}, (_url, _options, callback) => callback(null, {statusCode: 200}, JSON.stringify({output_text: "Guten Morgen"})));
	assert.equal((await openAiPlugin.validateEngineConfig("openai")).ok, true);

	let geminiRequest = null;
	const geminiPlugin = createProviderPlugin({
		gemini: {key: "gemini-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.5-flash"}
	}, (url, options, callback) => {
		geminiRequest = {url, options};
		callback(null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "Guten Morgen"}]}}]}));
	});
	assert.equal((await geminiPlugin.validateEngineConfig("gemini")).ok, true);
	assert.match(geminiRequest.url, /gemini-2\.5-flash:generateContent$/);
	assert.equal(geminiRequest.options.headers["x-goog-api-key"], "gemini-key");
});

test("the silent-auto watchdog never fires before the request timeout window closes", () => {
	const intervals = [];
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			TimeUtils: {
				clear: () => {},
				interval: (callback, delay) => {
					intervals.push({callback, delay});
					return intervals.length;
				},
				timeout: () => 0
			}
		}
	});
	plugin.setLanguages();
	plugin.settings.engines.translator = "googleapi";
	plugin.settings.engines.backup = "----";
	plugin.getLanguageChoice = direction => direction == "input" ? "auto" : "zh-CN";
	plugin.googleApiTranslate = () => {};

	let finished = false;
	plugin.translateText("short message", "received", () => {finished = true;}, null, {
		showToast: false,
		showFailureToast: false,
		trackBusy: false,
		auto: true,
		channelId: "channel-watchdog"
	});

	assert.equal(intervals.length, 1);
	const {callback, delay} = intervals[0];
	// The watchdog must not give up before requestWithTimeout's 30s window: with a
	// 500ms tick that means at least 60 ticks before finishTranslation("") fires.
	const minimumTicks = Math.ceil(30000 / delay);
	for (let count = 0; count < minimumTicks; count++) callback(null, count);
	assert.equal(finished, false, "watchdog fired before the provider timeout");
});

test("locally recomputable skip reasons do not occupy paid translation cache slots", () => {
	const plugin = createPluginInstance({callSetLanguages: false});

	plugin.persistReceivedSkipDecision("skip-symbol", "sig-1", "symbol_only", ":emoji:");
	plugin.persistReceivedSkipDecision("skip-link", "sig-2", "link_only", "https://example.invalid");
	plugin.persistReceivedSkipDecision("skip-lang", "sig-3", "same_language", "已是中文");

	assert.equal(plugin.hasCachedTranslationEntry("skip-symbol"), false, "symbol_only must not persist");
	assert.equal(plugin.hasCachedTranslationEntry("skip-link"), false, "link_only must not persist");
	assert.equal(plugin.hasCachedTranslationEntry("skip-lang"), true, "same_language genuinely saves a request and stays");
});

test("persisted cache entries store a compact signature and keep existing raw entries valid", () => {
	const saved = [];
	const plugin = createPluginInstance({
		callSetLanguages: false,
		bdfdb: {
			DataUtils: {
				load: () => ({}),
				save: (value, _plugin, key) => {saved.push({key, value});}
			}
		}
	});
	const message = {id: "cache-compact-1", channel_id: "channel-cache", content: "hello world", embeds: [], attachments: [], author: {id: "other-user"}};
	const contentData = {content: message.content, embeds: []};
	const signature = plugin.createReceivedTranslationSignature(message, "channel-cache", contentData);
	const storedTranslation = {
		signature,
		channelId: "channel-cache",
		auto: true,
		content: "你好世界",
		translatedContent: "你好世界",
		originalContent: "hello world",
		embeds: {}
	};

	plugin.persistTranslationCacheEntry(message.id, signature, storedTranslation);
	const persisted = plugin.getPersistedTranslationCacheEntry(message.id);

	assert.ok(persisted, "the entry must persist");
	assert.ok(persisted.signature.length < signature.length / 4, `persisted signature must be compact, got ${persisted.signature.length} vs raw ${signature.length}`);
	assert.equal(persisted.translation.signature, undefined, "the duplicated inner signature must not persist");
	// The compact form still matches the same source.
	assert.ok(plugin.getCachedReceivedTranslation(message, "channel-cache", contentData), "a compact entry must still hit");

	// A pre-existing raw-signature entry (from an older version) must keep working.
	plugin.seedRawTranslationCacheEntryForTest("cache-legacy-1", signature, storedTranslation);
	const legacyMessage = Object.assign({}, message, {id: "cache-legacy-1"});
	assert.ok(plugin.getCachedReceivedTranslation(legacyMessage, "channel-cache", contentData), "a legacy raw-signature entry must still hit");
});

test("batch prompts carry the user's AI skip rules when the channel uses AI decision mode", async () => {
	let capturedBody = null;
	const plugin = createProviderPlugin({
		deepseek: {key: "deepseek-key", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash"}
	}, (_url, options, callback) => {
		capturedBody = JSON.parse(options.body);
		callback(null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "[]"}}]}));
	});
	plugin.settings.engines.translator = "deepseek";
	plugin.settings.filters.autoTranslateDecisionMode = "ai";
	plugin.settings.filters.aiAutoTranslatePrompt = "只翻译非目标语言内容。DISTINCT-USER-RULE";
	const preparedItems = [{
		message: {id: "100"},
		channelId: "channel-ai-batch",
		protectedText: "hello there",
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"}
	}];

	await plugin.requestAiBatchTranslation("deepseek", preparedItems);
	const prompt = capturedBody.messages.map(entry => entry.content).join("\n");

	assert.match(prompt, /DISTINCT-USER-RULE/, "the user's own decision prompt must reach the batch request");
	assert.match(prompt, /__SKIP_TRANSLATION__/, "the batch must be allowed to answer with a skip verdict");
	assert.doesNotMatch(prompt, /do not make skip decisions/, "the no-skip instruction must not contradict AI decision mode");
});

test("batch prompts forbid skip verdicts when AI decision mode is off", async () => {
	let capturedBody = null;
	const plugin = createProviderPlugin({
		deepseek: {key: "deepseek-key", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash"}
	}, (_url, options, callback) => {
		capturedBody = JSON.parse(options.body);
		callback(null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "[]"}}]}));
	});
	plugin.settings.engines.translator = "deepseek";
	plugin.settings.filters.autoTranslateDecisionMode = "local";
	const preparedItems = [{
		message: {id: "100"},
		channelId: "channel-local-batch",
		protectedText: "hello there",
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"}
	}];

	await plugin.requestAiBatchTranslation("deepseek", preparedItems);
	const prompt = capturedBody.messages.map(entry => entry.content).join("\n");

	assert.match(prompt, /do not make skip decisions/);
});

test("custom provider registration mutates the shared engine tables in place", () => {
	const {translationEngines, syncCustomEngines, isCustomEngineKey, normalizeCustomProviders, AI_MODEL_ENGINES} = require("../src/providers/provider-client");

	assert.equal(isCustomEngineKey("custom-abc123"), true);
	assert.equal(isCustomEngineKey("oaicompat"), false);
	assert.equal(isCustomEngineKey("custom-"), false);

	// Junk entries are dropped, duplicates collapse, names trim.
	assert.deepEqual(normalizeCustomProviders([
		{id: "custom-a1", name: "  My relay  "},
		{id: "custom-a1", name: "dupe"},
		{id: "not-custom", name: "x"},
		null,
		{id: "oaicompat", name: "First slot"}
	]), [{id: "custom-a1", name: "My relay"}, {id: "oaicompat", name: "First slot"}]);

	// Registration mutates the shared tables so plain key lookups work everywhere.
	syncCustomEngines({customProviders: [{id: "custom-a1", name: "My relay"}, {id: "oaicompat", name: "First slot"}]});
	assert.ok(translationEngines["custom-a1"]);
	assert.equal(translationEngines["custom-a1"].name, "My relay");
	assert.equal(translationEngines["custom-a1"].funcName, "openAiCompatibleTranslate");
	assert.equal(translationEngines.oaicompat.name, "First slot");
	assert.equal(translationEngines.oaicompat.custom, true);
	assert.equal(AI_MODEL_ENGINES.includes("custom-a1"), true);

	// An emptied list unregisters the engine and restores the oaicompat identity.
	syncCustomEngines({customProviders: []});
	assert.equal(translationEngines["custom-a1"], undefined);
	assert.equal(AI_MODEL_ENGINES.includes("custom-a1"), false);
	assert.equal(translationEngines.oaicompat.custom, false);
	assert.equal(translationEngines.oaicompat.name, "OpenAI Compatible");
});

test("custom OpenAI-compatible providers rename, translate and fall back on delete", async () => {
	// A configured custom engine translates through the chat-completions adapter
	// with its own credentials, and the plugin resolves its label from settings.
	let requestedUrl = "";
	let requestedAuth = "";
	const plugin = createProviderPlugin({
		"custom-a1": {key: "relay-key", endpoint: "https://relay.example.test/v1/chat/completions", model: "relay-model"}
	}, (url, options, callback) => {
		requestedUrl = typeof url == "string" ? url : url && url.url || "";
		requestedAuth = options && options.headers && options.headers.Authorization || "";
		callback(null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "hallo"}}]}));
	});
	plugin.settings.engines.customProviders = [{id: "custom-a1", name: "My relay"}];
	plugin.setLanguages();
	assert.equal(plugin.getEngineLabel("custom-a1"), "My relay");
	assert.equal(plugin.isEngineConfiguredForRuntime("custom-a1"), true);
	const translated = await new Promise(resolve => plugin.openAiCompatibleTranslate({
		input: {id: "en", name: "English"},
		output: {id: "de", name: "German"},
		text: "hello",
		engine: {id: "custom-a1", funcName: "openAiCompatibleTranslate"}
	}, resolve));
	assert.equal(translated, "hallo");
	assert.match(requestedUrl, /relay\.example\.test/);
	assert.match(requestedAuth, /relay-key/);

	// Removing the entry unregisters the engine and the selection falls back.
	plugin.settings.engines.translator = "custom-a1";
	plugin.settings.engines.customProviders = [];
	plugin.setLanguages();
	assert.equal(plugin.isEngineConfiguredForRuntime("custom-a1"), false);
	assert.equal(plugin.settings.engines.translator, "googleapi");
});
