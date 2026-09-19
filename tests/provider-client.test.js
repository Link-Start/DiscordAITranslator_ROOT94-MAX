const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {createReasoningRawKey} = require("../src/settings/reasoning-raw-value");
const {createProviderAttemptOwner, createProviderCompatibilityBudget} = require("../src/providers/provider-attempt-owner");
const {createAbortableProviderTransport} = require("../src/providers/abortable-provider-transport");
const {createHistoricalProviderBudgetOwner} = require("../src/orchestrator/historical-provider-budget-owner");
const {
	AI_SKIP_TRANSLATION_TOKEN,
	SYNTHETIC_BENCHMARK_TEXTS,
	PROVIDER_REQUEST_TIMEOUT_MS,
	translationEngines,
	enginePortals,
	syncCustomEngines,
	MD5,
	normalizeApiEndpoint,
	getModelCatalogEndpoint,
	isSameEndpointOrigin,
	mapLanguageCodeForEngine,
	getValidationErrorDetails,
	getSafeProviderErrorParameter,
	classifyProviderRequestError,
	getRegisteredCustomProtocolAdapterIds,
	buildAiProviderTranslationPrompt,
	parseOpenAiResponseText,
	parseGeminiResponseText,
	parseAiBatchTranslationResponse,
	normalizeStoredModelCatalogs,
	createProviderClient
} = require("../src/providers/provider-client");

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// The fake HTTP function never answers on its own: a test drives every response, so
// "the callback never came" is a state the tests can actually reach.
function createHarness({authKeys = {}, languages = {}, aiDecision = false, aiPrompt = "USER-RULE", modelCatalogs = {}, streamTransport = null, providerAttemptOwner = null, isLiveStreamingEnabled = () => true} = {}) {
	const calls = [];
	const toasts = [];
	const timers = [];
	const sleeps = [];
	const saves = [];
	const backoffNotices = [];
	const normalizedNotices = [];
	const modelCatalogSaves = [];
	const tierStates = [];
	const latencyBegins = [];
	const latencyEvents = [];
	let latencySequence = 0;
	let clock = 1000;
	const state = JSON.parse(JSON.stringify(authKeys));

	const harness = {
		calls,
		toasts,
		timers,
		sleeps,
		saves,
		backoffNotices,
		normalizedNotices,
		modelCatalogSaves,
		tierStates,
		latencyBegins,
		latencyEvents,
		authKeys: state,
		advance(ms) {clock += ms;},
		respond(index, error, response, body) {
			calls[index].callback(error, response, body);
		},
		fireTimer(index) {
			const timer = timers[index];
			assert.equal(timer.cleared, false, "a cleared timer must not fire");
			timer.fired = true;
			timer.callback();
		},
		lastCall() {
			return calls[calls.length - 1];
		},
		lastBody() {
			return JSON.parse(calls[calls.length - 1].options.body);
		}
	};

	harness.client = createProviderClient({
		// production wires this in from the settings store; the tests use the real one
		// so a tagged key never diverges between storage and cache identity
		createReasoningRawKey,
		request: (url, options, callback) => {
			calls.push({url, options, callback});
		},
		setTimeout: (callback, delay) => {
			const timer = {callback, delay, cleared: false, fired: false};
			timers.push(timer);
			return timer;
		},
		clearTimeout: timer => {
			if (timer) timer.cleared = true;
		},
		sleep: ms => {
			sleeps.push(ms);
			return Promise.resolve();
		},
		now: () => clock,
		getAuthKeys: () => state,
		saveAuthKeys: value => saves.push(JSON.parse(JSON.stringify(value))),
		getReasoningModelPref: (engineKey, modelId) => state[engineKey] && state[engineKey].reasoningModels && state[engineKey].reasoningModels[modelId] || null,
		setReasoningModelPref: (engineKey, modelId, preference) => {
			if (!state[engineKey]) state[engineKey] = {};
			if (!state[engineKey].reasoningModels) state[engineKey].reasoningModels = {};
			state[engineKey].reasoningModels[modelId] = JSON.parse(JSON.stringify(preference));
			return state[engineKey].reasoningModels[modelId];
		},
		setReasoningModelCapability: (engineKey, modelId, capability) => {
			if (!state[engineKey]) state[engineKey] = {};
			if (!state[engineKey].reasoningModels) state[engineKey].reasoningModels = {};
			const current = state[engineKey].reasoningModels[modelId] || {};
			state[engineKey].reasoningModels[modelId] = Object.assign({}, current, {capability: JSON.parse(JSON.stringify(capability))});
			return state[engineKey].reasoningModels[modelId];
		},
		setReasoningModelTierState: (engineKey, modelId, raw, tierState) => {
			tierStates.push({engineKey, modelId, raw, state: tierState && tierState.state || null});
			return tierState;
		},
		clearReasoningModelCapability: (engineKey, modelId) => {
			const current = state[engineKey] && state[engineKey].reasoningModels && state[engineKey].reasoningModels[modelId];
			if (!current) return null;
			current.capability = null;
			return current;
		},
		setInterfaceDetection: (engineKey, detection) => {
			if (!state[engineKey]) state[engineKey] = {};
			state[engineKey].interfaceDetection = JSON.parse(JSON.stringify(detection));
			return state[engineKey].interfaceDetection;
		},
		clearInterfaceDetection: engineKey => {
			if (!state[engineKey] || !Object.prototype.hasOwnProperty.call(state[engineKey], "interfaceDetection")) return false;
			delete state[engineKey].interfaceDetection;
			return true;
		},
		loadModelCatalogs: () => JSON.parse(JSON.stringify(modelCatalogs)),
		saveModelCatalogs: value => modelCatalogSaves.push(JSON.parse(JSON.stringify(value))),
		getLanguages: () => languages,
		notify: (message, options) => {
			const entry = {message, options, closed: false};
			toasts.push(entry);
			return {close: () => {entry.closed = true;}};
		},
		getLabels: () => ({
			toast_translating_failed: "FAILED",
			toast_translating_tryanother: "TRYANOTHER",
			error_hourlylimit: "HOURLY",
			error_dailylimit: "DAILY",
			error_monthlylimit: "MONTHLY",
			error_keyoutdated: "KEYOUTDATED",
			error_serverdown: "SERVERDOWN"
		}),
		getCustomText: key => `TEXT:${key}`,
		getEngineLabel: engineKey => `LABEL:${engineKey}`,
		shouldUseAiAutoTranslateDecision: () => aiDecision,
		getAiAutoTranslatePrompt: () => aiPrompt,
		beginLatencyRequest: options => {
			latencyBegins.push(options);
			return Object.freeze({requestId: ++latencySequence, generation: 0, kind: options.kind, queueWaitMs: options.queueWaitMs == null ? null : options.queueWaitMs, messageCount: options.messageCount || 1, inputChars: options.inputChars == null ? null : options.inputChars});
		},
		recordLatencyEvent: event => latencyEvents.push(event),
		streamTransport,
		providerAttemptOwner,
		isLiveStreamingEnabled,
		createElementFromHtml: html => ({
			querySelector: selector => {
				const match = new RegExp(`<${selector}(?: lang="([^"]*)")?>([^<]*)</${selector}>`).exec(html);
				if (!match) return null;
				return {innerText: match[2], getAttribute: () => match[1]};
			}
		}),
		generateId: () => "SALT",
		onEndpointNormalized: () => normalizedNotices.push(true),
		onBackoffScheduled: () => backoffNotices.push(true)
	});
	return harness;
}

function streamFrames(text = "流式译文") {
	return [
		new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: text}, finish_reason: "stop"}]})}\n\n`),
		new TextEncoder().encode("data: [DONE]\n\n")
	];
}

function streamReader(parts) {
	let index = 0;
	return {
		read: async () => index < parts.length ? {done: false, value: parts[index++]} : {done: true, value: undefined},
		cancel: () => Promise.resolve()
	};
}

function liveRequestData(harness, overrides = {}) {
	const compatibilityBudget = overrides.compatibilityBudget || createProviderCompatibilityBudget();
	const requestContext = Object.freeze({logicalRequestId: "live-fixture", signal: null, isCurrent: () => true, compatibilityBudget});
	const token = Object.freeze({requestId: 9001, generation: 0, kind: "live", queueWaitMs: 0, messageCount: 1, inputChars: 11});
	return translationData(Object.assign({
		engine: {id: "oaicompat"},
		requestContext,
		timingContext: {token, role: "primary", engineKey: "oaicompat", messageCount: 1, requestContext}
	}, overrides, {requestContext: overrides.requestContext || requestContext}));
}

function scriptedStreamTransport(owner, scripts, textScripts = []) {
	const calls = [];
	const textCalls = [];
	return {
		calls,
		textCalls,
		async openStream(args) {
			calls.push(args);
			const next = typeof scripts[0] == "function" ? scripts.shift()(args) : scripts.shift();
			if (!next || !next.ok) {
				owner.finish(args.token);
				return Object.freeze(Object.assign({ok: false, errorKind: "network", status: 0}, next || {}));
			}
			owner.attachReader(args.token, next.reader);
			return Object.freeze({
				ok: true,
				errorKind: null,
				status: next.status || 200,
				contentType: "text/event-stream",
				reader: next.reader,
				finish: () => owner.finish(args.token),
				abort: reason => owner.abort(args.token, reason)
			});
		},
		async requestText(args) {
			textCalls.push(args);
			const next = typeof textScripts[0] == "function" ? textScripts.shift()(args) : textScripts.shift();
			owner.finish(args.token);
			return Object.freeze(Object.assign({ok: false, errorKind: "network", status: 0, body: ""}, next || {}));
		}
	};
}

const AI_AUTH = {
	openai: {key: "k-openai", endpoint: "https://api.openai.com/v1/responses", model: "gpt-x"},
	gemini: {key: "k-gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-x"},
	deepseek: {key: "k-deepseek", endpoint: "https://api.deepseek.com/chat/completions", model: "ds-x"},
	oaicompat: {key: "k-compat", endpoint: "https://compat.example/v1/chat/completions", model: "compat-x"}
};

function translationData(overrides = {}) {
	return Object.assign({
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"},
		text: "hello there",
		specialCase: null,
		autoDecision: false,
		engine: {}
	}, overrides);
}

function preparedItems(channelId = "channel-1") {
	return [
		{message: {id: "100"}, channelId, protectedText: "hello\nthere", input: {id: "en", name: "English"}, output: {id: "zh-CN", name: "Chinese"}},
		{message: {id: "200"}, channelId, protectedText: "second", input: {id: "en", name: "English"}, output: {id: "zh-CN", name: "Chinese"}}
	];
}

test("MD5 matches the published vectors Baidu signs against", () => {
	assert.equal(MD5(""), "d41d8cd98f00b204e9800998ecf8427e");
	assert.equal(MD5("abc"), "900150983cd24fb0d6963f7d28e17f72");
	assert.equal(MD5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
	// Non-ASCII goes through the UTF-8 pre-encoder, which Baidu requires.
	assert.equal(MD5("你好"), "7eca689f0d3389d9dea66ae112e5cfd7");
});

test("the engine catalog and settings portals stay aligned", () => {
	assert.equal(Object.isFrozen(translationEngines), false);
	assert.equal(translationEngines.openai.endpoint, "https://api.openai.com/v1/responses");
	assert.equal(translationEngines.gemini.endpoint, "https://generativelanguage.googleapis.com/v1beta/models");
	assert.equal(translationEngines.deepseek.endpoint, "https://api.deepseek.com/chat/completions");
	assert.equal(translationEngines.itranslate, undefined);
	assert.equal(translationEngines.yandex, undefined);
	assert.equal(Object.keys(enginePortals).every(key => !!translationEngines[key]), true, "every portal names a real engine");
});

test("engine form placeholders never resemble live provider credentials", () => {
	const secretShapes = [/^sk-[A-Za-z0-9_-]{20,}$/, /^AIza[0-9A-Za-z_-]{20,}$/];
	for (const [engineKey, engine] of Object.entries(translationEngines)) {
		if (!engine.key) continue;
		assert.equal(secretShapes.some(pattern => pattern.test(engine.key)), false, `${engineKey} uses a descriptive placeholder, not a token-shaped fake secret`);
	}
	assert.equal(translationEngines.papago.key, "CLIENT_ID CLIENT_SECRET", "Papago explains its two-part credential instead of looking prefilled");
	assert.equal(translationEngines.baidu.key, "APP_ID SECRET_KEY", "Baidu explains its two-part credential instead of looking prefilled");
});

test("endpoints are coerced to the one path each adapter posts to", () => {
	assert.equal(normalizeApiEndpoint("openai", "https://api.openai.com"), "https://api.openai.com/v1/responses");
	assert.equal(normalizeApiEndpoint("openai", "https://api.openai.com/v1"), "https://api.openai.com/v1/responses");
	assert.equal(normalizeApiEndpoint("openai", "https://api.openai.com/v1/responses/"), "https://api.openai.com/v1/responses");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test"), "https://host.test/v1/chat/completions");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test/v1", {format: "openai_responses"}), "https://host.test/v1/responses");
	assert.equal(normalizeApiEndpoint("oaicompat", "http://localhost:11434", {format: "ollama_native"}), "http://localhost:11434/api/chat");
	assert.equal(normalizeApiEndpoint("oaicompat", "http://localhost:11434/api/tags", {format: "ollama_native"}), "http://localhost:11434/api/chat");
	assert.equal(getModelCatalogEndpoint("oaicompat", "http://localhost:11434", {format: "ollama_native"}), "http://localhost:11434/api/tags");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/custom/path", {format: "ollama_native"}), "https://relay.test/custom/path", "explicit Ollama does not rewrite a conflicting full path");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://generativelanguage.googleapis.com", {format: "gemini_native"}), "https://generativelanguage.googleapis.com/v1beta/models");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/v1beta/models/gemini-2.5-flash:generateContent", {format: "gemini_native"}), "https://relay.test/v1beta/models");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/v1beta/models/gemini-2.5-flash", {format: "gemini_native"}), "https://relay.test/v1beta/models");
	assert.equal(getModelCatalogEndpoint("oaicompat", "https://relay.test/v1beta/models", {format: "gemini_native"}), "https://relay.test/v1beta/models");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/v1/chat/completions", {format: "gemini_native"}), "https://relay.test/v1/chat/completions", "explicit Gemini does not rewrite a conflicting full path");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://api.anthropic.com", {format: "anthropic_messages"}), "https://api.anthropic.com/v1/messages");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/v1", {format: "anthropic_messages"}), "https://relay.test/v1/messages");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/v1/models", {format: "anthropic_messages"}), "https://relay.test/v1/messages");
	assert.equal(getModelCatalogEndpoint("oaicompat", "https://relay.test/v1/messages", {format: "anthropic_messages"}), "https://relay.test/v1/models");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://relay.test/v1/responses", {format: "anthropic_messages"}), "https://relay.test/v1/responses", "explicit Anthropic does not rewrite a conflicting full path");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test/v1/chat/completions", {format: "openai_responses"}), "https://host.test/v1/responses", "the plugin's own sibling suffix follows the chosen OpenAI wire format");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test/v1/responses", {format: "openai_chat"}), "https://host.test/v1/chat/completions", "switching back swaps the sibling the other way");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test/v1/responses"), "https://host.test/v1/responses", "without an explicit format the path is left alone");
	assert.equal(normalizeApiEndpoint("oaicompat", "http://public.example/v1", {format: "openai_responses"}), "", "custom Responses keeps the HTTPS/local endpoint gate");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test/v1"), "https://host.test/v1/chat/completions");
	assert.equal(normalizeApiEndpoint("oaicompat", "https://host.test/custom/path"), "https://host.test/custom/path");
	assert.equal(normalizeApiEndpoint("oaicompat", "http://public.example/v1"), "", "public HTTP endpoints do not receive credentials");
	assert.equal(normalizeApiEndpoint("oaicompat", "ftp://localhost/v1"), "", "only HTTP(S) endpoints are accepted");
	for (const endpoint of [
		"http://localhost:11434",
		"http://127.0.0.1:11434/v1",
		"http://10.0.0.4/v1",
		"http://172.16.2.4/v1",
		"http://172.31.2.4/v1",
		"http://192.168.2.4/v1",
		"http://169.254.2.4/v1",
		"http://model-box.local/v1",
		"http://[::1]:11434/v1",
		"http://[fe80::1]:11434/v1"
	]) assert.match(normalizeApiEndpoint("oaicompat", endpoint), /\/chat\/completions$/, endpoint);
	for (const endpoint of [
		"http://example.test/v1",
		"http://11.0.0.4/v1",
		"http://172.15.2.4/v1",
		"http://172.32.2.4/v1",
		"http://192.169.2.4/v1",
		"http://[2001:db8::1]/v1"
	]) assert.equal(normalizeApiEndpoint("oaicompat", endpoint), "", endpoint);
	assert.equal(normalizeApiEndpoint("deepseek", "https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
	assert.equal(normalizeApiEndpoint("deepseek", "https://api.deepseek.com/v1"), "https://api.deepseek.com/chat/completions");
	assert.equal(normalizeApiEndpoint("deepseek", "https://api.deepseek.com/v1/chat/completions"), "https://api.deepseek.com/chat/completions");
	assert.equal(normalizeApiEndpoint("gemini", "https://g.test/v1beta/models/gemini-2.5-flash:generateContent"), "https://g.test/v1beta/models");
	assert.equal(normalizeApiEndpoint("gemini", "https://g.test/v1beta/models/gemini-2.5-flash"), "https://g.test/v1beta/models");
	assert.equal(normalizeApiEndpoint("microsoft", "https://ms.test?api-version=3.0"), "https://ms.test/translate");
	assert.equal(normalizeApiEndpoint("microsoft", "https://ms.test/translate"), "https://ms.test/translate");
	assert.equal(normalizeApiEndpoint("openai", "  https://api.openai.com/v1 /responses "), "", "internal whitespace makes an endpoint invalid instead of changing its identity");
	// An unknown engine with no default endpoint yields nothing rather than a bad URL.
	assert.equal(normalizeApiEndpoint("googleapi", ""), "");
	assert.equal(normalizeApiEndpoint("openai", ""), "https://api.openai.com/v1/responses", "the catalog default fills in");
});

test("model catalog endpoints follow each provider's listing route", () => {
	assert.equal(getModelCatalogEndpoint("openai", "https://api.openai.com/v1/responses"), "https://api.openai.com/v1/models");
	assert.equal(getModelCatalogEndpoint("deepseek", "https://api.deepseek.com/chat/completions"), "https://api.deepseek.com/models");
	assert.equal(getModelCatalogEndpoint("oaicompat", "https://host.test/v1"), "https://host.test/v1/models");
	// Gemini lists models at the same /models root it generates from.
	assert.equal(getModelCatalogEndpoint("gemini", "https://g.test/v1beta/models"), "https://g.test/v1beta/models");
	assert.equal(getModelCatalogEndpoint("googleapi", ""), "");
});

test("custom protocol catalog derivation never moves credentials across origins", () => {
	assert.equal(isSameEndpointOrigin("https://relay.test/v1/responses", "https://relay.test/v1/models"), true);
	assert.equal(isSameEndpointOrigin("https://relay.test/v1", "https://evil.test/v1/models"), false);
	assert.equal(isSameEndpointOrigin("not a url", "https://relay.test/v1/models"), false);
});

test("stored model catalogs are bounded, normalized and restored on client start", () => {
	const normalized = normalizeStoredModelCatalogs({
		openai: {items: [" gpt-4.1 ", "gpt-4.1", "", 7], endpoint: " https://user:pass@api.example/models?token=secret#fragment ", fetchedAt: "42"},
		microsoft: {items: ["ignored"]},
		gemini: {items: ["x".repeat(241)]}
	});
	assert.deepEqual(normalized, {
		openai: {loading: false, items: ["gpt-4.1"], endpoint: "https://api.example/models", fetchedAt: 42}
	});
	const harness = createHarness({modelCatalogs: normalized});
	assert.deepEqual(harness.client.getModelCatalogState(), normalized);
});

test("language codes are mapped per provider dialect table", () => {
	assert.equal(mapLanguageCodeForEngine("deepl", "zh-CN"), "ZH");
	assert.equal(mapLanguageCodeForEngine("deepl", "zh"), "ZH");
	assert.equal(mapLanguageCodeForEngine("deepl", "zh-TW"), "ZH-HANT");
	assert.equal(mapLanguageCodeForEngine("deepl", "de"), "DE");
	assert.equal(mapLanguageCodeForEngine("microsoft", "zh-CN"), "zh-Hans");
	assert.equal(mapLanguageCodeForEngine("microsoft", "en"), "en");
	assert.equal(mapLanguageCodeForEngine("baidu", "ja"), "jp");
	assert.equal(mapLanguageCodeForEngine("baidu", "zh"), "zh", "generic Chinese must not become Classical Chinese");
	assert.equal(mapLanguageCodeForEngine("openai", "en"), "en");
	assert.equal(mapLanguageCodeForEngine("deepl", ""), "");
});

test("validation error details are pulled from whichever field a provider used", () => {
	assert.equal(getValidationErrorDetails(JSON.stringify({error: {message: "bad key"}})), "bad key");
	assert.equal(getValidationErrorDetails(JSON.stringify({error: {code: "401"}})), "401");
	assert.equal(getValidationErrorDetails(JSON.stringify({message: "nope"})), "nope");
	assert.equal(getValidationErrorDetails(JSON.stringify({error_msg: "baidu says no"})), "baidu says no");
	assert.equal(getValidationErrorDetails("<html>gateway error</html>"), "<html>gateway error</html>");
	assert.equal(getValidationErrorDetails(""), "");
	assert.equal(getValidationErrorDetails("x".repeat(200)).length, 160, "a non-JSON body is truncated");
});

test("the AI translation prompt keeps its exact wire text", () => {
	const built = buildAiProviderTranslationPrompt(translationData({text: "line one\nline two"}));
	assert.equal(built.system, "You are a senior bilingual localization specialist");
	// The leading tabs are part of the prompt bytes providers receive.
	assert.ok(built.prompt.startsWith("\n\t\t\t\tYou are a professional localization expert."), "the prompt keeps its leading indentation");
	assert.match(built.prompt, /The target language is exactly Chinese\./);
	assert.match(built.prompt, /Manual translation mode: translate the entire natural-language message into Chinese\./);
	assert.doesNotMatch(built.prompt, /Auto-translate decision rules/);
	assert.match(built.prompt, /line one \[NEWLINE\] line two/, "newlines become [NEWLINE] markers");
	assert.match(built.prompt, /10\. Preserve placeholders like ⟦0⟧, ⟦1⟧ exactly/);
});

test("AI decision mode swaps the prompt mode and carries the user's skip rules", () => {
	const built = buildAiProviderTranslationPrompt(translationData({autoDecision: true, decisionPrompt: "MY-OWN-RULE"}));
	assert.equal(built.system, "You are a senior bilingual localization specialist and Discord chat translation decision assistant");
	assert.match(built.prompt, /Auto-translate mode: translate only natural-language content/);
	assert.doesNotMatch(built.prompt, /Manual translation mode/);
	assert.match(built.prompt, /MY-OWN-RULE/, "the user's own rules must reach the provider");
	assert.match(built.prompt, new RegExp(`return exactly ${AI_SKIP_TRANSLATION_TOKEN}`));
	assert.equal(AI_SKIP_TRANSLATION_TOKEN, "__SKIP_TRANSLATION__");

	// An empty custom prompt still leaves the skip instruction intact.
	const blank = buildAiProviderTranslationPrompt(translationData({autoDecision: true}));
	assert.match(blank.prompt, /Auto-translate decision rules:/);
});

test("OpenAI text is read from whichever response shape arrived", () => {
	assert.equal(parseOpenAiResponseText(JSON.stringify({output_text: " hi "})), "hi");
	assert.equal(parseOpenAiResponseText(JSON.stringify({output: [{content: [{text: "he"}, {text: "llo"}]}]})), "hello");
	assert.equal(parseOpenAiResponseText(JSON.stringify({choices: [{message: {content: " chat "}}]})), "chat");
	// output_text wins over the others, matching the Responses API contract.
	assert.equal(parseOpenAiResponseText(JSON.stringify({output_text: "first", choices: [{message: {content: "second"}}]})), "first");
	assert.equal(parseOpenAiResponseText("not json"), "");
	assert.equal(parseOpenAiResponseText(""), "");
	assert.equal(parseOpenAiResponseText({output_text: "object body"}), "object body", "an already-parsed body is accepted");
});

test("Gemini text is joined across candidate parts", () => {
	assert.equal(parseGeminiResponseText(JSON.stringify({candidates: [{content: {parts: [{text: "你"}, {text: "好"}]}}]})), "你好");
	assert.equal(parseGeminiResponseText(JSON.stringify({candidates: [{content: {parts: [{inlineData: {}}, {text: " hi "}]}}]})), "hi");
	assert.equal(parseGeminiResponseText(JSON.stringify({candidates: []})), "");
	assert.equal(parseGeminiResponseText("not json"), "");
});

test("batch responses survive fences and prose, and refuse ambiguous ids", () => {
	assert.deepEqual(parseAiBatchTranslationResponse('```json\n[{"id":"1","translation":"一"}]\n```', ["1"]), {"1": "一"});
	assert.deepEqual(parseAiBatchTranslationResponse('Sure! [{"id":"1","translation":"一"}] hope that helps', ["1"]), {"1": "一"});
	assert.deepEqual(parseAiBatchTranslationResponse('{"translations":[{"id":"1","translation":"一"}]}', ["1"]), {"1": "一"});
	// `text` is accepted as an alias for `translation`.
	assert.deepEqual(parseAiBatchTranslationResponse('[{"id":"1","text":"一"}]', ["1"]), {"1": "一"});
	// An id nobody asked for must not be pasted onto a message.
	assert.deepEqual(parseAiBatchTranslationResponse('[{"id":"1","translation":"一"},{"id":"9","translation":"九"}]', ["1"]), {"1": "一"});
	// Two answers for one id: neither is trustworthy, so the id is dropped entirely.
	assert.deepEqual(parseAiBatchTranslationResponse('[{"id":"1","translation":"一"},{"id":"1","translation":"壹"}]', ["1"]), {});
	assert.deepEqual(parseAiBatchTranslationResponse('[{"id":1,"translation":null}]', ["1"]), {"1": ""});
	assert.deepEqual(parseAiBatchTranslationResponse('[{"translation":"orphan"}]', ["1"]), {});
	assert.equal(parseAiBatchTranslationResponse("not json at all"), null);
	assert.equal(parseAiBatchTranslationResponse(""), null);
	assert.equal(parseAiBatchTranslationResponse('{"ok":true}'), null, "a non-array answer is a failure, not an empty batch");
	// Without an expected id list every returned id is accepted.
	assert.deepEqual(parseAiBatchTranslationResponse('[{"id":"7","translation":"七"}]'), {"7": "七"});
});

test("a request that never answers is closed out as a synthetic 504 after 30s", () => {
	const harness = createHarness();
	const seen = [];
	harness.client.requestWithTimeout("https://slow.test", {method: "post"}, (error, response, body) => seen.push({error, response, body}));

	assert.equal(harness.timers[0].delay, PROVIDER_REQUEST_TIMEOUT_MS, "the default window is 30s");
	assert.equal(seen.length, 0);
	harness.fireTimer(0);

	assert.deepEqual(seen, [{error: null, response: {statusCode: 504}, body: ""}]);
	// A 504 is a 5xx, so the timeout itself opens a backoff window.
	assert.equal(harness.client.getBackoffUntil(), 1000 + 2000);
});

test("a late provider answer after a timeout cannot call back twice", () => {
	const harness = createHarness();
	const seen = [];
	harness.client.requestWithTimeout("https://slow.test", {}, (_error, response) => seen.push(response.statusCode));
	harness.fireTimer(0);
	harness.respond(0, null, {statusCode: 200}, "late");

	assert.deepEqual(seen, [504], "the late answer is dropped");
});

test("a prompt answer clears the timeout so it can never fire", () => {
	const harness = createHarness();
	const seen = [];
	harness.client.requestWithTimeout("https://fast.test", {}, (_error, response) => seen.push(response.statusCode));
	harness.respond(0, null, {statusCode: 200}, "ok");

	assert.deepEqual(seen, [200]);
	assert.equal(harness.timers[0].cleared, true);
	assert.equal(harness.client.getBackoffUntil(), 0, "a good response opens no window");
});

test("request timing context records transport duration without entering HTTP options", () => {
	const harness = createHarness();
	const options = {method: "post", body: "fixture"};
	const token = Object.freeze({requestId: 1, generation: 0, kind: "manual", queueWaitMs: null, messageCount: 1});
	let requestIdentity = null;
	harness.client.requestWithTimeout("https://timed.test", options, () => {}, PROVIDER_REQUEST_TIMEOUT_MS, {token, role: "primary", engineKey: "openai", messageCount: 1, diagnosticRequestObserver: event => {requestIdentity = event;}});
	assert.deepEqual(harness.lastCall().options, options);
	assert.equal(requestIdentity.bodyBytes, 7); assert.match(requestIdentity.bodyIdentity, /^bi1:[a-z0-9]{20}$/); assert.equal(requestIdentity.role, "primary"); assert.doesNotMatch(JSON.stringify(requestIdentity), /fixture|timed\.test/);
	harness.advance(125);
	harness.respond(0, null, {statusCode: 200}, "ok");
	assert.deepEqual(harness.latencyEvents, [{
		token,
		role: "primary",
		engineKey: "openai",
		messageCount: 1,
		transportMs: 125,
		status: "ok",
		httpStatus: 200,
		errorClass: null,
		outputChars: null,
		finishedAt: 1125
	}]);
});

test("a timed transport is classified as timeout exactly once", () => {
	const harness = createHarness();
	const token = Object.freeze({requestId: 2, generation: 0, kind: "detect", queueWaitMs: null, messageCount: 1});
	harness.client.requestWithTimeout("https://timed.test", {}, () => {}, PROVIDER_REQUEST_TIMEOUT_MS, {token, role: "primary", engineKey: "openai"});
	harness.advance(PROVIDER_REQUEST_TIMEOUT_MS);
	harness.fireTimer(0);
	assert.equal(harness.latencyEvents.length, 1);
	assert.equal(harness.latencyEvents[0].status, "timeout");
	assert.equal(harness.latencyEvents[0].errorClass, "timeout");
	assert.equal(harness.latencyEvents[0].transportMs, PROVIDER_REQUEST_TIMEOUT_MS);
	harness.respond(0, null, {statusCode: 200}, "late");
	assert.equal(harness.latencyEvents.length, 1);
});

test("a real upstream 504 stays a server HTTP attempt while validation keeps its historical timeout label", async () => {
	const transport = createHarness();
	const token = Object.freeze({requestId: 3, generation: 0, kind: "manual", queueWaitMs: null, messageCount: 1});
	transport.client.requestWithTimeout("https://timed.test", {}, () => {}, PROVIDER_REQUEST_TIMEOUT_MS, {token, role: "primary", engineKey: "openai"});
	transport.respond(0, null, {statusCode: 504}, "gateway timeout");
	assert.equal(transport.latencyEvents[0].status, "http_504");
	assert.equal(transport.latencyEvents[0].errorClass, "server");

	const validation = createHarness({authKeys: {openai: {key: "k-long-enough", endpoint: "https://proxy.test/v1/responses", model: "m"}}});
	const pending = validation.client.validateEngineConfig("openai");
	validation.respond(0, null, {statusCode: 504}, "gateway timeout");
	assert.equal((await pending).errorClass, "timeout", "validation cannot distinguish its synthetic 504 from an upstream gateway timeout");
});

test("HTTP status outranks a simultaneous transport error and classifies invalid requests without retaining secrets", async () => {
	assert.equal(classifyProviderRequestError(new Error("callback error"), {statusCode: 400}, JSON.stringify({error: {message: "Invalid value minimal for reasoning_effort; must be one of low, medium"}})), "unsupported_value");
	assert.equal(classifyProviderRequestError(null, {statusCode: 422}, JSON.stringify({error: {message: "temperature is not supported by this model"}})), "sampling_conflict");
	assert.equal(classifyProviderRequestError(null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter reasoning_effort"}})), "unsupported_field");
	assert.equal(classifyProviderRequestError(null, {statusCode: 400}, JSON.stringify({error: {message: "Invalid request body schema for messages"}})), "schema");
	assert.equal(classifyProviderRequestError(null, {statusCode: 400}, "bad request"), "invalid_request");
	assert.equal(classifyProviderRequestError(new Error("callback error"), {statusCode: 429}, "limited"), "rate_limit");
	assert.equal(classifyProviderRequestError(new Error("callback error"), {statusCode: 503}, "down"), "server");
	assert.equal(classifyProviderRequestError(new Error("broken 200"), {statusCode: 200}, "partial"), "network");
	assert.equal(classifyProviderRequestError(null, {statusCode: 504}, ""), "server");
	assert.equal(classifyProviderRequestError(null, {statusCode: 504}, "", {treatHttp504AsTimeout: true}), "timeout");
	assert.equal(classifyProviderRequestError(null, {statusCode: 503}, "", {timedOut: true}), "timeout");
	assert.equal(classifyProviderRequestError(new Error("offline"), null, ""), "network");
	assert.equal(getSafeProviderErrorParameter(JSON.stringify({error: {message: "Invalid value minimal for reasoning_effort"}})), "reasoning_effort");
	assert.equal(getSafeProviderErrorParameter("unknown arbitrary_sensitive_field"), "");

	const secret = "provider-secret-123";
	const endpoint = "https://proxy.test/v1/responses";
	const model = "private-model-id";
	const promptEcho = "private prompt and message body";
	const headerEcho = "custom-header-secret";
	const harness = createHarness({authKeys: {openai: {key: secret, endpoint, model}}});
	const pending = harness.client.validateEngineConfig("openai");
	harness.respond(0, new Error("HTTP client surfaced status as error"), {statusCode: 400}, JSON.stringify({error: {message: `Invalid value minimal for reasoning_effort; ${secret}; ${endpoint}; ${model}; Authorization Bearer ${secret}; ${headerEcho}; ${promptEcho}`}}));
	const result = await pending;
	assert.equal(result.httpStatus, 400);
	assert.equal(result.errorClass, "unsupported_value");
	assert.equal(result.errorParameter, "reasoning_effort");
	assert.equal(harness.latencyEvents[0].status, "http_400");
	assert.equal(harness.latencyEvents[0].errorClass, "unsupported_value");
	const visibleAndStored = JSON.stringify({result, toast: harness.toasts.at(-1), latency: harness.latencyEvents[0]});
	for (const sensitive of [secret, endpoint, model, headerEcho, promptEcho]) assert.doesNotMatch(visibleAndStored, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(JSON.stringify(harness.latencyEvents[0]), /reasoning_effort|Invalid value/);

	for (const [statusCode, expectedClass] of [[429, "rate_limit"], [503, "server"]]) {
		const pressure = createHarness({authKeys: {openai: {key: "k-long-enough", endpoint: "https://proxy.test/v1/responses", model: "m"}}});
		const pressurePending = pressure.client.validateEngineConfig("openai");
		pressure.respond(0, new Error("HTTP callback error"), {statusCode}, "pressure");
		assert.equal((await pressurePending).errorClass, expectedClass);
		assert.equal(pressure.latencyEvents[0].status, `http_${statusCode}`);
		assert.equal(pressure.latencyEvents[0].errorClass, expectedClass);
		assert.equal(pressure.backoffNotices.length, 1, `HTTP ${statusCode} still opens backoff when error coexists`);
	}
});

test("an HTTP function that throws is reported through the callback, not up the stack", () => {
	const harness = createHarness();
	const client = createProviderClient({
		request: () => {throw new Error("socket exploded");},
		setTimeout: (callback, delay) => ({callback, delay}),
		clearTimeout: () => {},
		now: () => 1000
	});
	const seen = [];
	client.requestWithTimeout("https://broken.test", {}, (error, response, body) => seen.push({message: error && error.message, response, body}));

	assert.deepEqual(seen, [{message: "socket exploded", response: null, body: ""}]);
	assert.equal(harness.calls.length, 0);
});

test("429 and 5xx open backoff windows, other statuses do not", () => {
	const rateLimited = createHarness();
	rateLimited.client.requestWithTimeout("https://x.test", {}, () => {});
	rateLimited.respond(0, null, {statusCode: 429}, "slow down");
	assert.equal(rateLimited.client.getBackoffUntil(), 1000 + 5000);

	const serverError = createHarness();
	serverError.client.requestWithTimeout("https://x.test", {}, () => {});
	serverError.respond(0, null, {statusCode: 503}, "down");
	assert.equal(serverError.client.getBackoffUntil(), 1000 + 2000);

	const clientError = createHarness();
	clientError.client.requestWithTimeout("https://x.test", {}, () => {});
	clientError.respond(0, null, {statusCode: 404}, "missing");
	assert.equal(clientError.client.getBackoffUntil(), 0);

	const networkError = createHarness();
	networkError.client.requestWithTimeout("https://x.test", {}, () => {});
	networkError.respond(0, new Error("offline"), null, "");
	assert.equal(networkError.client.getBackoffUntil(), 0, "a transport error is not provider pressure");
});

test("consecutive pressure doubles the pause and stops at the 60s ceiling", () => {
	const harness = createHarness();
	const {client} = harness;

	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 0);
	assert.equal(client.getBackoffUntil(), 1000 + 5000);

	// Still inside the open window, so the step escalates.
	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 1);
	assert.equal(client.getBackoffUntil(), 1000 + 10000);

	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 2);
	assert.equal(client.getBackoffUntil(), 1000 + 20000);

	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 3);
	assert.equal(client.getBackoffUntil(), 1000 + 40000);

	// 5s doubled four times is 80s, which the ceiling clamps to 60s.
	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 4);
	assert.equal(client.getBackoffUntil(), 1000 + 60000);

	// The step saturates: further pressure cannot push the window past the ceiling.
	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 4);
	assert.equal(client.getBackoffUntil(), 1000 + 60000);
	assert.equal(harness.backoffNotices.length, 6, "every window re-arms the queue retry");
});

test("the 5xx base escalates on its own ladder", () => {
	const harness = createHarness();
	const {client} = harness;
	client.scheduleBackoff(2000);
	assert.equal(client.getBackoffUntil(), 1000 + 2000);
	client.scheduleBackoff(2000);
	assert.equal(client.getBackoffUntil(), 1000 + 4000);
	client.scheduleBackoff(2000);
	assert.equal(client.getBackoffUntil(), 1000 + 8000);
});

test("a window that fully expired resets the escalation", () => {
	const harness = createHarness();
	const {client} = harness;
	client.scheduleBackoff(5000);
	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 1);

	harness.advance(20000);
	assert.equal(client.isBackoffActive(), false);
	client.scheduleBackoff(5000);
	assert.equal(client.getBackoffStep(), 0, "pressure after a quiet period starts over");
	assert.equal(client.getBackoffUntil(), 21000 + 5000);
});

test("a shorter new window never shortens an open one", () => {
	const harness = createHarness();
	const {client} = harness;
	client.scheduleBackoff(60000);
	const until = client.getBackoffUntil();
	harness.advance(10);
	client.scheduleBackoff(1);
	assert.equal(client.getBackoffUntil(), until, "the later deadline wins");
});

test("a zero pause is not a backoff signal at all", () => {
	const harness = createHarness();
	harness.client.scheduleBackoff(0);
	assert.equal(harness.client.getBackoffUntil(), 0);
	assert.equal(harness.backoffNotices.length, 0);
});

test("awaiting the backoff sleeps exactly the remaining time", async () => {
	const harness = createHarness();
	const {client} = harness;

	await client.awaitBackoff();
	assert.deepEqual(harness.sleeps, [], "no window means no wait");

	client.scheduleBackoff(5000);
	harness.advance(1500);
	await client.awaitBackoff();
	assert.deepEqual(harness.sleeps, [3500]);

	harness.advance(10000);
	await client.awaitBackoff();
	assert.deepEqual(harness.sleeps, [3500], "an expired window is not waited on");
});

test("resetting the backoff reopens the queue immediately", () => {
	const harness = createHarness();
	harness.client.scheduleBackoff(5000);
	assert.equal(harness.client.isBackoffActive(), true);
	harness.client.resetBackoff();
	assert.equal(harness.client.isBackoffActive(), false);
	assert.equal(harness.client.getBackoffStep(), 0);
});

test("only engines with real credentials are runtime-configured", () => {
	// Engines with no credential concept are always available.
	assert.equal(createHarness().client.isEngineConfiguredForRuntime("googleapi"), true);
	assert.equal(createHarness().client.isEngineConfiguredForRuntime("nonsense"), false);

	assert.equal(createHarness().client.isEngineConfiguredForRuntime("openai"), false, "no key means not configured");
	assert.equal(createHarness({authKeys: {openai: {key: "  "}}}).client.isEngineConfiguredForRuntime("openai"), false, "whitespace is not a key");
	assert.equal(createHarness({authKeys: {openai: {key: "k"}}}).client.isEngineConfiguredForRuntime("openai"), true);

	// Papago and Baidu keep two credentials in the legacy combined key field.
	// Neither engine is ready until every required part is present.
	assert.equal(createHarness().client.isEngineConfiguredForRuntime("papago"), false);
	assert.equal(createHarness({authKeys: {papago: {key: "client-id"}}}).client.isEngineConfiguredForRuntime("papago"), false);
	assert.equal(createHarness({authKeys: {papago: {key: "client-id client-secret"}}}).client.isEngineConfiguredForRuntime("papago"), true);
	assert.equal(createHarness({authKeys: {papago: {key: "client-id client-secret extra"}}}).client.isEngineConfiguredForRuntime("papago"), false);
	assert.equal(createHarness().client.isEngineConfiguredForRuntime("baidu"), false);
	assert.equal(createHarness({authKeys: {baidu: {key: "app-id"}}}).client.isEngineConfiguredForRuntime("baidu"), false);
	assert.equal(createHarness({authKeys: {baidu: {key: "app-id secret-key"}}}).client.isEngineConfiguredForRuntime("baidu"), true);
	assert.equal(createHarness({authKeys: {baidu: {key: "app-id legacy-middle secret-key"}}}).client.isEngineConfiguredForRuntime("baidu"), true, "the supported legacy three-part Baidu shape stays valid");

	// oaicompat ships placeholder endpoint/model values, so a key alone proves nothing.
	assert.equal(createHarness({authKeys: {oaicompat: {key: "k"}}}).client.isEngineConfiguredForRuntime("oaicompat"), false);
	assert.equal(createHarness({authKeys: {oaicompat: {
		key: "k",
		endpoint: translationEngines.oaicompat.endpoint,
		model: "real-model"
	}}}).client.isEngineConfiguredForRuntime("oaicompat"), false, "the placeholder endpoint does not count");
	assert.equal(createHarness({authKeys: {oaicompat: {
		key: "k",
		endpoint: "https://host.test/v1/chat/completions",
		model: translationEngines.oaicompat.model
	}}}).client.isEngineConfiguredForRuntime("oaicompat"), false, "the placeholder model does not count");
	assert.equal(createHarness({authKeys: {oaicompat: {
		key: "k",
		endpoint: "https://host.test/v1/chat/completions",
		model: "real-model"
	}}}).client.isEngineConfiguredForRuntime("oaicompat"), true);
});

test("Google's keyless endpoint leaves q raw for the request library's single form encoding and adopts the detected source", () => {
	const harness = createHarness({languages: {fr: {name: "French", ownlang: "Francais"}}});
	const data = translationData({input: {id: "auto", name: "Auto", auto: true}});
	let translated = null;
	harness.client.googleApiTranslate(data, value => {translated = value;});

	assert.equal(harness.lastCall().url, "https://translate.googleapis.com/translate_a/single");
	assert.deepEqual(harness.lastCall().options.form, {
		client: "gtx",
		dt: "t",
		dj: "1",
		source: "input",
		sl: "auto",
		tl: "zh-CN",
		q: "hello there"
	});

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({src: "fr", sentences: [{trans: "你"}, {}, {trans: "好"}]}));
	assert.equal(translated, "你好");
	assert.deepEqual(data.input, {id: "fr", name: "French", ownlang: "Francais", auto: true}, "the detected source is written back for the caller to render");
});

test("Google's keyless endpoint transports protected placeholders in a form it preserves", () => {
	// Field reproduction 2026-08-20: Google returned 200 for the long message but
	// silently dropped ⟦4⟧ (ANNOYING), so the strict protection guard rejected the
	// otherwise valid translation. The adapter owns the reversible wire-only token.
	const harness = createHarness();
	let translated = null;
	harness.client.googleApiTranslate(translationData({text: "Prompt editing is ⟦4⟧ with ⟦5⟧ parameters."}), value => {translated = value;});

	const wireText = harness.lastCall().options.form.q;
	assert.equal(wireText, "Prompt editing is __DTA_4__ with __DTA_5__ parameters.");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({src: "en", sentences: [{trans: "提示编辑是 __DTA_4__，使用 __DTA_5__ 参数。"}]}));
	assert.equal(translated, "提示编辑是 ⟦4⟧，使用 ⟦5⟧ 参数。", "the internal placeholder shape is restored before the protection guard sees the result");
});

test("Google's keyless endpoint translates a long CJK message in bounded lossless requests", () => {
	// The request transports q in the URL. A raw-character limit is insufficient:
	// one CJK character expands to nine URI characters before the request helper
	// serializes the form, which is why some Discord-length messages still failed
	// after the first long-message patch.
	const harness = createHarness({languages: {ja: {name: "Japanese", ownlang: "日本語"}}});
	const source = Array.from({length: 24}, (_, index) => `第${index}段です。これは長い転送テスト本文です。`).join("\n\n");
	const data = translationData({text: source, input: {id: "auto", name: "Auto", auto: true}});
	let translated = null;
	harness.client.googleApiTranslate(data, value => {translated = value;});

	const sentChunks = [];
	let requestIndex = 0;
	while (translated === null) {
		const call = harness.calls[requestIndex];
		assert.ok(call, `chunk ${requestIndex} must be requested`);
		assert.ok(call.options.form.q.length <= FREE_ENGINE_CHUNK_LIMIT, "the encoded q value, not the raw source length, is bounded");
		sentChunks.push(call.options.form.q);
		harness.respond(requestIndex, null, {statusCode: 200}, JSON.stringify({
			src: "ja",
			sentences: [{trans: `译文${requestIndex}|`}]
		}));
		requestIndex++;
		assert.ok(requestIndex < 100, "chunking must terminate");
	}

	assert.ok(requestIndex > 1, "the long message uses more than one bounded request");
	assert.equal(sentChunks.join(""), source, "chunk boundaries do not drop or duplicate source text");
	assert.equal(translated, Array.from({length: requestIndex}, (_, index) => `译文${index}|`).join(""));
	assert.deepEqual(data.input, {id: "ja", name: "Japanese", ownlang: "日本語", auto: true}, "only the first chunk supplies source detection");
});

test("background Google history requests suppress transport toasts while interactive requests keep them", () => {
	const background = createHarness();
	background.client.googleApiTranslate(Object.assign(translationData(), {silent: true}), () => {});
	background.respond(0, null, {statusCode: 500}, "");
	assert.equal(background.toasts.length, 0);
	const interactive = createHarness();
	interactive.client.googleApiTranslate(translationData(), () => {});
	interactive.respond(0, null, {statusCode: 500}, "");
	assert.equal(interactive.toasts.length, 1);
});

test("a rate-limited Google reply is distinguished from a dead one in the toast", () => {
	const rateLimited = createHarness();
	rateLimited.client.googleApiTranslate(translationData(), () => {});
	rateLimited.respond(0, null, {statusCode: 429}, "");
	assert.match(rateLimited.toasts[0].message, /HOURLY$/);

	const down = createHarness();
	down.client.googleApiTranslate(translationData(), () => {});
	down.respond(0, null, {statusCode: 500}, "");
	assert.match(down.toasts[0].message, /SERVERDOWN$/);
	assert.equal(down.client.getBackoffUntil(), 1000 + 2000, "classic adapters share the provider backoff boundary");
});

test("a hung classic adapter times out once and drops a late transport answer", () => {
	const harness = createHarness();
	const seen = [];
	harness.client.googleApiTranslate(translationData(), value => seen.push(value));

	assert.equal(harness.timers[0].delay, PROVIDER_REQUEST_TIMEOUT_MS);
	harness.fireTimer(0);
	assert.deepEqual(seen, [""]);
	assert.equal(harness.client.getBackoffUntil(), 1000 + 2000);

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({src: "en", sentences: [{trans: "late"}]}));
	assert.deepEqual(seen, [""], "the adapter callback stays terminal after timeout");
});

test("a timed-out Google chunk cannot resume the multi-chunk chain when its response arrives late", () => {
	const harness = createHarness();
	const seen = [];
	const longText = "翻译这个长句。".repeat(300);
	harness.client.googleApiTranslate(translationData({text: longText}), value => seen.push(value));

	assert.equal(harness.calls.length, 1);
	harness.fireTimer(0);
	assert.deepEqual(seen, [""]);
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({src: "en", sentences: [{trans: "late chunk"}]}));
	assert.equal(harness.calls.length, 1, "a late chunk does not schedule the next request");
	assert.deepEqual(seen, [""]);
});

test("Azure sends its key, region and per-dialect codes", () => {
	const harness = createHarness({authKeys: {microsoft: {key: "k-ms", region: "eastasia"}}});
	harness.client.microsoftTranslate(translationData({output: {id: "zh-TW", name: "Trad"}}), () => {});
	const call = harness.lastCall();

	assert.equal(call.url, "https://api.cognitive.microsofttranslator.com/translate");
	assert.equal(call.options.headers["Ocp-Apim-Subscription-Key"], "k-ms");
	assert.equal(call.options.headers["Ocp-Apim-Subscription-Region"], "eastasia");
	assert.deepEqual(call.options.form, {"api-version": "3.0", to: "zh-Hant", from: "en"});
	assert.deepEqual(JSON.parse(call.options.body), [{Text: "hello there"}]);

	// "global" is Azure's default scope and must not be sent as a region header.
	const global = createHarness({authKeys: {microsoft: {key: "k-ms", region: "global"}}});
	global.client.microsoftTranslate(translationData(), () => {});
	assert.equal("Ocp-Apim-Subscription-Region" in global.lastCall().options.headers, false);

	// An auto source drops the `from` key entirely so Azure detects it.
	const auto = createHarness({authKeys: {microsoft: {key: "k-ms"}}});
	auto.client.microsoftTranslate(translationData({input: {id: "auto", auto: true}}), () => {});
	assert.equal("from" in auto.lastCall().options.form, false);
});

test("DeepL picks the paid host only for paid keys and upper-cases its codes", () => {
	const free = createHarness({authKeys: {deepl: {key: "k-deepl"}}});
	free.client.deepLTranslate(translationData(), () => {});
	assert.equal(free.lastCall().url, "https://api-free.deepl.com/v2/translate");
	assert.equal(free.lastCall().options.headers.Authorization, "DeepL-Auth-Key k-deepl");
	assert.deepEqual(JSON.parse(free.lastCall().options.body), {text: ["hello there"], target_lang: "ZH", source_lang: "EN"});

	const paid = createHarness({authKeys: {deepl: {key: "k-deepl", paid: true}}});
	paid.client.deepLTranslate(translationData({input: {id: "auto", auto: true}}), () => {});
	assert.equal(paid.lastCall().url, "https://api.deepl.com/v2/translate");
	assert.equal("source_lang" in JSON.parse(paid.lastCall().options.body), false);
});

test("Google Cloud posts key, model and format as form fields", () => {
	const harness = createHarness({authKeys: {googlecloud: {key: "k-gc", model: "nmt"}}});
	harness.client.googleCloudTranslate(translationData(), () => {});
	assert.deepEqual(harness.lastCall().options.form, {
		key: "k-gc",
		q: "hello there",
		target: "zh-CN",
		format: "text",
		model: "nmt",
		source: "en"
	});
});

test("OpenAI translation uses the Responses API and never stores the prompt", () => {
	const harness = createHarness({authKeys: AI_AUTH});
	let translated = null;
	harness.client.openAiTranslate(translationData(), value => {translated = value;});
	const call = harness.lastCall();

	assert.equal(call.url, "https://api.openai.com/v1/responses");
	assert.equal(call.options.headers.Authorization, "Bearer k-openai");
	const body = JSON.parse(call.options.body);
	assert.equal(body.model, "gpt-x");
	assert.equal(body.store, false, "message text must not be retained by the provider");
	assert.equal(body.instructions, "You are a senior bilingual localization specialist");
	assert.match(body.input, /hello there/);

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "你好"}));
	assert.equal(translated, "你好");
	// AI adapters do go through the timeout wrapper.
	assert.equal(harness.timers[0].delay, PROVIDER_REQUEST_TIMEOUT_MS);
});

test("M2 registry work cannot change the official OpenAI Responses request bytes", () => {
	assert.deepEqual(getRegisteredCustomProtocolAdapterIds(), ["openai_chat", "openai_responses", "ollama_native", "gemini_native", "anthropic_messages"]);
	const harness = createHarness({authKeys: {openai: {key: "k-openai", endpoint: "https://api.openai.com/v1/responses", model: "gpt-x"}}});
	harness.client.translate("openai", translationData(), () => {});
	const call = harness.calls[0];
	const wire = `${call.url}\n${JSON.stringify(call.options.headers || {})}\n${String(call.options.body || "")}`;
	assert.equal(crypto.createHash("sha256").update(wire).digest("hex").toUpperCase(), "256DD7B39E5701C1D83ABA87A86BD8A9457B9DEE5C488B38A5A9188F442A6C0C");
});

test("M3a routes explicit and auto Responses formats across custom provider surfaces while legacy stays Chat", async () => {
	const responseAuth = {oaicompat: {key: "k", endpoint: "https://relay.test/v1", model: "m", interfaceFormat: "openai_responses"}};
	const single = createHarness({authKeys: responseAuth});
	assert.deepEqual(single.client.getCustomInterfaceStatus("oaicompat"), {available: true, requested: "openai_responses", resolved: "openai_responses", evidence: "manual", endpointKey: "https://relay.test/v1", adapterVersion: 1});
	let translated = null;
	single.client.translate("oaicompat", translationData(), value => {translated = value;});
	assert.equal(single.lastCall().url, "https://relay.test/v1/responses");
	assert.equal(typeof single.lastBody().instructions, "string");
	assert.match(single.lastBody().input, /hello there/);
	assert.equal(single.lastBody().messages, undefined);
	single.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "译文"}));
	assert.equal(translated, "译文");

	const validation = createHarness({authKeys: responseAuth});
	const validationPending = validation.client.validateEngineConfig("oaicompat");
	assert.equal(validation.lastCall().url, "https://relay.test/v1/responses");
	assert.equal(validation.lastBody().store, false);
	validation.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "Guten Morgen"}));
	assert.equal((await validationPending).ok, true);
	assert.equal(validation.authKeys.oaicompat.interfaceDetection.resolved, "openai_responses");
	assert.equal(validation.authKeys.oaicompat.interfaceDetection.evidence, "validation");

	const batch = createHarness({authKeys: responseAuth});
	const batchPending = batch.client.requestAiBatchTranslation("oaicompat", preparedItems());
	assert.equal(batch.lastCall().url, "https://relay.test/v1/responses");
	assert.equal(batch.lastBody().messages, undefined);
	batch.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: '[{"id":"100","translation":"一"},{"id":"200","translation":"二"}]'}));
	assert.deepEqual(await batchPending, {"100": "一", "200": "二"});

	const catalog = createHarness({authKeys: responseAuth});
	const catalogPending = catalog.client.fetchModelCatalog("oaicompat");
	assert.equal(catalog.lastCall().url, "https://relay.test/v1/models");
	catalog.respond(0, null, {statusCode: 200}, JSON.stringify({data: [{id: "b"}, {id: "a"}]}));
	assert.deepEqual((await catalogPending).items, ["a", "b"]);
	assert.equal(catalog.authKeys.oaicompat.interfaceDetection, undefined, "Chat and Responses share the same catalog shape, so catalog success is not format evidence");

	const automatic = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/responses", model: "m", interfaceFormat: "auto"}}});
	automatic.client.translate("oaicompat", translationData(), () => {});
	assert.equal(automatic.lastBody().input.includes("hello there"), true);
	assert.equal(automatic.lastBody().messages, undefined);

	const legacy = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/responses", model: "m"}}});
	legacy.client.translate("oaicompat", translationData(), () => {});
	assert.equal(typeof legacy.lastBody().input, "string", "path evidence revives the previously broken Chat-payload-to-Responses configuration");
	const ordinaryLegacy = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1", model: "m"}}});
	ordinaryLegacy.client.translate("oaicompat", translationData(), () => {});
	assert.ok(Array.isArray(ordinaryLegacy.lastBody().messages), "ordinary missing-interfaceFormat configurations keep Chat behavior");
});

test("M3a maps OpenAI reasoning into Responses and never strips an explicit control", async () => {
	const authKeys = {oaicompat: {key: "k", endpoint: "https://relay.test/v1/responses", model: "m", interfaceFormat: "openai_responses", reasoningMode: "off", reasoningProfile: "openai"}};
	const accepted = createHarness({authKeys});
	const validation = accepted.client.validateEngineConfig("oaicompat");
	assert.deepEqual(accepted.lastBody().reasoning, {effort: "none"});
	assert.equal(accepted.lastBody().reasoning_effort, undefined);
	accepted.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "Hallo", usage: {output_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await validation).ok, true);
	assert.equal(accepted.client.getReasoningControlStatus("oaicompat").evidence, "none", "a compatible relay's zero is telemetry, not proof of closing");
	assert.equal(accepted.authKeys.oaicompat.reasoningModels.m.capability.format, "openai_responses");
	accepted.client.translate("oaicompat", translationData(), () => {});
	assert.deepEqual(accepted.lastBody().reasoning, {effort: "none"});

	const official = createHarness({authKeys: {oaicompat: Object.assign({}, authKeys.oaicompat, {endpoint: "https://api.openai.com/v1/responses"})}});
	const officialValidation = official.client.validateEngineConfig("oaicompat");
	official.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "Hallo", usage: {output_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await officialValidation).ok, true);
	assert.equal(official.client.getReasoningControlStatus("oaicompat").evidence, "confirmed", "direct official usage may confirm an explicit off value");

	const fallback = createHarness({authKeys});
	const pending = fallback.client.validateEngineConfig("oaicompat");
	assert.deepEqual(fallback.lastBody().reasoning, {effort: "none"});
	fallback.respond(0, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: reasoning"}}));
	assert.equal(fallback.calls.length, 1, "a rejected off field is never stripped and resent as provider default");
	assert.equal((await pending).ok, false);
	assert.equal(fallback.client.getReasoningControlStatus("oaicompat").support, "unsupported");
});

test("M3a keeps protocol selection isolated across multiple custom provider instances", () => {
	syncCustomEngines({customProviders: [{id: "custom-a", name: "A"}, {id: "custom-b", name: "B"}]});
	try {
		const harness = createHarness({authKeys: {
			"custom-a": {key: "a", endpoint: "https://a.test/v1", model: "ma", interfaceFormat: "openai_responses"},
			"custom-b": {key: "b", endpoint: "https://b.test/v1", model: "mb", interfaceFormat: "openai_chat"}
		}});
		harness.client.translate("custom-a", translationData({engine: {id: "custom-a"}}), () => {});
		harness.client.translate("custom-b", translationData({engine: {id: "custom-b"}}), () => {});
		assert.equal(harness.calls[0].url, "https://a.test/v1/responses");
		assert.equal(harness.calls[0].options.body.includes('"instructions"'), true);
		assert.equal(harness.calls[1].url, "https://b.test/v1/chat/completions");
		assert.equal(harness.calls[1].options.body.includes('"messages"'), true);
	}
	finally {syncCustomEngines({customProviders: []});}
});

test("M3a isolates reasoning capability by format and rejects unsupported Responses families", async () => {
	const oldCapability = {support: "accepted", candidateId: "openai_none", resolvedValue: "none", evidence: "confirmed", endpointKey: "https://relay.test/v1/chat/completions", checkedAt: 1};
	const chat = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode: "off", profile: "openai", effort: "low", capability: oldCapability}}}}});
	assert.equal(chat.client.getReasoningControlStatus("oaicompat").support, "accepted", "format-less pre-M3 capability rehydrates only on Chat");

	const responses = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/responses", model: "m", interfaceFormat: "openai_responses", reasoningModels: {m: {mode: "off", profile: "openai", effort: "low", capability: Object.assign({}, oldCapability, {endpointKey: "https://relay.test/v1/responses"})}}}}});
	assert.equal(responses.client.getReasoningControlStatus("oaicompat").support, "pending", "format-less capability never crosses into Responses");

	const wrongFamily = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/responses", model: "m", interfaceFormat: "openai_responses", reasoningModels: {m: {mode: "off", profile: "qwen", effort: "low"}}}}});
	assert.equal(wrongFamily.client.getReasoningControlStatus("oaicompat").support, "unsupported");
	const rejectedProbe = wrongFamily.client.validateEngineConfig("oaicompat");
	assert.equal(wrongFamily.calls.length, 0, "an explicit probe with no compatible wire spec stops before HTTP");
	assert.equal((await rejectedProbe).ok, false);
	wrongFamily.client.translate("oaicompat", translationData(), () => {});
	assert.equal(wrongFamily.calls.length, 0, "an explicit mode with no compatible field fails before HTTP instead of sending no control");
});

test("native-family names on OpenAI Chat keep the pre-native OpenAI reasoning profile and capability", () => {
	const endpoint = "https://relay.test/v1/chat/completions";
	const model = "gemini-2.5-flash";
	const capability = {support: "accepted", candidateId: "openai_none", resolvedValue: "none", evidence: "confirmed", endpointKey: endpoint, format: "openai_chat", checkedAt: 1};
	const geminiNamed = createHarness({authKeys: {oaicompat: {key: "k", endpoint, model, interfaceFormat: "openai_chat", reasoningModels: {[model]: {mode: "off", profile: "auto", effort: "low", capability}}}}});
	assert.equal(geminiNamed.client.getReasoningControlStatus("oaicompat").effectiveProfile, "openai");
	assert.equal(geminiNamed.client.getReasoningControlStatus("oaicompat").support, "accepted", "the old OpenAI capability rehydrates unchanged");

	const ollamaHostname = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://ollama-gateway.test/v1/chat/completions", model: "model-x", interfaceFormat: "openai_chat"}}});
	assert.equal(ollamaHostname.client.getReasoningControlStatus("oaicompat").effectiveProfile, "openai");
	const claudeNamed = createHarness({authKeys: {oaicompat: {key: "k", endpoint, model: "claude-sonnet-5", interfaceFormat: "openai_chat"}}});
	assert.equal(claudeNamed.client.getReasoningControlStatus("oaicompat").effectiveProfile, "openai", "Anthropic model names do not change the Chat transport family");
});

test("M4 routes keyless Ollama native single validation batch and distinctive catalog surfaces", async () => {
	const authKeys = {oaicompat: {key: "", endpoint: "http://localhost:11434", model: "qwen3:8b", interfaceFormat: "auto", reasoningModels: {"qwen3:8b": {mode: "off", profile: "auto", effort: "low"}}}};
	const single = createHarness({authKeys});
	assert.equal(single.client.getReasoningControlStatus("oaicompat").effectiveProfile, "ollama");
	assert.equal(single.client.isEngineConfiguredForRuntime("oaicompat"), true, "local Ollama does not require a fake key");
	let translated = null;
	single.client.translate("oaicompat", translationData(), value => {translated = value;});
	assert.equal(single.lastCall().url, "http://localhost:11434/api/chat");
	assert.deepEqual(single.lastCall().options.headers, {"Content-Type": "application/json"});
	assert.equal(single.lastBody().stream, false);
	assert.equal(single.lastBody().messages[1].content.includes("hello there"), true);
	assert.equal(single.lastBody().think, false, "pending off still sends the exact close value");
	single.respond(0, null, {statusCode: 200}, JSON.stringify({message: {role: "assistant", content: "译文"}, done: true, prompt_eval_count: 10, eval_count: 4}));
	assert.equal(translated, "译文");

	const validation = createHarness({authKeys});
	const validationPending = validation.client.validateEngineConfig("oaicompat");
	assert.equal(validation.lastCall().url, "http://localhost:11434/api/chat");
	assert.equal(validation.lastBody().stream, false);
	assert.equal(validation.lastBody().options.num_predict, 512);
	assert.equal(validation.lastBody().think, false);
	validation.respond(0, null, {statusCode: 200}, JSON.stringify({message: {role: "assistant", content: "Guten Morgen", thinking: ""}, done: true}));
	assert.equal((await validationPending).ok, true);
	assert.equal(validation.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
	assert.equal(validation.authKeys.oaicompat.interfaceDetection.resolved, "ollama_native");
	assert.equal(validation.authKeys.oaicompat.interfaceDetection.evidence, "validation");
	validation.client.translate("oaicompat", translationData(), () => {});
	assert.equal(validation.lastBody().think, false, "production uses only the exact confirmed Ollama value");
	validation.respond(1, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: think"}}));
	assert.equal(validation.calls.length, 2, "production never strips a rejected explicit off field");

	const batch = createHarness({authKeys});
	const batchPending = batch.client.requestAiBatchTranslation("oaicompat", preparedItems());
	assert.equal(batch.lastCall().url, "http://localhost:11434/api/chat");
	assert.equal(batch.lastBody().stream, false);
	assert.equal(batch.lastBody().think, false, "pending batch requests carry off too");
	batch.respond(0, null, {statusCode: 200}, JSON.stringify({message: {content: '[{"id":"100","translation":"一"},{"id":"200","translation":"二"}]'}, done: true}));
	assert.deepEqual(await batchPending, {"100": "一", "200": "二"});

	const catalog = createHarness({authKeys});
	const catalogPending = catalog.client.fetchModelCatalog("oaicompat");
	assert.equal(catalog.lastCall().url, "http://localhost:11434/api/tags");
	assert.deepEqual(catalog.lastCall().options.headers, {});
	catalog.respond(0, null, {statusCode: 200}, JSON.stringify({models: [{name: "qwen3:8b"}, {model: "gpt-oss:20b"}]}));
	assert.deepEqual((await catalogPending).items, ["gpt-oss:20b", "qwen3:8b"]);
	assert.equal(catalog.authKeys.oaicompat.interfaceDetection.resolved, "ollama_native");
	assert.equal(catalog.authKeys.oaicompat.interfaceDetection.evidence, "catalog");

	const gptOss = createHarness({authKeys: {oaicompat: {key: "", endpoint: "http://localhost:11434", model: "gpt-oss:20b", reasoningModels: {"gpt-oss:20b": {mode: "off", profile: "auto", effort: "high"}}}}});
	const gptValidation = gptOss.client.validateEngineConfig("oaicompat");
	assert.equal(gptOss.lastBody().think, false, "a low level still thinks, so strict off uses the boolean close value");
	gptOss.respond(0, null, {statusCode: 200}, JSON.stringify({message: {content: "Guten Morgen", thinking: ""}, done: true}));
	assert.equal((await gptValidation).ok, true);
	assert.equal(gptOss.client.getReasoningControlStatus("oaicompat").support, "accepted");
});

test("M5a routes Gemini native single validation batch catalog and generation-specific reasoning", async () => {
	const authKeys = {oaicompat: {key: "gem-key", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.5-flash", reasoningModels: {"gemini-2.5-flash": {mode: "off", profile: "auto", effort: "low"}}}};
	const single = createHarness({authKeys});
	assert.equal(single.client.getReasoningControlStatus("oaicompat").effectiveProfile, "gemini");
	let translated = null;
	single.client.translate("oaicompat", translationData(), value => {translated = value;});
	assert.equal(single.lastCall().url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
	assert.equal(single.lastCall().options.headers["x-goog-api-key"], "gem-key");
	assert.equal(single.lastBody().contents[0].parts[0].text.includes("hello there"), true);
	assert.deepEqual(single.lastBody().generationConfig.thinkingConfig, {thinkingBudget: 0}, "pending off is sent unchanged");
	single.respond(0, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "译文"}]}}], usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 4}}));
	assert.equal(translated, "译文");

	const validation = createHarness({authKeys});
	const validationPending = validation.client.validateEngineConfig("oaicompat");
	assert.deepEqual(validation.lastBody().generationConfig.thinkingConfig, {thinkingBudget: 0});
	assert.equal(validation.lastBody().generationConfig.maxOutputTokens, 512);
	validation.respond(0, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "Guten Morgen"}]}}], usageMetadata: {promptTokenCount: 6, candidatesTokenCount: 3, thoughtsTokenCount: 0}}));
	assert.equal((await validationPending).ok, true);
	assert.equal(validation.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
	assert.equal(validation.authKeys.oaicompat.interfaceDetection.resolved, "gemini_native");
	validation.client.translate("oaicompat", translationData(), () => {});
	assert.deepEqual(validation.lastBody().generationConfig.thinkingConfig, {thinkingBudget: 0});
	validation.respond(1, null, {statusCode: 400}, JSON.stringify({error: {status: "INVALID_ARGUMENT", message: "Unknown name thinkingConfig"}}));
	assert.equal(validation.calls.length, 2, "Gemini production never falls back to provider default");

	const batch = createHarness({authKeys});
	const batchPending = batch.client.requestAiBatchTranslation("oaicompat", preparedItems());
	assert.equal(batch.lastCall().url.endsWith("/gemini-2.5-flash:generateContent"), true);
	assert.deepEqual(batch.lastBody().generationConfig.thinkingConfig, {thinkingBudget: 0});
	batch.respond(0, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: '[{"id":"100","translation":"一"},{"id":"200","translation":"二"}]'}]}}]}));
	assert.deepEqual(await batchPending, {"100": "一", "200": "二"});

	const catalog = createHarness({authKeys});
	const catalogPending = catalog.client.fetchModelCatalog("oaicompat");
	assert.equal(catalog.lastCall().url, "https://generativelanguage.googleapis.com/v1beta/models");
	catalog.respond(0, null, {statusCode: 200}, JSON.stringify({models: [{name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"]}, {name: "models/embed", supportedGenerationMethods: ["embedContent"]}]}));
	assert.deepEqual((await catalogPending).items, ["gemini-2.5-flash"]);
	assert.equal(catalog.authKeys.oaicompat.interfaceDetection.evidence, "catalog");

	const pro3 = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-3.1-pro", reasoningModels: {"gemini-3.1-pro": {mode: "off", profile: "auto", effort: "minimal"}}}}});
	const pro3Pending = pro3.client.validateEngineConfig("oaicompat");
	assert.equal(pro3.calls.length, 0, "a model with no close value is not sent a low thinking level");
	assert.equal((await pro3Pending).ok, false);

	const pro25 = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-2.5-pro", reasoningModels: {"gemini-2.5-pro": {mode: "off", profile: "auto", effort: "low"}}}}});
	const pro25Pending = pro25.client.validateEngineConfig("oaicompat");
	assert.deepEqual(pro25.lastBody().generationConfig.thinkingConfig, {thinkingBudget: 0});
	pro25.respond(0, null, {statusCode: 400}, JSON.stringify({error: {status: "INVALID_ARGUMENT", message: "Invalid value 0 for thinkingBudget; must be at least 128"}}));
	assert.equal(pro25.calls.length, 1, "128 is reduced thinking, not an off fallback");
	assert.equal((await pro25Pending).ok, false);
	assert.equal(pro25.client.getReasoningControlStatus("oaicompat").support, "unsupported");
});

test("M5b routes Anthropic Messages text blocks catalogs and model-specific thinking", async () => {
	const authKeys = {oaicompat: {key: "ant-key", endpoint: "https://api.anthropic.com", model: "claude-sonnet-5", reasoningModels: {"claude-sonnet-5": {mode: "off", profile: "auto", effort: "low"}}}};
	const single = createHarness({authKeys});
	assert.equal(single.client.getReasoningControlStatus("oaicompat").effectiveProfile, "anthropic");
	let translated = null;
	single.client.translate("oaicompat", translationData(), value => {translated = value;});
	assert.equal(single.lastCall().url, "https://api.anthropic.com/v1/messages");
	assert.equal(single.lastCall().options.headers["x-api-key"], "ant-key");
	assert.equal(single.lastCall().options.headers["anthropic-version"], "2023-06-01");
	assert.deepEqual(single.lastBody().thinking, {type: "disabled"}, "pending off is sent unchanged");
	single.respond(0, null, {statusCode: 200}, JSON.stringify({content: [{type: "thinking", thinking: "private"}, {type: "text", text: "译文"}], usage: {input_tokens: 10, output_tokens: 4}}));
	assert.equal(translated, "译文", "thinking blocks never enter the translated text");

	const validation = createHarness({authKeys});
	const validationPending = validation.client.validateEngineConfig("oaicompat");
	assert.deepEqual(validation.lastBody().thinking, {type: "disabled"});
	assert.equal(validation.lastBody().max_tokens, 512);
	validation.respond(0, null, {statusCode: 200}, JSON.stringify({content: [{type: "text", text: "Guten Morgen"}], usage: {input_tokens: 6, output_tokens: 3}}));
	assert.equal((await validationPending).ok, true);
	assert.equal(validation.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
	assert.equal(validation.authKeys.oaicompat.interfaceDetection.resolved, "anthropic_messages");
	validation.client.translate("oaicompat", translationData(), () => {});
	assert.deepEqual(validation.lastBody().thinking, {type: "disabled"});
	validation.respond(1, null, {statusCode: 400}, JSON.stringify({error: {type: "invalid_request_error", message: "Unknown parameter thinking"}}));
	assert.equal(validation.calls.length, 2, "production never strips an explicit off field");

	const batch = createHarness({authKeys});
	const batchPending = batch.client.requestAiBatchTranslation("oaicompat", preparedItems());
	assert.equal(batch.lastCall().url, "https://api.anthropic.com/v1/messages");
	assert.deepEqual(batch.lastBody().thinking, {type: "disabled"});
	batch.respond(0, null, {statusCode: 200}, JSON.stringify({content: [{type: "text", text: '[{"id":"100","translation":"一"},{"id":"200","translation":"二"}]'}]}));
	assert.deepEqual(await batchPending, {"100": "一", "200": "二"});

	const catalog = createHarness({authKeys});
	const catalogPending = catalog.client.fetchModelCatalog("oaicompat");
	assert.equal(catalog.lastCall().url, "https://api.anthropic.com/v1/models");
	catalog.respond(0, null, {statusCode: 200}, JSON.stringify({data: [{id: "claude-sonnet-5", type: "model", display_name: "Claude Sonnet 5"}]}));
	assert.deepEqual((await catalogPending).items, ["claude-sonnet-5"]);
	assert.equal(catalog.authKeys.oaicompat.interfaceDetection.evidence, "catalog");

	const fable = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.anthropic.com/v1/messages", model: "claude-fable-5", reasoningModels: {"claude-fable-5": {mode: "off", profile: "auto", effort: "low"}}}}});
	const fablePending = fable.client.validateEngineConfig("oaicompat");
	assert.equal(fable.calls.length, 0, "adaptive low still thinks and is not dispatched as off");
	assert.equal((await fablePending).ok, false);

	const old = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-5", reasoningModels: {"claude-sonnet-4-5": {mode: "on", profile: "auto", effort: "low"}}}}});
	const oldPending = old.client.validateEngineConfig("oaicompat");
	assert.deepEqual(old.lastBody().thinking, {type: "enabled", budget_tokens: 1024, display: "omitted"});
	assert.equal(old.lastBody().max_tokens, 1536, "thinking budget remains strictly below the validation max_tokens");
	assert.equal(old.lastBody().temperature, 1);
	old.respond(0, null, {statusCode: 200}, JSON.stringify({content: [{type: "thinking", thinking: "summary"}, {type: "text", text: "Hallo"}]}));
	assert.equal((await oldPending).ok, true);

	const missedAlwaysOn = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.anthropic.com/v1/messages", model: "future-thinking-model", reasoningModels: {"future-thinking-model": {mode: "off", profile: "auto", effort: "low"}}}}});
	const missedPending = missedAlwaysOn.client.validateEngineConfig("oaicompat");
	assert.deepEqual(missedAlwaysOn.lastBody().thinking, {type: "disabled"});
	missedAlwaysOn.respond(0, null, {statusCode: 400}, JSON.stringify({error: {type: "invalid_request_error", message: '"thinking.type.disabled" is not supported for this model'}}));
	assert.equal(missedAlwaysOn.calls.length, 1, "a rejected close value never advances to adaptive low");
	assert.equal((await missedPending).ok, false);
	assert.equal(missedAlwaysOn.client.getReasoningControlStatus("oaicompat").support, "unsupported");

	const unknownOn = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.anthropic.com/v1/messages", model: "future-claude", reasoningModels: {"future-claude": {mode: "on", profile: "auto", effort: "low"}}}}});
	const unknownOnPending = unknownOn.client.validateEngineConfig("oaicompat");
	assert.deepEqual(unknownOn.lastBody().thinking, {type: "adaptive", display: "omitted"});
	unknownOn.respond(0, null, {statusCode: 400}, JSON.stringify({error: {type: "invalid_request_error", message: "adaptive thinking is not supported on this model"}}));
	assert.equal(unknownOn.calls.length, 1, "T4: the refusal is reported instead of another schema being tried");
	assert.equal((await unknownOnPending).ok, false);
	const unknownOnRewrite = unknownOn.client.validateEngineConfig("oaicompat", {rewrite: true});
	assert.deepEqual(unknownOn.lastBody().thinking, {type: "enabled", budget_tokens: 1024, display: "omitted"}, "an explicit re-validation reaches the manual budget schema");
	assert.equal(unknownOn.lastBody().max_tokens, 1536);
	unknownOn.respond(1, null, {statusCode: 200}, JSON.stringify({content: [{type: "thinking", thinking: "summary"}, {type: "text", text: "Hallo"}]}));
	assert.equal((await unknownOnRewrite).ok, true);
});

test("Gemini translation targets generateContent with the key only in a header", () => {
	const harness = createHarness({authKeys: AI_AUTH});
	let translated = null;
	harness.client.geminiTranslate(translationData(), value => {translated = value;});
	const call = harness.lastCall();
	assert.equal(crypto.createHash("sha256").update(`${call.url}\n${JSON.stringify(call.options.headers || {})}\n${String(call.options.body || "")}`).digest("hex").toUpperCase(), "BE99964F774861082AA17DF14D15275EF7ED17E77950EA49EC6D4271C2E54B20", "official Gemini wire bytes stay fixed while custom Gemini evolves");

	assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
	assert.equal(call.options.headers["x-goog-api-key"], "k-gemini");
	assert.doesNotMatch(call.url, /k-gemini/);
	const body = JSON.parse(call.options.body);
	assert.equal(body.system_instruction.parts[0].text, "You are a senior bilingual localization specialist");
	assert.equal(body.contents[0].role, "user");
	assert.deepEqual(body.generationConfig, {temperature: 0.2, topP: 0.8});

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "你好"}]}}]}));
	assert.equal(translated, "你好");

	// A `models/` prefix on the stored id must not be doubled into the path.
	const prefixed = createHarness({authKeys: {gemini: {key: "k", model: "models/gemini-y"}}});
	prefixed.client.geminiTranslate(translationData(), () => {});
	assert.match(prefixed.lastCall().url, /\/models\/gemini-y:generateContent$/);
	assert.equal(prefixed.lastCall().options.headers["x-goog-api-key"], "k");
});

test("chat-completions engines restore [NEWLINE] markers to real line breaks", () => {
	const harness = createHarness({authKeys: AI_AUTH});
	let translated = null;
	harness.client.deepSeekTranslate(translationData(), value => {translated = value;});
	const body = JSON.parse(harness.lastCall().options.body);

	assert.equal(harness.lastCall().url, "https://api.deepseek.com/chat/completions");
	assert.equal(body.model, "ds-x");
	assert.equal(body.messages[0].role, "system");
	assert.equal(body.messages[1].role, "user");
	assert.equal(body.temperature, 0.2);
	assert.equal(body.top_p, 0.8);

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "第一行 [NEWLINE] 第二行"}}]}));
	assert.equal(translated, "第一行 \n 第二行");
});

test("custom OpenAI Chat adapter preserves the four provider wire snapshots captured before M1", () => {
	const authKeys = {oaicompat: {key: "k-compat", endpoint: "https://compat.example/v1/chat/completions", model: "compat-x"}};
	const hashCall = call => crypto.createHash("sha256").update(`${call.url}\n${JSON.stringify(call.options.headers || {})}\n${String(call.options.body || "")}`).digest("hex").toUpperCase();

	const single = createHarness({authKeys});
	single.client.translate("oaicompat", translationData(), () => {});
	assert.equal(hashCall(single.calls[0]), "20C6EDED4CC69E1E75D8CA8BCCCFBBB92FF5878360592D82E32C33C45D8F8D84");

	const validation = createHarness({authKeys});
	validation.client.validateEngineConfig("oaicompat");
	assert.equal(hashCall(validation.calls[0]), "83D6BEC5DAB409CD446064DFF0F717E934661178EBB2028082ADB7A337B467C1");

	const batch = createHarness({authKeys});
	batch.client.requestAiBatchTranslation("oaicompat", preparedItems());
	// Re-pinned 2026-09-14: the legacy batch system prompt carries the harness preference text.
	assert.equal(hashCall(batch.calls[0]), "DE476E957FEA015BFA1B114346677EDAAF1F8F2AD34BB7B5D1038A45F3BBEFAA");

	const catalog = createHarness({authKeys});
	catalog.client.fetchModelCatalog("oaicompat");
	assert.equal(hashCall(catalog.calls[0]), "A4E37018F54468F4E77D0F991FC7458CC6FC29BEEE26282C3B505B3D3BF49119");
});

test("an unconfigured chat-completions engine answers empty without touching the network", () => {
	const harness = createHarness();
	let translated = "untouched";
	harness.client.openAiCompatibleTranslate(translationData(), value => {translated = value;});
	assert.equal(translated, "");
	assert.equal(harness.calls.length, 0);
});

test("a failed AI response reports the provider's own reason and yields empty text", () => {
	const harness = createHarness({authKeys: AI_AUTH});
	let translated = null;
	harness.client.openAiTranslate(translationData(), value => {translated = value;});
	harness.respond(0, null, {statusCode: 401}, JSON.stringify({error: {message: "invalid key"}}));

	assert.equal(translated, "");
	assert.equal(harness.toasts[0].message, "FAILED (OpenAI) - invalid key");

	// A 200 that parses to nothing is still a failure, not a blank translation.
	const empty = createHarness({authKeys: AI_AUTH});
	let emptyResult = null;
	empty.client.openAiTranslate(translationData(), value => {emptyResult = value;});
	empty.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "   "}));
	assert.equal(emptyResult, "");
	assert.equal(empty.toasts.length, 1);
});

test("provider error details redact configured credentials in JSON and plain text", () => {
	const jsonSecret = "json-secret-123";
	const jsonHarness = createHarness({authKeys: {openai: {key: jsonSecret}}});
	jsonHarness.client.openAiTranslate(translationData(), () => {});
	jsonHarness.respond(0, null, {statusCode: 401}, JSON.stringify({error: {message: `credential ${jsonSecret} rejected`}}));
	assert.equal(jsonHarness.toasts[0].message, "FAILED (OpenAI) - credential [REDACTED] rejected");
	assert.doesNotMatch(jsonHarness.toasts[0].message, new RegExp(jsonSecret));

	const plainSecret = "plain-secret-456";
	const plainHarness = createHarness({authKeys: {oaicompat: {key: plainSecret, endpoint: "https://compat.example/v1/chat/completions", model: "m"}}});
	const pending = plainHarness.client.validateEngineConfig("oaicompat");
	plainHarness.respond(0, null, {statusCode: 403}, `upstream echoed ${plainSecret}`);
	return pending.then(() => {
		assert.match(plainHarness.toasts.at(-1).message, /upstream echoed \[REDACTED\]$/);
		assert.doesNotMatch(plainHarness.toasts.at(-1).message, new RegExp(plainSecret));
	});
});

test("Papago detects the source language in a separate hop before translating", () => {
	const harness = createHarness({authKeys: {papago: {key: "client-id client-secret"}}, languages: {ja: {name: "Japanese", ownlang: "日本語"}}});
	const data = translationData({input: {id: "auto", auto: true}, output: {id: "en", name: "English"}});
	harness.client.papagoTranslate(data, () => {});

	assert.equal(harness.calls[0].url, "https://openapi.naver.com/v1/papago/detectLangs");
	assert.equal(harness.calls[0].options.headers["X-Naver-Client-Id"], "client-id");
	assert.equal(harness.calls[0].options.headers["X-Naver-Client-Secret"], "client-secret");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({langCode: "ja"}));

	assert.equal(data.input.name, "Japanese");
	assert.equal(harness.calls[1].url, "https://openapi.naver.com/v1/papago/n2mt");
	assert.deepEqual(harness.calls[1].options.form, {source: "ja", target: "en", text: "hello there"});

	// A known source language skips detection.
	const fixed = createHarness({authKeys: {papago: {key: "id secret"}}});
	fixed.client.papagoTranslate(translationData({output: {id: "ja", name: "Japanese"}}), () => {});
	assert.equal(fixed.calls.length, 1);
	assert.equal(fixed.calls[0].url, "https://openapi.naver.com/v1/papago/n2mt");
});

test("Papago stops safely when detection omits or returns an unsupported langCode", () => {
	for (const detectedBody of [{}, {langCode: "not-supported"}]) {
		const harness = createHarness({
			authKeys: {papago: {key: "client-id client-secret"}},
			languages: {en: {name: "English", ownlang: "English"}}
		});
		const data = translationData({input: {id: "auto", name: "Auto", auto: true}});
		const seen = [];
		harness.client.papagoTranslate(data, value => seen.push(value));

		assert.doesNotThrow(() => harness.respond(0, null, {statusCode: 200}, JSON.stringify(detectedBody)));
		assert.equal(harness.calls.length, 1, "an invalid detection does not spend a translation request");
		assert.deepEqual(seen, [""]);
		assert.deepEqual(data.input, {id: "auto", name: "Auto", auto: true});
	}
});

test("Papago detection timeout completes once without starting a guessed translation", () => {
	const harness = createHarness({
		authKeys: {papago: {key: "client-id client-secret"}},
		languages: {en: {name: "English", ownlang: "English"}, ja: {name: "Japanese", ownlang: "日本語"}}
	});
	const seen = [];
	harness.client.papagoTranslate(translationData({input: {id: "auto", name: "Auto", auto: true}}), value => seen.push(value));

	harness.fireTimer(0);
	assert.equal(harness.calls.length, 1);
	assert.deepEqual(seen, [""]);
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({langCode: "ja"}));
	assert.equal(harness.calls.length, 1, "late detection is ignored");
	assert.deepEqual(seen, [""], "the callback stays terminal after timeout");
});

test("Papago canonicalizes detected Chinese codes before validating and translating", () => {
	const harness = createHarness({
		authKeys: {papago: {key: "client-id client-secret"}},
		languages: {"zh-CN": {name: "Simplified Chinese", ownlang: "简体中文"}}
	});
	const data = translationData({input: {id: "auto", name: "Auto", auto: true}, output: {id: "ko", name: "Korean"}});
	harness.client.papagoTranslate(data, () => {});
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({langCode: "zh-cn"}));

	assert.equal(harness.calls.length, 2);
	assert.deepEqual(harness.calls[1].options.form, {source: "zh-CN", target: "ko", text: "hello there"});
	assert.equal(data.input.name, "Simplified Chinese");
});

test("Papago refuses unsupported fixed language pairs before touching the network", () => {
	const harness = createHarness({authKeys: {papago: {key: "client-id client-secret"}}});
	const seen = [];
	harness.client.papagoTranslate(translationData({input: {id: "es", name: "Spanish"}, output: {id: "fr", name: "French"}}), value => seen.push(value));

	assert.equal(harness.calls.length, 0);
	assert.deepEqual(seen, [""]);
});

test("Baidu signs the request with MD5 over appid, text, salt and secret", () => {
	const harness = createHarness({authKeys: {baidu: {key: "appid-1 secret-1"}}});
	harness.client.baiduTranslate(translationData(), () => {});
	const form = harness.lastCall().options.form;

	assert.equal(harness.lastCall().options.bdVersion, true);
	assert.equal(form.appid, "appid-1");
	assert.equal(form.salt, "SALT");
	assert.equal(form.to, "zh", "the dialect table maps zh-CN to Baidu's zh");
	assert.equal(form.q, encodeURIComponent("hello there"));
	assert.equal(form.sign, MD5("appid-1hello thereSALTsecret-1"));

	// A three-part credential uses the third field as the secret.
	const threePart = createHarness({authKeys: {baidu: {key: "appid-1 ignored secret-2"}}});
	threePart.client.baiduTranslate(translationData(), () => {});
	assert.equal(threePart.lastCall().options.form.sign, MD5("appid-1hello thereSALTsecret-2"));
	const split = createHarness({authKeys: {baidu: {appId: "fixture-app", secretKey: "fixture-secret", key: "old-app old-secret"}}});
	assert.equal(split.client.isEngineConfiguredForRuntime("baidu"), true);
	split.client.baiduTranslate(translationData(), () => {});
	assert.equal(split.lastCall().options.form.appid, "fixture-app");
	assert.equal(split.lastCall().options.form.sign, MD5("fixture-apphello thereSALTfixture-secret"));
	split.respond(0, null, {statusCode: 200}, JSON.stringify({error_code: 52003, error_msg: "fixture-secret unauthorized"}));
	assert.doesNotMatch(split.toasts[0].message, /fixture-secret/);
	assert.equal(createHarness({authKeys: {baidu: {appId: "", secretKey: "fixture-secret", key: "old-app old-secret"}}}).client.isEngineConfiguredForRuntime("baidu"), false);
});

test("a Baidu error code is surfaced while split credentials stay redacted", () => {
	const quota = createHarness({authKeys: {baidu: {key: "a b"}}});
	quota.client.baiduTranslate(translationData(), () => {});
	quota.respond(0, null, {statusCode: 200}, JSON.stringify({error_code: 54004, error_msg: "quota"}));
	assert.match(quota.toasts[0].message, /MONTHLY\.$/);

	const other = createHarness({authKeys: {baidu: {key: "appid-visible secret-visible"}}});
	other.client.baiduTranslate(translationData(), () => {});
	other.respond(0, null, {statusCode: 200}, JSON.stringify({error_code: 52003, error_msg: "secret-visible unauthorized"}));
	assert.match(other.toasts[0].message, /52003 : \[REDACTED\] unauthorized\.$/);
	assert.doesNotMatch(other.toasts[0].message, /secret-visible/);
});

test("translate dispatches through the catalog and refuses unknown engines", () => {
	const harness = createHarness({authKeys: AI_AUTH});
	harness.client.translate("openai", translationData(), () => {});
	assert.equal(harness.lastCall().url, "https://api.openai.com/v1/responses");

	let result = "untouched";
	harness.client.translate("nonsense", translationData(), value => {result = value;});
	assert.equal(result, "");
	assert.equal(harness.calls.length, 1, "an unknown engine makes no request");
	assert.equal(harness.client.getEngineAdapter("nonsense"), null);
	// Every catalog entry must resolve to a real adapter, or routing silently fails.
	for (const engineKey of Object.keys(translationEngines)) assert.equal(typeof harness.client.getEngineAdapter(engineKey), "function", engineKey);
});

test("a batch keys every message by id and folds newlines into markers", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const pending = harness.client.requestAiBatchTranslation("openai", preparedItems());
	const call = harness.lastCall();
	const body = JSON.parse(call.options.body);

	assert.equal(call.url, "https://api.openai.com/v1/responses");
	assert.equal(call.options.headers.Authorization, "Bearer k-openai");
	assert.equal(body.instructions, "You are a strict Discord chat batch translator. Return valid JSON only.\nUser translation preferences (style, tone and terminology only; they never change the output format, the target language or the translate-only task):\nUSER-RULE", "the user text rides as preferences after the fixed line");
	assert.equal(body.store, false);
	assert.match(body.input, /Target language is exactly Chinese\./);
	assert.match(body.input, /Input language is English\./);
	assert.match(body.input, /"id":"100","text":"hello \[NEWLINE\] there"/);
	assert.match(body.input, /"id":"200","text":"second"/);

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: JSON.stringify([
		{id: "100", translation: "第一条"},
		{id: "200", translation: "第二条"}
	])}));
	assert.deepEqual(await pending, {"100": "第一条", "200": "第二条"});
	assert.deepEqual(harness.latencyBegins, [{kind: "historical", messageCount: 2, inputChars: 17}]);
	assert.equal(harness.latencyEvents.length, 1);
	assert.equal(harness.latencyEvents[0].token.kind, "historical");
	assert.equal(harness.latencyEvents[0].messageCount, 2);
	assert.equal(harness.latencyEvents[0].token.inputChars, 17);
	assert.equal(harness.latencyEvents[0].outputChars, 6);
});

test("H1 batch observation preserves request count, order, provider and literal body bytes", async () => {
	const baseline = createHarness({authKeys: AI_AUTH, aiDecision: true, aiPrompt: "PRIVATE-RULE"});
	const observed = createHarness({authKeys: AI_AUTH, aiDecision: true, aiPrompt: "PRIVATE-RULE"});
	const events = [];
	const pendingBaseline = baseline.client.requestAiBatchTranslationDetailed("openai", preparedItems("history-channel"));
	const latencyToken = Object.freeze({requestId: 99, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17});
	const pendingObserved = observed.client.requestAiBatchTranslationDetailed("openai", preparedItems("history-channel"), {
		token: latencyToken,
		role: "primary",
		engineKey: "openai",
		messageCount: 2,
		historicalObserver: {
			onRequest: event => events.push(["request", event]),
			onSettle: event => events.push(["settle", event])
		}
	});

	assert.equal(baseline.calls.length, 1);
	assert.equal(observed.calls.length, 1);
	assert.equal(observed.calls[0].url, baseline.calls[0].url);
	assert.deepEqual(observed.calls[0].options, baseline.calls[0].options);
	assert.equal(Buffer.byteLength(observed.calls[0].options.body, "utf8"), Buffer.byteLength(baseline.calls[0].options.body, "utf8"));

	const response = JSON.stringify({
		status: "completed",
		usage: {input_tokens: 123, output_tokens: 45},
		output_text: JSON.stringify([{id: "100", translation: "第一条"}, {id: "200", translation: "第二条"}])
	});
	baseline.respond(0, null, {statusCode: 200}, response);
	observed.respond(0, null, {statusCode: 200}, response);
	assert.deepEqual(await pendingObserved, await pendingBaseline);
	assert.equal(events.length, 2);
	assert.equal(events[0][0], "request");
	assert.equal(events[0][1].bodyBytes, Buffer.byteLength(observed.calls[0].options.body, "utf8"));
	assert.match(events[0][1].transportKey, /^tk1:/);
	assert.match(events[0][1].workloadKey, /^wk1:/);
	assert.equal(events[1][0], "settle");
	assert.deepEqual(events[1][1].usage, {promptTokens: 123, completionTokens: 45, reasoningTokens: null});
	assert.equal(events[1][1].finishReason, "completed");
	assert.equal(events[1][1].headers, null);
	assert.equal(events[1][1].ttftMs, null);
	assert.equal(events[1][1].physicalAbort, null);
	const serialized = JSON.stringify(events);
	assert.doesNotMatch(serialized, /k-openai|api\.openai\.com|PRIVATE-RULE|hello|second/);
});

test("S3H admission sees the captured Transport Key and exact request budgets before an unchanged historical dispatch", async () => {
	const baseline = createHarness({authKeys: AI_AUTH});
	const observed = createHarness({authKeys: AI_AUTH});
	let grant;
	const admissionCalls = [];
	const releases = [];
	const admission = {
		acquireAttempt(meta) {
			admissionCalls.push(meta);
			return new Promise(resolve => {grant = resolve;});
		},
		releaseAttempt: (lease, outcome) => releases.push({lease, outcome})
	};
	const pendingBaseline = baseline.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	const timingToken = Object.freeze({requestId: 77, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17});
	const pendingObserved = observed.client.requestAiBatchTranslationDetailed("openai", preparedItems(), {token: timingToken, role: "primary", engineKey: "openai", messageCount: 2, historicalAdmission: admission});
	await nextTurn();
	assert.equal(observed.calls.length, 0, "provider transport waits outside the captured-key budget");
	assert.equal(admissionCalls.length, 1);
	assert.match(admissionCalls[0].transportKey, /^tk1:/);
	assert.equal(admissionCalls[0].itemCount, 2);
	assert.equal(admissionCalls[0].protectedChars, 17);
	assert.equal(admissionCalls[0].bodyBytes, Buffer.byteLength(baseline.calls[0].options.body, "utf8"));
	assert.equal(admissionCalls[0].estimatedTokens, Math.ceil(admissionCalls[0].bodyBytes / 4));
	const lease = Object.freeze({granted: true, attemptId: 1});
	grant(lease);
	await nextTurn();
	assert.equal(observed.calls.length, 1);
	assert.equal(observed.calls[0].url, baseline.calls[0].url);
	assert.deepEqual(observed.calls[0].options, baseline.calls[0].options);
	const response = JSON.stringify({output_text: JSON.stringify([{id: "100", translation: "第一条"}, {id: "200", translation: "第二条"}])});
	baseline.respond(0, null, {statusCode: 200}, response);
	observed.respond(0, null, {statusCode: 200}, response);
	assert.deepEqual(await pendingObserved, await pendingBaseline);
	assert.equal(releases.length, 1);
	assert.equal(releases[0].lease, lease);
	assert.equal(releases[0].outcome.logicalOnlyBeforeS4, true);
});

test("S3H denied multi-item admission sends zero provider requests and records zero latency attempts", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const pending = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems(), {
		token: Object.freeze({requestId: 88, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
		role: "primary",
		engineKey: "openai",
		messageCount: 2,
		historicalAdmission: {acquireAttempt: () => Promise.resolve(Object.freeze({granted: false, reason: "request_budget", exceeded: Object.freeze(["body_bytes"])})), releaseAttempt: () => {throw new Error("denied admission has no lease");}}
	});
	assert.deepEqual(await pending, {translations: null, failureKind: "request_budget", statusCode: 413});
	assert.equal(harness.calls.length, 0);
	assert.equal(harness.latencyEvents.length, 0);
});

test("S3H single repair and batch primary capture the same Transport Key but distinct Workload Keys", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const admissions = [];
	const admission = {
		acquireAttempt: meta => (admissions.push(meta), Promise.resolve(Object.freeze({granted: true, attemptId: admissions.length}))),
		releaseAttempt: () => true
	};
	const batch = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems(), {
		token: Object.freeze({requestId: 91, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}), role: "primary", engineKey: "openai", messageCount: 2, historicalAdmission: admission
	});
	await nextTurn();
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "[]"}));
	await batch;
	let singleResult = null;
	harness.client.openAiTranslate(Object.assign(translationData(), {timingContext: {
		token: Object.freeze({requestId: 92, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 1, inputChars: 5}), role: "retry", engineKey: "openai", messageCount: 1, historicalAdmission: admission
	}}), result => {singleResult = result;});
	await nextTurn();
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({output_text: "译文"}));
	await nextTurn();
	assert.equal(singleResult, "译文");
	assert.equal(admissions.length, 2);
	assert.equal(admissions[0].transportKey, admissions[1].transportKey);
	assert.notEqual(admissions[0].workloadKey, admissions[1].workloadKey);
	assert.equal(admissions[1].role, "repair");
});

test("S3H callback timeout releases the logical lease once without claiming physical abort", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const lease = Object.freeze({granted: true, attemptId: 1});
	const releases = [];
	const pending = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems(), {
		token: Object.freeze({requestId: 93, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
		role: "primary",
		engineKey: "openai",
		messageCount: 2,
		historicalAdmission: {acquireAttempt: () => Promise.resolve(lease), releaseAttempt: (released, outcome) => releases.push({released, outcome})}
	});
	await nextTurn();
	assert.equal(harness.calls.length, 1);
	harness.fireTimer(0);
	assert.deepEqual(await pending, {translations: null, failureKind: "transient", statusCode: 504});
	assert.equal(releases.length, 1);
	assert.equal(releases[0].released, lease);
	assert.deepEqual(releases[0].outcome, {logicalOnlyBeforeS4: true, timedOut: true, statusCode: 504, errorClass: "timeout", retryAfterMs: null, error: false});
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "[]"}));
	assert.equal(releases.length, 1, "late callback cannot release or settle a second time");
});

test("S3H rechecks currentness after queued admission and releases without provider dispatch", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	let grant;
	let current = true;
	const releases = [];
	const pending = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems(), {
		token: Object.freeze({requestId: 94, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
		role: "primary",
		engineKey: "openai",
		messageCount: 2,
		historicalAdmission: {
			acquireAttempt: () => new Promise(resolve => {grant = resolve;}),
			releaseAttempt: (lease, outcome) => releases.push({lease, outcome}),
			isCurrent: () => current
		}
	});
	await nextTurn();
	current = false;
	const lease = Object.freeze({granted: true, attemptId: 1});
	grant(lease);
	assert.deepEqual(await pending, {translations: null, failureKind: "attempt_budget", statusCode: 409});
	assert.equal(harness.calls.length, 0);
	assert.deepEqual(releases, [{lease, outcome: {logicalOnlyBeforeS4: true, cancelledBeforeDispatch: true}}]);
});

test("S3H classic backup requests also use captured-key admission without changing their form", async () => {
	const baseline = createHarness();
	const observed = createHarness();
	const admissions = [];
	let baselineResult = null, observedResult = null;
	baseline.client.googleApiTranslate(translationData(), result => {baselineResult = result;});
	observed.client.googleApiTranslate(Object.assign(translationData(), {timingContext: {
		token: Object.freeze({requestId: 95, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 1, inputChars: 5}),
		role: "backup",
		engineKey: "googleapi",
		messageCount: 1,
		historicalAdmission: {acquireAttempt: meta => (admissions.push(meta), Promise.resolve(Object.freeze({granted: true, attemptId: 1}))), releaseAttempt: () => true}
	}}), result => {observedResult = result;});
	await nextTurn();
	assert.equal(observed.calls.length, 1);
	assert.equal(observed.calls[0].url, baseline.calls[0].url);
	assert.deepEqual(observed.calls[0].options, baseline.calls[0].options);
	assert.equal(admissions.length, 1);
	assert.equal(admissions[0].role, "backup");
	assert.equal(admissions[0].itemCount, 1);
	assert.ok(admissions[0].bodyBytes > 0);
	const response = JSON.stringify({src: "en", sentences: [{trans: "译文"}]});
	baseline.respond(0, null, {statusCode: 200}, response);
	observed.respond(0, null, {statusCode: 200}, response);
	await nextTurn();
	assert.equal(observedResult, baselineResult);
	assert.equal(observedResult, "译文");
});

test("a batch without AI decision mode forbids the model from skipping", async () => {
	const harness = createHarness({authKeys: AI_AUTH, aiDecision: false});
	const pending = harness.client.requestAiBatchTranslation("deepseek", preparedItems());
	const prompt = JSON.parse(harness.lastCall().options.body).messages.map(entry => entry.content).join("\n");

	assert.match(prompt, /The plugin has already filtered messages that should be skipped; do not make skip decisions\./);
	assert.doesNotMatch(prompt, /__SKIP_TRANSLATION__/, "no skip verdict is offered when the plugin already decided");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "[]"}}]}));
	assert.deepEqual(await pending, {});
});

test("AI decision mode carries the user's own skip rules into the batch prompt", async () => {
	const harness = createHarness({authKeys: AI_AUTH, aiDecision: true, aiPrompt: "DISTINCT-USER-RULE"});
	const pending = harness.client.requestAiBatchTranslation("deepseek", preparedItems("channel-ai"));
	const prompt = JSON.parse(harness.lastCall().options.body).messages.map(entry => entry.content).join("\n");

	assert.match(prompt, /DISTINCT-USER-RULE/, "the user's text reaches the batch request as translation preferences");
	assert.match(prompt, /Decide first whether this received message needs translation/, "the skip rules themselves are fixed code, not the user's text");
	assert.match(prompt, /set its "translation" to exactly __SKIP_TRANSLATION__/, "each item may answer with a skip verdict");
	assert.doesNotMatch(prompt, /do not make skip decisions/, "the no-skip instruction must not contradict AI decision mode");

	// A per-item skip verdict comes back as an ordinary translation value.
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: JSON.stringify([
		{id: "100", translation: AI_SKIP_TRANSLATION_TOKEN},
		{id: "200", translation: "第二条"}
	])}}]}));
	assert.deepEqual(await pending, {"100": AI_SKIP_TRANSLATION_TOKEN, "200": "第二条"});
});

test("a Gemini batch posts to generateContent with a low temperature", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const pending = harness.client.requestAiBatchTranslation("gemini", preparedItems());
	const call = harness.lastCall();
	const body = JSON.parse(call.options.body);

	assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
	assert.equal(call.options.headers["x-goog-api-key"], "k-gemini");
	assert.deepEqual(body.generationConfig, {temperature: 0.1, topP: 0.8});
	assert.match(body.contents[0].parts[0].text, /Messages JSON:/);

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: '[{"id":"100","translation":"一"}]'}]}}]}));
	assert.deepEqual(await pending, {"100": "一"});
});

test("a chat-completions batch pins temperature and top_p", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const pending = harness.client.requestAiBatchTranslation("oaicompat", preparedItems());
	const body = JSON.parse(harness.lastCall().options.body);

	assert.equal(harness.lastCall().url, "https://compat.example/v1/chat/completions");
	assert.equal(body.model, "compat-x");
	assert.equal(body.temperature, 0.1);
	assert.equal(body.top_p, 0.8);

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: '[{"id":"100","translation":"一"}]'}}]}));
	assert.deepEqual(await pending, {"100": "一"});
});

test("a batch refuses to start without an engine, items or credentials", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	assert.equal(await harness.client.requestAiBatchTranslation("", preparedItems()), null);
	assert.equal(await harness.client.requestAiBatchTranslation("openai", []), null);
	assert.equal(await harness.client.requestAiBatchTranslation("openai", null), null);
	assert.equal(await createHarness().client.requestAiBatchTranslation("openai", preparedItems()), null, "no credentials, no request");
	assert.equal(harness.calls.length, 0);
});

test("a batch that errors or times out resolves null rather than a partial map", async () => {
	const failed = createHarness({authKeys: AI_AUTH});
	const failedPending = failed.client.requestAiBatchTranslation("openai", preparedItems());
	failed.respond(0, null, {statusCode: 500}, "boom");
	assert.equal(await failedPending, null);
	// The 5xx still opens the shared backoff window the queue consults.
	assert.equal(failed.client.isBackoffActive(), true);

	const timedOut = createHarness({authKeys: AI_AUTH});
	const timedOutPending = timedOut.client.requestAiBatchTranslation("openai", preparedItems());
	timedOut.fireTimer(0);
	assert.equal(await timedOutPending, null);

	// A 200 whose content is not a JSON array is a failure, not an empty batch.
	const garbled = createHarness({authKeys: AI_AUTH});
	const garbledPending = garbled.client.requestAiBatchTranslation("openai", preparedItems());
	garbled.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "I cannot do that."}));
	assert.equal(await garbledPending, null);
});

test("detailed batch outcomes distinguish authentication transient and malformed failures", async () => {
	for (const statusCode of [401, 403]) {
		const harness = createHarness({authKeys: AI_AUTH});
		const pending = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems());
		harness.respond(0, null, {statusCode}, "bad credentials");
		assert.deepEqual(await pending, {translations: null, failureKind: "auth", statusCode});
		assert.equal(harness.calls.length, 1);
		assert.equal(harness.toasts.length, 1, "the terminal batch still tells the user why it stopped");
		assert.match(harness.toasts[0].message, /KEYOUTDATED/);
	}

	const unavailable = createHarness({authKeys: AI_AUTH});
	const unavailablePending = unavailable.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	unavailable.respond(0, null, {statusCode: 503}, "unavailable");
	assert.deepEqual(await unavailablePending, {translations: null, failureKind: "server", statusCode: 503});

	const timedOut = createHarness({authKeys: AI_AUTH});
	const timedOutPending = timedOut.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	timedOut.fireTimer(0);
	assert.deepEqual(await timedOutPending, {translations: null, failureKind: "transient", statusCode: 504});

	const malformed = createHarness({authKeys: AI_AUTH});
	const malformedPending = malformed.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	malformed.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "not a batch"}));
	assert.deepEqual(await malformedPending, {translations: null, failureKind: "malformed", statusCode: 200});
});

test("detailed batch success preserves the old map-only batch API", async () => {
	const detailed = createHarness({authKeys: AI_AUTH});
	const detailedPending = detailed.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	detailed.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: '[{"id":"100","translation":"一"}]'}));
	assert.deepEqual(await detailedPending, {translations: {"100": "一"}, failureKind: null, statusCode: 200});

	const compatible = createHarness({authKeys: AI_AUTH});
	const compatiblePending = compatible.client.requestAiBatchTranslation("openai", preparedItems());
	compatible.respond(0, null, {statusCode: 401}, "bad credentials");
	assert.equal(await compatiblePending, null);
});

test("a batch answer for a message that was not asked about is discarded", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const pending = harness.client.requestAiBatchTranslation("openai", preparedItems());
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: JSON.stringify([
		{id: "100", translation: "第一条"},
		{id: "999", translation: "不属于本批"}
	])}));
	assert.deepEqual(await pending, {"100": "第一条"});
});

test("validation refuses to spend a request on an obviously incomplete config", async () => {
	const noKey = createHarness();
	assert.deepEqual(await noKey.client.validateEngineConfig("openai"), {ok: false, normalized: false});
	assert.equal(noKey.calls.length, 0);
	assert.equal(noKey.toasts[0].message, "LABEL:openai: TEXT:validate_missing_key");

	// Engines with nothing to validate are rejected before any of that.
	const unsupported = createHarness();
	assert.deepEqual(await unsupported.client.validateEngineConfig("googleapi"), {ok: false, normalized: false});
	assert.equal(unsupported.toasts.length, 0, "an unsupported engine shows no toast");

	const placeholderEndpoint = createHarness({authKeys: {oaicompat: {key: "k", endpoint: translationEngines.oaicompat.endpoint, model: "m"}}});
	assert.equal((await placeholderEndpoint.client.validateEngineConfig("oaicompat")).ok, false);
	assert.equal(placeholderEndpoint.toasts[0].message, "LABEL:oaicompat: TEXT:validate_missing_endpoint");

	const placeholderModel = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: translationEngines.oaicompat.model}}});
	assert.equal((await placeholderModel.client.validateEngineConfig("oaicompat")).ok, false);
	assert.equal(placeholderModel.toasts[0].message, "LABEL:oaicompat: TEXT:validate_missing_model");
	assert.equal(placeholderModel.calls.length, 0);
});

test("invalid oaicompat endpoints are rejected without rewriting or sending credentials", async () => {
	for (const endpoint of ["http://public.example/v1", "https://compat.example/v1 /chat/completions"]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "provider-secret", endpoint, model: "m"}}});
		assert.equal(harness.client.isEngineConfiguredForRuntime("oaicompat"), false, endpoint);
		assert.deepEqual(await harness.client.validateEngineConfig("oaicompat"), {ok: false, normalized: false}, endpoint);
		assert.equal(harness.calls.length, 0, endpoint);
		assert.equal(harness.authKeys.oaicompat.endpoint, endpoint, "invalid input is not silently rewritten");
		assert.equal(harness.saves.length, 0);
	}
});

test("validation rewrites a malformed endpoint and persists the correction", async () => {
	const harness = createHarness({authKeys: {openai: {key: "k", endpoint: "https://proxy.test/v1", model: "m"}}});
	const pending = harness.client.validateEngineConfig("openai");

	assert.equal(harness.lastCall().url, "https://proxy.test/v1/responses");
	assert.equal(harness.authKeys.openai.endpoint, "https://proxy.test/v1/responses");
	assert.deepEqual(harness.saves[harness.saves.length - 1].openai.endpoint, "https://proxy.test/v1/responses");
	assert.equal(harness.normalizedNotices.length, 1, "the settings panel is told the value changed under it");

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "Guten Morgen"}));
	assert.deepEqual(await pending, {ok: true, normalized: true, durationMs: 0, httpStatus: 200, errorClass: null});
	assert.deepEqual(harness.latencyBegins, [{kind: "detect", messageCount: 1, inputChars: 12}]);
	assert.equal(harness.latencyEvents.length, 1);
	assert.equal(harness.latencyEvents[0].token.kind, "detect");
	assert.equal(harness.latencyEvents[0].engineKey, "openai");
	assert.equal(harness.latencyEvents[0].status, "ok");
	assert.match(harness.toasts[harness.toasts.length - 1].message, /TEXT:validate_saved_endpoint/);
	assert.match(harness.toasts[harness.toasts.length - 1].message, /\(Guten Morgen\)/, "the sample translation is previewed");

	// An already-correct endpoint is left alone and nothing is saved.
	const clean = createHarness({authKeys: {openai: {key: "k", endpoint: "https://api.openai.com/v1/responses", model: "m"}}});
	const cleanPending = clean.client.validateEngineConfig("openai");
	clean.respond(0, null, {statusCode: 200}, JSON.stringify({output_text: "Guten Morgen"}));
	assert.deepEqual(await cleanPending, {ok: true, normalized: false, durationMs: 0, httpStatus: 200, errorClass: null});
	assert.equal(clean.saves.length, 0);
});

test("each validated engine is probed with its own native generation call", async () => {
	const cases = [
		["googlecloud", {googlecloud: {key: "k-gc", model: "custom"}}, call => {
			assert.deepEqual(call.options.form, {key: "k-gc", q: "Good morning", source: "en", target: "de", format: "text", model: "custom"});
		}, JSON.stringify({data: {translations: [{translatedText: "Guten Morgen"}]}})],
		["microsoft", {microsoft: {key: "k-ms", region: "westus"}}, call => {
			assert.equal(call.options.headers["Ocp-Apim-Subscription-Region"], "westus");
			assert.deepEqual(call.options.form, {"api-version": "3.0", from: "en", to: "de"});
		}, JSON.stringify([{translations: [{text: "Guten Morgen"}]}])],
		["deepl", {deepl: {key: "k-deepl"}}, call => {
			assert.equal(call.url, "https://api-free.deepl.com/v2/translate");
			assert.deepEqual(JSON.parse(call.options.body), {text: ["Good morning"], source_lang: "EN", target_lang: "DE"});
		}, JSON.stringify({translations: [{text: "Guten Morgen"}]})],
		["gemini", {gemini: {key: "k-g", endpoint: "https://g.test/v1beta/models", model: "gemini-x"}}, call => {
			assert.equal(call.url, "https://g.test/v1beta/models/gemini-x:generateContent");
			assert.equal(call.options.headers["x-goog-api-key"], "k-g");
		}, JSON.stringify({candidates: [{content: {parts: [{text: "Guten Morgen"}]}}]})],
		["deepseek", {deepseek: {key: "k-ds", endpoint: "https://api.deepseek.com/chat/completions", model: "ds-x"}}, call => {
			const body = JSON.parse(call.options.body);
			assert.equal(body.temperature, 0);
			// A cap, not a charge: you pay for what the model generates, so headroom is
			// only spent when the model actually reasons. 32 was tight enough that a
			// reasoning model never reached its answer and validation reported failure.
			assert.ok(body.max_tokens >= 256 && body.max_tokens <= 1024, `validation probe budget out of range: ${body.max_tokens}`);
		}, JSON.stringify({choices: [{message: {content: " Guten Morgen "}}]})]
	];
	for (const [engineKey, authKeys, checkCall, body] of cases) {
		const harness = createHarness({authKeys});
		const pending = harness.client.validateEngineConfig(engineKey);
		checkCall(harness.lastCall());
		harness.respond(0, null, {statusCode: 200}, body);
		assert.deepEqual(await pending, {ok: true, normalized: false, durationMs: 0, httpStatus: 200, errorClass: null}, engineKey);
		assert.match(harness.toasts[harness.toasts.length - 1].message, /\(Guten Morgen\)/, engineKey);
		assert.equal(harness.toasts[0].closed, true, "the running toast is closed when the probe settles");
	}
});

test("a validation failure names the status and the provider's reason", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const pending = harness.client.validateEngineConfig("openai");
	harness.respond(0, null, {statusCode: 401}, JSON.stringify({error: {message: "bad key"}}));

	assert.deepEqual(await pending, {ok: false, normalized: false, durationMs: 0, httpStatus: 401, errorClass: "auth"});
	assert.equal(harness.toasts[harness.toasts.length - 1].message, "LABEL:openai: TEXT:validate_failed (401) - bad key");

	// A 200 carrying no translation is still a failure.
	const empty = createHarness({authKeys: AI_AUTH});
	const emptyPending = empty.client.validateEngineConfig("deepseek");
	empty.respond(0, null, {statusCode: 200}, JSON.stringify({choices: []}));
	assert.equal((await emptyPending).ok, false);
});

test("the model catalog reads each provider's listing schema", async () => {
	const gemini = createHarness({authKeys: {gemini: {key: "k-g", endpoint: "https://g.test/v1beta/models"}}});
	const geminiPending = gemini.client.fetchModelCatalog("gemini");
	assert.equal(gemini.lastCall().url, "https://g.test/v1beta/models");
	assert.equal(gemini.lastCall().options.headers["x-goog-api-key"], "k-g");
	assert.equal(gemini.client.getModelCatalogState().gemini.endpoint, "https://g.test/v1beta/models", "catalog state stores no credential-bearing URL");
	gemini.respond(0, null, {statusCode: 200}, JSON.stringify({models: [
		{name: "models/zeta", supportedGenerationMethods: ["generateContent"]},
		{name: "models/alpha", supportedGenerationMethods: ["generateContent"]},
		{name: "models/embedder", supportedGenerationMethods: ["embedContent"]}
	]}));
	// Sorted, prefix-stripped, and filtered to models that can actually generate.
	assert.deepEqual(await geminiPending, {ok: true, items: ["alpha", "zeta"]});
	assert.equal(gemini.client.getModelCatalogState().gemini.endpoint, "https://g.test/v1beta/models");
	assert.deepEqual(gemini.modelCatalogSaves.at(-1).gemini.items, ["alpha", "zeta"]);

	const openai = createHarness({authKeys: AI_AUTH});
	const openaiPending = openai.client.fetchModelCatalog("openai");
	assert.equal(openai.lastCall().url, "https://api.openai.com/v1/models");
	assert.equal(openai.lastCall().options.headers.Authorization, "Bearer k-openai");
	assert.equal(openai.lastCall().options.method, "get");
	openai.respond(0, null, {statusCode: 200}, JSON.stringify({data: [{id: "gpt-b"}, {id: "gpt-a"}, {id: ""}, {}]}));
	assert.deepEqual(await openaiPending, {ok: true, items: ["gpt-a", "gpt-b"]});
	assert.deepEqual(openai.modelCatalogSaves.at(-1).openai.items, ["gpt-a", "gpt-b"]);
});

test("catalog state tracks loading and results for the settings panel", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const updates = [];
	const pending = harness.client.fetchModelCatalog("openai", () => updates.push(JSON.parse(JSON.stringify(harness.client.getModelCatalogState()))));

	assert.equal(updates[0].openai.loading, true);
	assert.equal(updates[0].openai.endpoint, "https://api.openai.com/v1/models");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({data: [{id: "gpt-a"}]}));
	await pending;

	const state = harness.client.getModelCatalogState();
	assert.equal(state.openai.loading, false);
	assert.deepEqual(state.openai.items, ["gpt-a"]);
	assert.equal(state.openai.fetchedAt, 1000, "the fetch time comes from the injected clock");

	harness.client.clearModelCatalogState();
	assert.deepEqual(harness.client.getModelCatalogState(), {});
});

test("a hung model catalog request releases loading and ignores a late result", async () => {
	const harness = createHarness({authKeys: AI_AUTH});
	const updates = [];
	const pending = harness.client.fetchModelCatalog("openai", () => updates.push(JSON.parse(JSON.stringify(harness.client.getModelCatalogState()))));

	assert.equal(harness.client.getModelCatalogState().openai.loading, true);
	assert.equal(harness.timers[0].delay, PROVIDER_REQUEST_TIMEOUT_MS);
	harness.fireTimer(0);
	assert.deepEqual(await pending, {ok: false, items: []});
	assert.equal(harness.client.getModelCatalogState().openai.loading, false);
	assert.deepEqual(harness.client.getModelCatalogState().openai.items, []);
	const updateCount = updates.length;
	const toastCount = harness.toasts.length;

	harness.respond(0, null, {statusCode: 200}, JSON.stringify({data: [{id: "late-model"}]}));
	assert.equal(updates.length, updateCount, "the late callback cannot mutate settings state");
	assert.equal(harness.toasts.length, toastCount, "the late callback cannot emit a second result toast");
	assert.deepEqual(harness.client.getModelCatalogState().openai.items, []);
});

test("an empty or failed catalog clears the list instead of keeping a stale one", async () => {
	const empty = createHarness({authKeys: AI_AUTH});
	const emptyPending = empty.client.fetchModelCatalog("openai");
	empty.respond(0, null, {statusCode: 200}, JSON.stringify({data: []}));
	assert.deepEqual(await emptyPending, {ok: true, items: []});
	assert.equal(empty.toasts[0].options.type, "warning");

	const failed = createHarness({authKeys: AI_AUTH});
	const failedPending = failed.client.fetchModelCatalog("openai");
	failed.respond(0, null, {statusCode: 403}, JSON.stringify({error: {message: "no access"}}));
	assert.deepEqual(await failedPending, {ok: false, items: []});
	assert.deepEqual(failed.client.getModelCatalogState().openai.items, []);
	assert.equal(failed.client.getModelCatalogState().openai.loading, false);
	assert.equal(failed.toasts[0].message, "LABEL:openai: TEXT:validate_failed (403) - no access");
});

test("the catalog is refused for engines that cannot list models or lack credentials", async () => {
	const unsupported = createHarness({authKeys: AI_AUTH});
	assert.deepEqual(await unsupported.client.fetchModelCatalog("microsoft"), {ok: false, items: []});
	assert.equal(unsupported.calls.length, 0);
	assert.equal(unsupported.toasts.length, 0);

	const noKey = createHarness();
	assert.deepEqual(await noKey.client.fetchModelCatalog("openai"), {ok: false, items: []});
	assert.equal(noKey.toasts[0].message, "LABEL:openai: TEXT:validate_missing_key");

	const placeholder = createHarness({authKeys: {oaicompat: {key: "k", endpoint: translationEngines.oaicompat.endpoint}}});
	assert.deepEqual(await placeholder.client.fetchModelCatalog("oaicompat"), {ok: false, items: []});
	assert.equal(placeholder.toasts[0].message, "LABEL:oaicompat: TEXT:validate_missing_endpoint");
	assert.equal(placeholder.calls.length, 0);
});

test("every adapter settles with an empty translation when the network fails outright", async () => {
	// A DNS failure or socket reset calls back with error set and response null.
	// Dereferencing response.statusCode there throws inside the callback, so the
	// translation never settles and the caller waits out its whole timeout.
	const client = createProviderClient({
		request: (_url, _options, callback) => callback(new Error("ENOTFOUND"), null, null),
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: timer => clearTimeout(timer),
		now: () => Date.now(),
		getAuthKeys: () => ({
			googlecloud: {key: "k"}, microsoft: {key: "k"}, deepl: {key: "k", paid: false},
			papago: {key: "k", secret: "s"}, baidu: {key: "k", secret: "s"},
			deepseek: {key: "k"}, openai: {key: "k"}, gemini: {key: "k"}, oaicompat: {key: "k", endpoint: "https://e.test/v1/chat/completions", model: "m"}
		}),
		saveAuthKeys: () => {},
		getLanguages: () => ({en: {id: "en", name: "English"}, "zh-CN": {id: "zh-CN", name: "Chinese"}}),
		notify: () => null,
		getLabels: () => ({toast_translating_failed: "failed", toast_translating_tryanother: "try another", error_hourlylimit: "hourly", error_dailylimit: "daily", error_keyoutdated: "outdated"}),
		getCustomText: key => key,
		getEngineLabel: key => key,
		shouldUseAiAutoTranslateDecision: () => false,
		getAiAutoTranslatePrompt: () => "rules"
	});
	const data = {
		engine: translationEngines.googleapi,
		input: {id: "en", name: "English"},
		output: {id: "zh-CN", name: "Chinese"},
		text: "hello",
		autoDecision: false
	};

	const adapters = ["googleApiTranslate", "microsoftTranslate", "deepLTranslate", "papagoTranslate", "baiduTranslate", "googleCloudTranslate"];
	for (const adapter of adapters) {
		if (typeof client[adapter] != "function") continue;
		const settled = await new Promise(resolve => {
			const timer = setTimeout(() => resolve("NEVER SETTLED"), 500);
			try {
				client[adapter](Object.assign({}, data, {engine: translationEngines[adapter.replace(/Translate$/, "").toLowerCase()] || translationEngines.googleapi}), value => {
					clearTimeout(timer);
					resolve(value);
				});
			}
			catch (error) {
				clearTimeout(timer);
				resolve("THREW: " + error.message);
			}
		});
		assert.equal(settled, "", `${adapter} must settle with an empty translation on a network failure, got ${JSON.stringify(settled)}`);
	}
});

test("validation accepts a reasoning model that spent its budget before answering", async () => {
	// The 检测模型 button caps max_tokens so the check stays cheap. A reasoning model
	// fills reasoning_content first, so a small cap returns HTTP 200 with an empty
	// message.content - which read as "验证失败 (200)" even though the key, endpoint
	// and model were all provably fine. What this button is asked to prove is that the
	// provider accepted the request, and a truncated answer proves exactly that.
	const truncated = createHarness({authKeys: {deepseek: {key: "k", model: "deepseek-reasoner"}}});
	const pending = truncated.client.validateEngineConfig("deepseek");
	const sent = JSON.parse(truncated.calls[0].options.body);
	assert.ok(sent.max_tokens >= 256, `max_tokens ${sent.max_tokens} leaves no room for reasoning`);
	truncated.respond(0, null, {statusCode: 200}, JSON.stringify({
		choices: [{message: {role: "assistant", content: "", reasoning_content: "Let me think about the German."}, finish_reason: "length"}]
	}));
	assert.equal((await pending).ok, true);

	// A 200 carrying no choice at all is still a failure - nothing was proven.
	const empty = createHarness({authKeys: {deepseek: {key: "k", model: "deepseek-chat"}}});
	const emptyPending = empty.client.validateEngineConfig("deepseek");
	empty.respond(0, null, {statusCode: 200}, JSON.stringify({choices: []}));
	assert.equal((await emptyPending).ok, false);

	// The ordinary case still reports the translation it got back.
	const normal = createHarness({authKeys: {deepseek: {key: "k", model: "deepseek-chat"}}});
	const normalPending = normal.client.validateEngineConfig("deepseek");
	normal.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}, finish_reason: "stop"}]}));
	assert.equal((await normalPending).ok, true);
	assert.match(normal.toasts[normal.toasts.length - 1].message, /Hallo/);
});

test("deepseek requests ask for the non-thinking mode, other engines are untouched", () => {
	const byteSnapshot = createHarness({authKeys: {deepseek: {key: "k-deepseek", endpoint: "https://api.deepseek.com/chat/completions", model: "ds-x"}}});
	byteSnapshot.client.translate("deepseek", translationData(), () => {});
	assert.equal(byteSnapshot.calls[0].url, "https://api.deepseek.com/chat/completions");
	assert.equal(JSON.stringify(byteSnapshot.calls[0].options.headers), '{"Content-Type":"application/json","Authorization":"Bearer k-deepseek"}');
	assert.equal(crypto.createHash("sha256").update(byteSnapshot.calls[0].options.body).digest("hex").toUpperCase(), "5FE1497464F388364CEA7B8C8602EDCBAD7001FF233D64FCA6C5CB36C4AE283D", "shared Chat extraction must not change official DeepSeek request bytes");

	// DeepSeek v4 thinks by default. Every thinking token is billed as output and waited
	// on before the answer starts, and translation gains nothing from a chain of thought.
	// The flag is deepseek-only: "oaicompat" points at arbitrary OpenAI-compatible servers
	// and some reject a request carrying an unknown top-level field.
	const single = createHarness({authKeys: {deepseek: {key: "k", model: "deepseek-v4-flash"}}});
	single.client.translate("deepseek", translationData(), () => {});
	assert.deepEqual(JSON.parse(single.calls[0].options.body).thinking, {type: "disabled"});

	const batch = createHarness({authKeys: {deepseek: {key: "k", model: "deepseek-v4-flash"}}});
	batch.client.requestAiBatchTranslation("deepseek", preparedItems());
	assert.deepEqual(JSON.parse(batch.calls[0].options.body).thinking, {type: "disabled"});

	const probe = createHarness({authKeys: {deepseek: {key: "k", model: "deepseek-v4-flash"}}});
	probe.client.validateEngineConfig("deepseek");
	assert.deepEqual(JSON.parse(probe.calls[0].options.body).thinking, {type: "disabled"});

	// A generic OpenAI-compatible endpoint must not receive the DeepSeek-specific field.
	const compat = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m"}}});
	compat.client.translate("oaicompat", translationData(), () => {});
	assert.equal(JSON.parse(compat.calls[0].options.body).thinking, undefined);
});

test("custom reasoning control sends explicit intent immediately while validation only records evidence", async () => {
	const auto = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x"}}});
	auto.client.translate("oaicompat", translationData(), () => {});
	assert.equal(auto.lastBody().reasoning_effort, undefined);
	assert.equal(auto.client.getReasoningControlStatus("oaicompat").support, "provider_default");

	const pending = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "deepseek-r1", reasoningMode: "off", reasoningProfile: "deepseek"}}});
	pending.client.translate("oaicompat", translationData(), () => {});
	assert.deepEqual(pending.lastBody().thinking, {type: "disabled"}, "pending production still sends the explicit close field");
	assert.equal(pending.client.getReasoningControlStatus("oaicompat").support, "pending");

	const probe = pending.client.validateEngineConfig("oaicompat");
	assert.deepEqual(pending.lastBody().thinking, {type: "disabled"});
	pending.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}, finish_reason: "stop"}]}));
	assert.equal((await probe).ok, true);
	assert.equal(pending.client.getReasoningControlStatus("oaicompat").support, "accepted");
	pending.client.translate("oaicompat", translationData(), () => {});
	assert.deepEqual(pending.lastBody().thinking, {type: "disabled"}, "confirmed production uses the same single profile field");
});

test("pending on and off ride both single and batch requests while follow stays field-free", () => {
	for (const [mode, raw, expected] of [["on", "xhigh", "xhigh"], ["off", "low", "none"]]) {
		const authKeys = {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode, profile: "openai", effort: raw, onRaw: raw, rawExplicit: true}}}};
		const single = createHarness({authKeys});
		assert.equal(single.client.getReasoningControlStatus("oaicompat").support, "pending");
		single.client.translate("oaicompat", translationData(), () => {});
		assert.equal(single.lastBody().reasoning_effort, expected, `${mode} single`);

		const batch = createHarness({authKeys});
		batch.client.requestAiBatchTranslation("oaicompat", preparedItems());
		assert.equal(batch.lastBody().reasoning_effort, expected, `${mode} batch`);
	}
	const followAuth = {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode: "follow", profile: "openai", effort: "high"}}}};
	const followSingle = createHarness({authKeys: followAuth});
	followSingle.client.translate("oaicompat", translationData(), () => {});
	assert.equal(followSingle.lastBody().reasoning_effort, undefined);
	const followBatch = createHarness({authKeys: followAuth});
	followBatch.client.requestAiBatchTranslation("oaicompat", preparedItems());
	assert.equal(followBatch.lastBody().reasoning_effort, undefined);
});

test("both 5.6 model aliases keep every advertised raw across validation single and batch", async () => {
	for (const model of ["gpt-5.6-sol", "gpt-5.6-luna"]) for (const raw of ["low", "medium", "high", "xhigh", "max"]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model, reasoningModels: {[model]: {mode: "on", profile: "openai", effort: raw, onRaw: raw, rawExplicit: true}}}}});
		const validation = harness.client.validateEngineConfig("oaicompat");
		assert.equal(harness.lastBody().reasoning_effort, raw, `${model}/${raw} validation`);
		harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}], usage: {completion_tokens_details: {reasoning_tokens: 3}}}));
		assert.equal((await validation).ok, true);

		let translated = null;
		harness.client.translate("oaicompat", translationData(), value => {translated = value;});
		assert.equal(harness.lastBody().reasoning_effort, raw, `${model}/${raw} single`);
		harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
		assert.equal(translated, "译文");

		const batch = harness.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems());
		assert.equal(harness.lastBody().reasoning_effort, raw, `${model}/${raw} batch`);
		harness.respond(2, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: '[{"id":"100","translation":"一"},{"id":"200","translation":"二"}]'}}]}));
		assert.deepEqual((await batch).translations, {"100": "一", "200": "二"});
	}
});

test("per-model preferences restore explicit on and follow modes without sharing capability", async () => {
	const harness = createHarness({authKeys: {oaicompat: {
		key: "k",
		endpoint: "https://host.test/v1/chat/completions",
		model: "Model-A",
		reasoningMode: "off",
		reasoningProfile: "qwen",
		reasoningModels: {
			"Model-A": {mode: "on", profile: "openai", effort: "medium", capability: null, checkedAt: 1},
			"Model-B": {mode: "follow", profile: "auto", effort: "low", capability: null, checkedAt: 2}
		}
	}}});
	let status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.mode, "on");
	assert.equal(status.effort, "medium");
	assert.equal(status.support, "pending");
	const validation = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().reasoning_effort, "medium");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}], usage: {completion_tokens_details: {reasoning_tokens: 8}}}));
	assert.equal((await validation).ok, true);
	status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.support, "accepted");
	assert.equal(status.candidateId, "openai_on_medium");
	assert.equal(status.resolvedValue, "medium");
	assert.equal(status.evidence, "confirmed");
	assert.equal(harness.authKeys.oaicompat.reasoningModels["Model-A"].capability.resolvedValue, "medium", "probe result persists on the selected model");
	harness.client.translate("oaicompat", translationData(), () => {});
	assert.equal(harness.lastBody().reasoning_effort, "medium");
	const reloaded = createHarness({authKeys: harness.authKeys});
	assert.equal(reloaded.client.getReasoningControlStatus("oaicompat").support, "accepted", "persisted capability warms a fresh client without another probe");
	reloaded.client.translate("oaicompat", translationData(), () => {});
	assert.equal(reloaded.lastBody().reasoning_effort, "medium");

	harness.authKeys.oaicompat.model = "Model-B";
	status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.mode, "follow");
	assert.equal(status.support, "provider_default");
	harness.client.translate("oaicompat", translationData(), () => {});
	assert.equal(harness.lastBody().reasoning_effort, undefined, "follow sends no control field");
});

test("explicit on mirrors DeepSeek and Qwen enable fields and only probes alternate Qwen shape", async () => {
	const deepseek = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "ds", reasoningModels: {ds: {mode: "on", profile: "deepseek", effort: "low"}}}}});
	const dsValidation = deepseek.client.validateEngineConfig("oaicompat");
	assert.deepEqual(deepseek.lastBody().thinking, {type: "enabled"});
	deepseek.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}]}));
	assert.equal((await dsValidation).ok, true);
	assert.equal(deepseek.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");

	const qwen = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "q", reasoningModels: {q: {mode: "on", profile: "qwen", effort: "low"}}}}});
	const qwenValidation = qwen.client.validateEngineConfig("oaicompat");
	assert.equal(qwen.lastBody().enable_thinking, true);
	qwen.respond(0, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter enable_thinking"}}));
	// T4: an explicit strength is asked once. The alternate spelling of the same request
	// exists, but it is reached by a re-validation the user asks for, not silently.
	assert.equal(qwen.calls.length, 1);
	assert.equal((await qwenValidation).ok, false);
	const qwenRewrite = qwen.client.validateEngineConfig("oaicompat", {rewrite: true});
	assert.deepEqual(qwen.lastBody().chat_template_kwargs, {enable_thinking: true});
	qwen.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}]}));
	assert.equal((await qwenRewrite).ok, true);
	assert.equal(qwen.client.getReasoningControlStatus("oaicompat").candidateId, "qwen_chat_template_on");
});

test("persisted model capability is reused only for its normalized endpoint and explicit mode", () => {
	const harness = createHarness({authKeys: {oaicompat: {
		key: "k", endpoint: "https://new.test/v1/chat/completions", model: "m",
		reasoningModels: {m: {mode: "on", profile: "openai", effort: "low", capability: {
			support: "accepted", candidateId: "openai_on_low", resolvedValue: "low", evidence: "confirmed", endpointKey: "https://old.test/v1/chat/completions", checkedAt: 1
		}}}
	}}});
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.mode, "on");
	assert.equal(status.support, "pending");
	assert.equal(status.resolvedValue, null);
	assert.equal(harness.authKeys.oaicompat.reasoningModels.m.mode, "on", "endpoint mismatch invalidates fact, not user intent");
});

test("production on-value rejection fails closed and records this exact model capability", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode: "on", profile: "openai", effort: "high"}}}}});
	const validation = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}]}));
	await validation;
	harness.client.translate("oaicompat", translationData(), () => {});
	assert.equal(harness.lastBody().reasoning_effort, "high");
	harness.respond(1, null, {statusCode: 400}, JSON.stringify({error: {message: "Invalid value high for reasoning_effort"}}));
	assert.equal(harness.calls.length, 2, "the rejected field is not stripped for an uncontrolled retry");
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
	assert.equal(harness.authKeys.oaicompat.reasoningModels.m.mode, "on");
	assert.equal(harness.authKeys.oaicompat.reasoningModels.m.capability.support, "unsupported");
});

test("custom validation probes DeepSeek Qwen and OpenAI profiles with truthful support states", async () => {
	for (const [profile, field, expectedValue, support, resolvedValue] of [
		["deepseek", "thinking", {type: "disabled"}, "accepted", "thinking.disabled"],
		["qwen", "enable_thinking", false, "accepted", "enable_thinking=false"],
		["openai", "reasoning_effort", "none", "accepted", "none"]
	]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "model-x", reasoningMode: "off", reasoningProfile: profile}}});
		const pending = harness.client.validateEngineConfig("oaicompat");
		const body = harness.lastBody();
		assert.deepEqual(body[field], expectedValue, profile);
		for (const other of ["thinking", "enable_thinking", "reasoning_effort"]) if (other !== field) assert.equal(body[other], undefined, `${profile} may not stack ${other}`);
		harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
		assert.equal((await pending).ok, true);
		const status = harness.client.getReasoningControlStatus("oaicompat");
		assert.equal(status.support, support);
		assert.equal(status.resolvedValue, resolvedValue);
		assert.equal(status.evidence, "none");
	}
});

test("OpenAI off probe never falls through none to a value that still thinks", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().reasoning_effort, "none");
	harness.respond(0, null, {statusCode: 400}, JSON.stringify({error: {message: "Invalid value: none for reasoning_effort; must be one of minimal, low, medium"}}));
	assert.equal((await pending).ok, false);
	assert.equal(harness.calls.length, 1);
	assert.deepEqual(harness.latencyEvents.map(event => event.role), ["primary"]);
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.support, "unsupported");
	assert.equal(status.candidateId, "openai_none");
	assert.equal(status.resolvedValue, "none");
});

test("OpenAI off rewrite re-sends none after its only equivalent schema is exhausted", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const first = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await first).ok, true);
	const pending = harness.client.validateEngineConfig("oaicompat", {rewrite: true});
	assert.equal(harness.calls.length, 2);
	assert.equal(harness.lastBody().reasoning_effort, "none");
	harness.respond(1, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: reasoning_effort"}}));
	assert.equal((await pending).ok, false);
	assert.equal(harness.calls.length, 2);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
});

test("Qwen probe may change field shape inside its profile without cross-profile probing", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "qwen-x", reasoningMode: "off", reasoningProfile: "qwen"}}});
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().enable_thinking, false);
	harness.respond(0, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: enable_thinking"}}));
	assert.deepEqual(harness.lastBody().chat_template_kwargs, {enable_thinking: false});
	assert.equal(harness.lastBody().reasoning_effort, undefined);
	assert.equal(harness.lastBody().thinking, undefined);
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
	assert.equal((await pending).ok, true);
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.candidateId, "qwen_chat_template");
	assert.equal(status.resolvedValue, "chat_template_kwargs.enable_thinking=false");
});

test("compatible zero stays unconfirmed while positive thinking contradicts close", async () => {
	for (const [responseBody, evidence] of [
		[{choices: [{message: {content: "Hallo"}}]}, "none"],
		[{choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}, "none"],
		[{choices: [{message: {content: "Hallo", reasoning_content: "still thinking"}}], usage: {completion_tokens_details: {reasoning_tokens: 12}}}, "contradicted"]
	]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
		const pending = harness.client.validateEngineConfig("oaicompat");
		harness.respond(0, null, {statusCode: 200}, JSON.stringify(responseBody));
		assert.equal((await pending).ok, true);
		assert.equal(harness.client.getReasoningControlStatus("oaicompat").evidence, evidence);
	}
	const official = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const pending = official.client.validateEngineConfig("oaicompat");
	official.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await pending).ok, true);
	assert.equal(official.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
});

test("reasoning usage takes the strongest reported shape without turning zero into a verdict", async () => {
	const zero = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "gpt-5.6-sol", reasoningModels: {"gpt-5.6-sol": {mode: "on", profile: "openai", effort: "low", onRaw: "low", rawExplicit: true}}}}});
	const zeroProbe = zero.client.validateEngineConfig("oaicompat");
	zero.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await zeroProbe).ok, true);
	assert.equal(zero.client.getLastReasoningProbeUsage("oaicompat"), 0, "the second line may still print the reported zero");
	assert.equal(zero.client.getReasoningControlStatus("oaicompat").evidence, "none");
	assert.deepEqual(zero.tierStates.map(entry => entry.state), ["sent"]);

	const mixed = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode: "on", profile: "openai", effort: "high", onRaw: "high", rawExplicit: true}}}}});
	const mixedProbe = mixed.client.validateEngineConfig("oaicompat");
	mixed.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}, output_tokens_details: {reasoning_tokens: 9}}}));
	assert.equal((await mixedProbe).ok, true);
	assert.equal(mixed.client.getLastReasoningProbeUsage("oaicompat"), 9, "a leading zero cannot hide a positive count in another standard shape");
	assert.equal(mixed.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
});

test("an exact unknown reasoning field is cached unsupported without a field-free retry", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const pending = harness.client.validateEngineConfig("oaicompat");
	const firstBody = harness.lastBody();
	assert.equal(firstBody.reasoning_effort, "none");
	harness.respond(0, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: reasoning_effort"}}));
	assert.equal(harness.calls.length, 1);
	assert.equal((await pending).ok, false);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
	assert.equal(harness.latencyEvents.length, 1);
	assert.equal(harness.latencyEvents[0].role, "primary");

	harness.client.translate("oaicompat", translationData(), () => {});
	assert.equal(harness.calls.length, 1, "later production also stops instead of using provider default");
});

test("ordinary provider errors never trigger reasoning fallback or poison capability state", async () => {
	for (const [statusCode, body] of [
		[400, JSON.stringify({error: {message: "Invalid model gpt-x"}})],
		[401, JSON.stringify({error: {message: "Unknown parameter reasoning_effort"}})],
		[404, JSON.stringify({error: {message: "Unknown parameter reasoning_effort"}})],
		[429, JSON.stringify({error: {message: "Unknown parameter reasoning_effort"}})],
		[500, JSON.stringify({error: {message: "Unknown parameter reasoning_effort"}})],
		[422, JSON.stringify({detail: "Invalid request format for message content"})]
	]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
		const pending = harness.client.validateEngineConfig("oaicompat");
		harness.respond(0, null, {statusCode}, body);
		assert.equal((await pending).ok, false, statusCode);
		assert.equal(harness.calls.length, 1, `HTTP ${statusCode} must not retry`);
		assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "pending", `HTTP ${statusCode} must not change capability`);
	}
});

test("production invalid-value rejection keeps the field and records unsupported", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const validation = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
	await validation;
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").resolvedValue, "none");
	let translated = null;
	harness.client.translate("oaicompat", translationData(), value => {translated = value;});
	const firstBody = harness.lastBody();
	assert.equal(firstBody.reasoning_effort, "none");
	harness.respond(1, null, {statusCode: 400}, JSON.stringify({error: {message: "Invalid value none for reasoning_effort; must be one of low, medium"}}));
	assert.equal(harness.calls.length, 2);
	assert.equal(translated, "");
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
	assert.equal(harness.calls.filter(call => Object.hasOwn(JSON.parse(call.options.body), "reasoning_effort")).length, 2, "probe and first production attempt are the only requests carrying one value");
});

test("reasoning capability fingerprints change with endpoint model and profile and can be invalidated", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const pending = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
	await pending;
	const accepted = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(accepted.support, "accepted");
	harness.authKeys.oaicompat.model = "gpt-y";
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "pending");
	harness.authKeys.oaicompat.model = "gpt-x";
	harness.authKeys.oaicompat.endpoint = "https://other.test/v1/chat/completions";
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "pending");
	harness.authKeys.oaicompat.endpoint = "https://host.test/v1/chat/completions";
	harness.authKeys.oaicompat.reasoningProfile = "deepseek";
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "accepted", "the per-model record outranks the legacy engine default");
	harness.client.setReasoningModelPreference("oaicompat", {profile: "deepseek"});
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "pending");
	harness.client.setReasoningModelPreference("oaicompat", {profile: "openai"});
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "pending", "changing back still requires a fresh probe");
	const reprobe = harness.client.validateEngineConfig("oaicompat");
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
	await reprobe;
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "accepted");
	assert.equal(harness.client.invalidateReasoningCapabilities("oaicompat"), 1);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "pending");
});

test("confirmed custom reasoning applies to batch requests as well as single requests", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "qwen-x", reasoningMode: "off", reasoningProfile: "qwen"}}});
	const probe = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
	await probe;
	const batch = harness.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems());
	assert.equal(harness.lastBody().enable_thinking, false);
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "[]"}}]}));
	assert.deepEqual((await batch).translations, {});
});

test("cache-free benchmark fixtures are frozen stable synthetic text", () => {
	assert.equal(SYNTHETIC_BENCHMARK_TEXTS.length, 6);
	assert.equal(Object.isFrozen(SYNTHETIC_BENCHMARK_TEXTS), true);
	assert.equal(crypto.createHash("sha256").update(JSON.stringify(SYNTHETIC_BENCHMARK_TEXTS)).digest("hex"), "e84574aee20bbfcb033661304b8e7e5a1951f3eed665569cedacd3d79d5d6c51");
	for (const text of SYNTHETIC_BENCHMARK_TEXTS) {
		assert.equal(typeof text, "string");
		assert.ok(text.length >= 20);
		assert.doesNotMatch(text, /\{\{|__DTA_|discord\.com\/channels|@everyone/i);
	}
});

async function confirmBenchmarkReasoning(harness) {
	const pending = harness.client.validateEngineConfig("oaicompat");
	harness.respond(harness.calls.length - 1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await pending).ok, true);
}

test("cache-free benchmark counterbalances six baseline and controlled production-shaped requests", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	await confirmBenchmarkReasoning(harness);
	const latencyEventsBefore = harness.latencyEvents.length;
	const progress = [];
	const pending = harness.client.runSyntheticBenchmark("oaicompat", {onProgress: value => progress.push(value)});
	const expectedArms = ["baseline", "controlled", "controlled", "baseline", "baseline", "controlled", "controlled", "baseline", "baseline", "controlled", "controlled", "baseline"];
	for (let index = 0; index < expectedArms.length; index++) {
		await nextTurn();
		const call = harness.calls[index + 1];
		assert.ok(call, `request ${index + 1} must be issued sequentially`);
		const body = JSON.parse(call.options.body);
		const fixture = SYNTHETIC_BENCHMARK_TEXTS[Math.floor(index / 2)];
		assert.match(body.messages[1].content, new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const controlled = expectedArms[index] === "controlled";
		assert.equal(body.reasoning_effort, controlled ? "none" : undefined, `request ${index + 1} arm`);
		harness.advance(controlled ? 500 + Math.floor(index / 2) * 100 : 1000 + Math.floor(index / 2) * 100);
		harness.respond(index + 1, null, {statusCode: 200}, JSON.stringify({
			choices: [{message: {content: "译文"}}],
			usage: {prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: {reasoning_tokens: controlled ? 0 : 2}}
		}));
	}
	const result = await pending;
	assert.equal(result.completed, 12);
	assert.equal(result.candidateId, "openai_none");
	assert.equal(result.resolvedValue, "none");
	assert.equal(result.evidence, "confirmed");
	assert.deepEqual(result.baseline, {successCount: 6, failureCount: 0, p50Ms: 1200, p95Ms: 1500, inputChars: SYNTHETIC_BENCHMARK_TEXTS.reduce((sum, text) => sum + text.length, 0), outputChars: 12, usageSampleCount: 6, reasoningSampleCount: 6, promptTokens: 60, completionTokens: 30, reasoningTokens: 12, approximateCompletionTokensPerSecond: 4});
	assert.deepEqual(result.controlled, {successCount: 6, failureCount: 0, p50Ms: 700, p95Ms: 1000, inputChars: SYNTHETIC_BENCHMARK_TEXTS.reduce((sum, text) => sum + text.length, 0), outputChars: 12, usageSampleCount: 6, reasoningSampleCount: 6, promptTokens: 60, completionTokens: 30, reasoningTokens: 0, approximateCompletionTokensPerSecond: 6.67});
	assert.equal(result.reason, null);
	assert.equal(harness.latencyEvents.length, latencyEventsBefore, "benchmark requests never enter the production latency ring");
	assert.equal(progress[progress.length - 1].completed, 12);
});

test("benchmark measures unconfirmed selections as sent, refuses follow mode, stops after two parse failures and suppresses failure toasts", async () => {
	// 2026-08-25 report: a relay that reports zero thinking tokens can never
	// confirm an off request, so demanding confirmation locked the test forever.
	// An unvalidated selection now measures, dispatching its real wire field.
	const pendingHarness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const pendingRun = pendingHarness.client.runSyntheticBenchmark("oaicompat");
	await nextTurn();
	assert.equal(pendingHarness.calls.length, 1, "an unvalidated off selection starts measuring");
	assert.equal(JSON.parse(pendingHarness.calls[0].options.body).reasoning_effort, undefined, "the baseline arm stays the provider default");
	pendingHarness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	await nextTurn();
	assert.equal(JSON.parse(pendingHarness.calls[1].options.body).reasoning_effort, "none", "the controlled arm dispatches the unconfirmed selection instead of a silent baseline copy");
	pendingHarness.client.cancelSyntheticBenchmark();
	pendingHarness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	assert.equal((await pendingRun).cancelled, true);
	const zeroHarness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const zeroProbe = zeroHarness.client.validateEngineConfig("oaicompat");
	zeroHarness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await zeroProbe).ok, true);
	assert.equal(zeroHarness.client.getReasoningControlStatus("oaicompat").support, "accepted");
	assert.equal(zeroHarness.client.getReasoningControlStatus("oaicompat").evidence, "none");
	const zeroRun = zeroHarness.client.runSyntheticBenchmark("oaicompat");
	await nextTurn();
	assert.equal(zeroHarness.calls.length, 2, "an accepted-but-unconfirmed zero measures instead of demanding confirmation");
	zeroHarness.client.cancelSyntheticBenchmark();
	zeroHarness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	assert.equal((await zeroRun).cancelled, true);
	const autoHarness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x"}}});
	assert.equal((await autoHarness.client.runSyntheticBenchmark("oaicompat")).reason, "reasoning_disabled");

	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	await confirmBenchmarkReasoning(harness);
	const toastCount = harness.toasts.length;
	const pending = harness.client.runSyntheticBenchmark("oaicompat");
	await nextTurn();
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "English echo"}}]}));
	await nextTurn();
	harness.respond(2, null, {statusCode: 200}, JSON.stringify({choices: []}));
	const result = await pending;
	assert.equal(result.completed, 2);
	assert.equal(result.reason, "provider_failed");
	assert.equal(harness.calls.length, 3, "probe plus exactly two failed benchmark calls");
	assert.equal(harness.toasts.length, toastCount, "silent benchmark failures add no provider toast");
});

test("benchmark accepts a confirmed on mode and compares provider default against its explicit effort", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode: "on", profile: "openai", effort: "low"}}}}});
	const validation = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}]}));
	await validation;
	const pending = harness.client.runSyntheticBenchmark("oaicompat");
	await nextTurn();
	assert.equal(harness.lastBody().reasoning_effort, undefined, "baseline stays provider default");
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	await nextTurn();
	assert.equal(harness.lastBody().reasoning_effort, "low", "controlled arm uses the detected on effort");
	harness.client.cancelSyntheticBenchmark();
	harness.respond(2, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	const result = await pending;
	assert.equal(result.mode, "on");
	assert.equal(result.effort, "low");
	assert.equal(result.cancelled, true);
});

test("benchmark cancellation and configuration changes reject late work before another request", async () => {
	const cancelledHarness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	await confirmBenchmarkReasoning(cancelledHarness);
	const cancelledPending = cancelledHarness.client.runSyntheticBenchmark("oaicompat");
	await nextTurn();
	cancelledHarness.client.cancelSyntheticBenchmark();
	cancelledHarness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	const cancelled = await cancelledPending;
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.completed, 0);
	assert.equal(cancelledHarness.calls.length, 2);

	const staleHarness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	await confirmBenchmarkReasoning(staleHarness);
	const stalePending = staleHarness.client.runSyntheticBenchmark("oaicompat");
	await nextTurn();
	staleHarness.authKeys.oaicompat.model = "gpt-y";
	staleHarness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "译文"}}]}));
	const stale = await stalePending;
	assert.equal(stale.reason, "stale");
	assert.equal(staleHarness.calls.length, 2);
});

test("identical failure toasts within the dedup window collapse to one", async () => {
	// 2026-08-19 report: a 26-message backfill is three chunks; a dead provider
	// (quota exhausted) failed all three and the user got three identical popups.
	// The same danger message repeats silently inside the window and speaks again
	// after it, and a different message is never suppressed.
	const harness = createHarness({authKeys: AI_AUTH});
	for (let chunk = 0; chunk < 3; chunk++) {
		const pending = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems());
		harness.respond(chunk, null, {statusCode: 401}, "bad credentials");
		await pending;
	}
	assert.equal(harness.toasts.length, 1, "three identical chunk failures speak once");
	assert.match(harness.toasts[0].message, /KEYOUTDATED/);

	harness.advance(11000);
	const later = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	harness.respond(3, null, {statusCode: 401}, "bad credentials");
	await later;
	assert.equal(harness.toasts.length, 2, "after the window the same failure speaks again");

	harness.client.googleApiTranslate(translationData(), () => {});
	harness.respond(4, null, {statusCode: 429}, "");
	assert.equal(harness.toasts.length, 3, "a different failure message inside the window is never suppressed");
	assert.match(harness.toasts.at(-1).message, /HOURLY$/);
});

const {splitTextIntoTranslationChunks, FREE_ENGINE_CHUNK_LIMIT} = require("../src/providers/provider-client");

test("splitTextIntoTranslationChunks is lossless and bounded", () => {
	// Field 2026-08-19: long messages failed on the free engine because the whole
	// text traveled in one request URL. Chunks must concatenate back exactly and
	// each stay within the limit.
	const shortText = "short message";
	assert.deepEqual(splitTextIntoTranslationChunks(shortText, 100), [shortText]);

	const paragraphs = Array.from({length: 30}, (_, index) => `Paragraph ${index} with some words in it.`).join("\n\n");
	const chunks = splitTextIntoTranslationChunks(paragraphs, 200);
	assert.ok(chunks.length > 1, "a long text splits");
	assert.ok(chunks.every(chunk => chunk.length <= 200), "every chunk respects the limit");
	assert.equal(chunks.join(""), paragraphs, "concatenation reproduces the exact input");

	const sentenceSpaces = "First sentence. Second sentence! Third one? Fourth.";
	assert.equal(splitTextIntoTranslationChunks(sentenceSpaces, 20).join(""), sentenceSpaces, "sentence-boundary splits keep the whitespace");

	const oneGiantWord = "x".repeat(5000);
	const hardChunks = splitTextIntoTranslationChunks(oneGiantWord, FREE_ENGINE_CHUNK_LIMIT);
	assert.ok(hardChunks.every(chunk => chunk.length <= FREE_ENGINE_CHUNK_LIMIT));
	assert.equal(hardChunks.join(""), oneGiantWord);

	const nearBoundaryPlaceholder = `${"x".repeat(55)}__DTA_123__${"y".repeat(40)}`;
	const placeholderChunks = splitTextIntoTranslationChunks(nearBoundaryPlaceholder, 60);
	assert.equal(placeholderChunks.join(""), nearBoundaryPlaceholder);
	assert.ok(placeholderChunks.some(chunk => chunk.includes("__DTA_123__")), "a hard cut never slices a transport placeholder in half");
	assert.ok(placeholderChunks.every(chunk => !/__DTA_\d*$|^\d+__/.test(chunk)), "no chunk carries a placeholder fragment");
});

test("T2 a capability stored before wire identities is reused without a probe and without going pending", async () => {
	const legacyCapability = {support: "accepted", candidateId: "openai_none", resolvedValue: "none", evidence: "confirmed", endpointKey: "https://relay.test/v1/chat/completions", format: "openai_chat", checkedAt: 5};
	const authKeys = {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "m", reasoningModels: {m: {mode: "off", profile: "auto", effort: "low", capability: legacyCapability}}}};
	const harness = createHarness({authKeys});
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.support, "accepted", "an upgrade must not reset a confirmed capability to pending");
	assert.equal(status.evidence, "confirmed");
	assert.equal(status.resolvedValue, "none");
	assert.equal(harness.calls.length, 0, "read-through costs nothing: zero requests during the upgrade");
	assert.equal(status.schemaId, "openai_chat/reasoning_effort/v1", "the resolved wire identity is reported");
	// the migrated entry now lives under the new nine-segment key
	assert.equal(harness.client.getReasoningCapabilityCacheSize(), 1);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "accepted", "a second read hits the new key");
	assert.equal(harness.calls.length, 0);
});

test("T2 fingerprints separate wire identities and typed raw values", () => {
	const base = {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "m"};
	const chat = createHarness({authKeys: {oaicompat: Object.assign({}, base, {reasoningModels: {m: {mode: "on", profile: "openai", effort: "low"}}})}});
	const chatFingerprint = chat.client.getEngineConfigFingerprint("oaicompat");
	const chatBenchmark = chat.client.getBenchmarkFingerprint("oaicompat");
	assert.equal(chatFingerprint.includes("openai_chat/reasoning_effort/v1"), true, "the config fingerprint carries the wire identity");
	assert.equal(chatBenchmark.includes("openai_chat/reasoning_effort/v1"), true, "so does the benchmark fingerprint");

	const gemini = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-3.5-flash", reasoningModels: {"gemini-3.5-flash": {mode: "on", profile: "auto", effort: "low"}}}}});
	assert.notEqual(gemini.client.getEngineConfigFingerprint("oaicompat"), chatFingerprint);
	assert.notEqual(gemini.client.getBenchmarkFingerprint("oaicompat"), chatBenchmark, "a different wire schema is a different benchmark subject");

	// an exact budget the user typed is an explicit raw; a legacy record is read as the
	// value the old build sent for it and therefore has no separate identity to prove
	const budget = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-2.5-flash", reasoningModels: {"gemini-2.5-flash": {mode: "on", profile: "auto", effort: "low", onRaw: 12000, rawExplicit: true}}}}});
	const spelled = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-2.5-flash", reasoningModels: {"gemini-2.5-flash": {mode: "on", profile: "auto", effort: "low", onRaw: "12000", rawExplicit: true}}}}});
	assert.notEqual(budget.client.getEngineConfigFingerprint("oaicompat"), spelled.client.getEngineConfigFingerprint("oaicompat"), "a numeric budget and its spelling are different configurations");
});

// --- T3: adapter-declared availability decides before any request is made ---

// rawExplicit marks a raw this build wrote on purpose, which is what separates "the
// user chose a value the model rejects" from "a legacy record has to be read the way
// the old build sent it".
const T3_CLAUDE_AUTH = () => ({oaicompat: {key: "k", endpoint: "https://relay.test/v1/messages", model: "claude-opus-5", reasoningModels: {"claude-opus-5": {mode: "on", profile: "auto", effort: "minimal", onRaw: "minimal", rawExplicit: true}}}});

test("an unsupported model raw is visible but never silently rewritten or dispatched", async () => {
	const harness = createHarness({authKeys: T3_CLAUDE_AUTH()});
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.availability, "unsupported", "a locally known rejection is not an untested probe");
	assert.equal(status.onRaw, "minimal", "the stored raw stays exactly as the user saved it");
	assert.equal(status.support, "pending", "an availability verdict is never written as evidence");

	const validation = await harness.client.validateEngineConfig("oaicompat");
	assert.equal(validation.ok, false);
	assert.equal(harness.calls.length, 0, "zero network and zero billing for a known-illegal raw");

	const results = [];
	harness.client.translate("oaicompat", translationData(), value => results.push(value));
	assert.equal(harness.calls.length, 0, "the runtime refuses before HTTP as well");
	assert.deepEqual(results, [""], "the caller is told it failed instead of getting a downgraded translation");
	assert.equal(harness.saves.length, 0, "no silent rewrite of the stored preference");
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").onRaw, "minimal");
});

test("explicit low selection writes and sends exact low once", async () => {
	const harness = createHarness({authKeys: T3_CLAUDE_AUTH()});
	const next = harness.client.setReasoningModelPreference("oaicompat", {mode: "on", effort: "low"});
	assert.equal(next.availability, "supported", "choosing an available raw releases the block at once");
	assert.equal(next.support, "pending");
	const stored = harness.authKeys.oaicompat.reasoningModels["claude-opus-5"];
	assert.equal(stored.onRaw, "low", "the exact raw is what got written");
	assert.equal(stored.effort, "low");

	const validation = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.calls.length, 1, "exactly one request");
	const body = harness.lastBody();
	assert.equal(body.output_config.effort, "low", "the wire carries exactly low");
	assert.equal(body.thinking.type, "adaptive");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({content: [{type: "text", text: "Hallo"}], usage: {input_tokens: 1, output_tokens: 1}}));
	assert.equal((await validation).ok, true);
	assert.equal(harness.calls.length, 1, "no second dispatch of the same raw");
});

test("status, title and diagnostics never claim a raw that was not dispatched", async () => {
	const harness = createHarness({authKeys: T3_CLAUDE_AUTH()});
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.resolvedValue, null, "nothing was accepted because nothing was sent");
	assert.equal(status.evidence, "none");
	assert.equal(status.effort, "minimal", "the read path does not fold the stored raw");
	// a raw outside the legacy four is reported as itself, so the label matches the wire
	const gateway = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "gw-x", reasoningModels: {"gw-x": {mode: "on", profile: "openai", effort: "xhigh", onRaw: "xhigh", rawExplicit: true}}}}});
	const gatewayStatus = gateway.client.getReasoningControlStatus("oaicompat");
	assert.equal(gatewayStatus.effort, "xhigh", "an unlisted raw is never reported as low");
	assert.equal(gatewayStatus.availability, "supported", "unlisted is not the same as officially rejected");
	gateway.client.validateEngineConfig("oaicompat");
	assert.equal(gateway.lastBody().reasoning_effort, "xhigh", "what the status shows is what the wire carries");
	const diagnostics = JSON.stringify({key: status.capabilityKey, schema: status.schemaId, resolved: status.resolvedValue, effort: status.effort, onRaw: status.onRaw, availability: status.availability});
	assert.equal(/(^|[^a-z])low([^a-z]|$)/.test(diagnostics), false, "no diagnostic surface claims the value we refused to fold to");
	assert.equal(harness.calls.length, 0);
});

const T3_LEGACY = (endpoint, model, effort) => ({oaicompat: {key: "k", endpoint, model, reasoningModels: {[model]: {mode: "on", profile: "auto", effort}}}});

test("T3 a legacy record keeps dispatching what the old build sent after the upgrade", async () => {
	// generic Ollama only understands the boolean, so the old build sent think:true for
	// a stored "low". The upgrade must read it that way instead of inventing a tier.
	const ollama = createHarness({authKeys: T3_LEGACY("http://localhost:11434/api/chat", "qwen3:8b", "low")});
	const ollamaStatus = ollama.client.getReasoningControlStatus("oaicompat");
	assert.equal(ollamaStatus.availability, "supported", "an upgrade never blocks a configuration that worked");
	assert.equal(ollamaStatus.onRaw, true, "the label now names the value that is actually sent");
	ollama.client.validateEngineConfig("oaicompat");
	assert.equal(ollama.lastBody().think, true);

	// Gemini 2.5 has no level field, so a stored word meant the dynamic budget
	const gemini = createHarness({authKeys: T3_LEGACY("https://relay.test/v1beta/models", "gemini-2.5-flash", "high")});
	assert.equal(gemini.client.getReasoningControlStatus("oaicompat").onRaw, -1);
	gemini.client.validateEngineConfig("oaicompat");
	assert.equal(gemini.lastBody().generationConfig.thinkingConfig.thinkingBudget, -1);

	// Gemini Pro rejects minimal, and the old build quietly sent low for it: same wire
	const pro = createHarness({authKeys: T3_LEGACY("https://relay.test/v1beta/models", "gemini-3-pro-preview", "minimal")});
	assert.equal(pro.client.getReasoningControlStatus("oaicompat").availability, "supported");
	pro.client.validateEngineConfig("oaicompat");
	assert.equal(pro.lastBody().generationConfig.thinkingConfig.thinkingLevel, "low");

	// but an explicit choice of the same rejected value is still refused, not rewritten
	const explicit = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-3-pro-preview", reasoningModels: {"gemini-3-pro-preview": {mode: "on", profile: "auto", effort: "minimal", onRaw: "minimal", rawExplicit: true}}}}});
	assert.equal(explicit.client.getReasoningControlStatus("oaicompat").availability, "unsupported");
	assert.equal(explicit.calls.length, 0);
});

test("T3 a legacy OpenAI minimal record is probed as minimal instead of folded or locally blocked", async () => {
	const model = "gpt-5.6-sol";
	const harness = createHarness({authKeys: T3_LEGACY("https://relay.test/v1/chat/completions", model, "minimal")});
	const status = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(status.onRaw, "minimal", "the saved raw is not silently changed to low");
	assert.equal(status.availability, "supported", "a compatible relay gets the deciding vote");
	assert.equal(status.legacyRawProbe, true);
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.calls.length, 1, "validation reaches the relay instead of stopping locally");
	assert.equal(harness.lastBody().reasoning_effort, "minimal");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}], usage: {completion_tokens_details: {reasoning_tokens: 5}}}));
	assert.equal((await pending).ok, true);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
});

test("T3 mode on never dispatches a value that turns thinking off", async () => {
	for (const [endpoint, model, raw] of [
		["https://relay.test/v1/chat/completions", "gw-x", "none"],
		["https://relay.test/v1/chat/completions", "gw-x", false],
		["http://localhost:11434/api/chat", "qwen3:8b", false],
		["https://relay.test/v1beta/models", "gemini-2.5-flash", 0],
		["https://relay.test/v1/messages", "claude-opus-5", "disabled"]
	]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint, model, reasoningModels: {[model]: {mode: "on", profile: "auto", effort: "low", onRaw: raw, rawExplicit: true}}}}});
		const status = harness.client.getReasoningControlStatus("oaicompat");
		assert.equal(status.availability, "unsupported", `${String(raw)} closes thinking, so mode on cannot use it`);
		harness.client.validateEngineConfig("oaicompat");
		assert.equal(harness.calls.length, 0, `${String(raw)} must never be dispatched while the control says on`);
	}
	// closing thinking still sends exactly the value that closes it
	const off = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1/chat/completions", model: "gw-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	off.client.validateEngineConfig("oaicompat");
	assert.equal(off.lastBody().reasoning_effort, "none");
	assert.equal(off.client.getReasoningControlStatus("oaicompat").availability, "supported");
});

test("T3 the legacy effort mirror only ever holds one of the four legacy words", () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-2.5-flash", reasoningModels: {"gemini-2.5-flash": {mode: "on", profile: "auto", effort: "high", onRaw: "high", rawExplicit: true}}}}});
	const stored = () => harness.authKeys.oaicompat.reasoningModels["gemini-2.5-flash"];

	harness.client.setReasoningModelPreference("oaicompat", {mode: "on", effort: 12000});
	assert.equal(stored().onRaw, 12000, "the exact typed raw is the only truth");
	assert.equal(stored().effort, "high", "a custom raw never overwrites the legacy enum mirror");
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").onRaw, 12000);

	harness.client.setReasoningModelPreference("oaicompat", {mode: "on", effort: "medium"});
	assert.equal(stored().onRaw, "medium");
	assert.equal(stored().effort, "medium", "one of the four legacy words does mirror, so a rollback still reads it");
});

// --- T4: validation asks one honest question per mode, and failures recover on request ---

const T4_ON = (endpoint, model, raw) => ({oaicompat: {key: "k", endpoint, model, reasoningModels: {[model]: {mode: "on", profile: "auto", effort: typeof raw == "string" ? raw : "low", onRaw: raw, rawExplicit: true}}}});

test("T4 following the provider validates connectivity only and sends no thinking field", () => {
	for (const [endpoint, model, forbidden] of [
		["https://relay.test/v1/chat/completions", "gw-x", "reasoning_effort"],
		["https://relay.test/v1/responses", "gw-x", "reasoning"],
		["http://localhost:11434/api/chat", "qwen3:8b", "think"],
		["https://relay.test/v1beta/models", "gemini-2.5-flash", "thinkingConfig"],
		["https://relay.test/v1/messages", "claude-opus-5", "thinking"]
	]) {
		const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint, model, reasoningModels: {[model]: {mode: "follow", profile: "auto", effort: "low"}}}}});
		harness.client.validateEngineConfig("oaicompat");
		assert.equal(harness.calls.length, 1, endpoint + ": connectivity is a single request");
		assert.equal(JSON.stringify(harness.lastBody()).includes(forbidden), false, endpoint + " must not carry " + forbidden + " while following the provider");
		assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "provider_default");
	}
});

test("T4 closing thinking rejects a reduced-budget fallback", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-2.5-flash", reasoningModels: {"gemini-2.5-flash": {mode: "off", profile: "auto", effort: "low"}}}}});
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().generationConfig.thinkingConfig.thinkingBudget, 0, "the cheapest close is tried first");
	harness.respond(0, null, {statusCode: 400}, JSON.stringify({error: {status: "INVALID_ARGUMENT", message: "Invalid value 0 for thinkingBudget; must be at least 128"}}));
	assert.equal((await pending).ok, false);
	assert.equal(harness.calls.length, 1, "128 still thinks and is never tried as off");
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
});

test("T4 an explicit strength is validated once and never swapped for another schema", async () => {
	const harness = createHarness({authKeys: T4_ON("https://relay.test/v1/messages", "future-claude", "low")});
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.deepEqual(harness.lastBody().thinking, {type: "adaptive", display: "omitted"}, "the selected raw rides its current schema");
	harness.respond(0, null, {statusCode: 400}, JSON.stringify({error: {type: "invalid_request_error", message: "adaptive thinking is not supported on this model"}}));
	assert.equal(harness.calls.length, 1, "no second schema is tried without the user asking");
	assert.equal((await pending).ok, false);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported", "the refusal is recorded, not worked around");
});

test("T4 a rejected setting is never retried automatically", async () => {
	const harness = createHarness({authKeys: T4_ON("https://relay.test/v1/chat/completions", "gw-x", "high")});
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().reasoning_effort, "high");
	harness.respond(0, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: reasoning_effort"}}));
	assert.equal(harness.calls.length, 1, "an explicit strength is not silently validated without it");
	assert.equal((await pending).ok, false);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
	assert.deepEqual(harness.tierStates.map(entry => [entry.raw, entry.state]), [["high", "rejected"]]);
});

test("T4 a re-validation after an ignored setting rewrites the schema within the same budget", async () => {
	const harness = createHarness({authKeys: T4_ON("https://relay.test/v1/messages", "future-claude", "low")});
	const first = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({content: [{type: "text", text: "Hallo"}], usage: {input_tokens: 1, output_tokens: 1}}));
	assert.equal((await first).ok, true);
	const ignored = harness.client.getReasoningControlStatus("oaicompat");
	assert.equal(ignored.support, "accepted");
	assert.equal(ignored.evidence, "contradicted", "the setting was accepted but nothing was thought");
	assert.deepEqual(harness.tierStates.map(entry => entry.state), ["ignored"]);

	const benchmarkBefore = harness.client.getBenchmarkFingerprint("oaicompat");
	const again = harness.client.validateEngineConfig("oaicompat", {rewrite: true});
	assert.equal(harness.calls.length, 2, "it does not spend a request repeating the schema that already failed");
	assert.deepEqual(harness.lastBody().thinking, {type: "enabled", budget_tokens: 1024, display: "omitted"}, "same raw, next schema");
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({content: [{type: "thinking", thinking: "summary"}, {type: "text", text: "Hallo"}], usage: {input_tokens: 1, output_tokens: 1}}));
	assert.equal((await again).ok, true);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
	assert.equal(harness.calls.length, 2, "and it stays inside the same three-request budget");
	assert.deepEqual(harness.tierStates.map(entry => entry.state), ["ignored", "confirmed"], "the verdict lands on the same exact value");
	assert.equal(harness.tierStates.every(entry => entry.raw === "low"), true);
	// a different wire is a different benchmark subject, so an old measurement expires
	assert.notEqual(harness.client.getBenchmarkFingerprint("oaicompat"), benchmarkBefore);
});

test("T4 an OpenAI single-candidate rewrite re-sends the exact selected raw", async () => {
	const harness = createHarness({authKeys: T4_ON("https://relay.test/v1/chat/completions", "gpt-5.6-sol", "xhigh")});
	const first = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().reasoning_effort, "xhigh");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}], usage: {completion_tokens_details: {reasoning_tokens: 0}}}));
	assert.equal((await first).ok, true);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").evidence, "none", "zero does not claim an explicit effort failed");

	const again = harness.client.validateEngineConfig("oaicompat", {rewrite: true});
	assert.equal(harness.calls.length, 2, "rewrite still dispatches a controlled probe");
	assert.equal(harness.lastBody().reasoning_effort, "xhigh", "the exact raw is re-sent instead of dropping the field");
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo", reasoning_content: "plan"}}], usage: {completion_tokens_details: {reasoning_tokens: 12}}}));
	assert.equal((await again).ok, true);
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").evidence, "confirmed");
});

test("T4 production never strips a rejected explicit field", async () => {
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://host.test/v1/chat/completions", model: "gpt-x", reasoningMode: "off", reasoningProfile: "openai"}}});
	const pending = harness.client.validateEngineConfig("oaicompat");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "Hallo"}}]}));
	assert.equal((await pending).ok, true);
	assert.equal(harness.calls.length, 1);

	harness.client.translate("oaicompat", translationData(), () => {});
	assert.equal(harness.calls.length, 2);
	assert.equal(harness.lastBody().reasoning_effort, "none");
	harness.respond(1, null, {statusCode: 400}, JSON.stringify({error: {message: "Unknown parameter: reasoning_effort"}}));
	assert.equal(harness.calls.length, 2, "production stops rather than sending provider default");
	assert.equal(harness.client.getReasoningControlStatus("oaicompat").support, "unsupported");
});

test("T4 a validation result is recorded per exact value", async () => {
	const harness = createHarness({authKeys: T4_ON("https://relay.test/v1beta/models", "gemini-3-flash", "medium")});
	const pending = harness.client.validateEngineConfig("oaicompat");
	assert.equal(harness.lastBody().generationConfig.thinkingConfig.thinkingLevel, "medium");
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "Hallo"}]}}], usageMetadata: {promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 12}}));
	assert.equal((await pending).ok, true);
	assert.deepEqual(harness.tierStates, [{engineKey: "oaicompat", modelId: "gemini-3-flash", raw: "medium", state: "confirmed"}]);

	harness.client.setReasoningModelPreference("oaicompat", {mode: "on", effort: "high"});
	const second = harness.client.validateEngineConfig("oaicompat");
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({candidates: [{content: {parts: [{text: "Hallo"}]}}], usageMetadata: {promptTokenCount: 1, candidatesTokenCount: 1}}));
	assert.equal((await second).ok, true);
	assert.deepEqual(harness.tierStates.map(entry => [entry.raw, entry.state]), [["medium", "confirmed"], ["high", "sent"]], "zero keeps this exact value sent but unconfirmed");
});

test("T5 the thinking strength options are a redacted three-source union the panel can render", () => {
	const tierStates = {"s:medium": {state: "confirmed", evidence: "confirmed", raw: "medium", checkedAt: 1}, "n:12000": {state: "rejected", evidence: "none", raw: 12000, checkedAt: 2}};
	const harness = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-3-flash", reasoningModels: {"gemini-3-flash": {mode: "on", profile: "auto", effort: "medium", onRaw: "medium", rawExplicit: true, controlProfile: {tierStates}}}}}});
	const options = harness.client.getReasoningTierOptions("oaicompat");
	assert.deepEqual(options.filter(option => !option.custom).map(option => option.raw), ["minimal", "low", "medium", "high", 12000], "declared tiers plus every value that already carries a verdict");
	assert.equal(options.find(option => option.raw === "medium").state, "confirmed");
	assert.equal(options.find(option => option.raw === 12000).state, "rejected");
	assert.equal(options.find(option => option.raw === "low").state, "pending", "an untested tier is not hidden");
	assert.equal(options[options.length - 1].custom, true, "Custom is last");
	assert.equal(options.filter(option => !option.custom).every(option => typeof option.rawKey == "string" && option.rawKey), true, "each option has a stable id for the control");

	// what the panel renders carries no wire field names, adapter ids or schema strings
	const serialized = JSON.stringify(options);
	for (const technical of ["thinkingLevel", "thinkingConfig", "generationConfig", "schemaId", "gemini_native", "candidateId", "resolvedValue"]) {
		assert.equal(serialized.includes(technical), false, technical + " must never reach the panel");
	}
	// following the provider offers no strength at all
	const follow = createHarness({authKeys: {oaicompat: {key: "k", endpoint: "https://relay.test/v1beta/models", model: "gemini-3-flash", reasoningModels: {"gemini-3-flash": {mode: "follow", profile: "auto", effort: "low"}}}}});
	assert.equal(follow.client.getReasoningTierOptions("oaicompat").filter(option => !option.custom).length, 4, "the ladder is still described, but the row itself stays hidden while following");
});

test("F2b streams one live OpenAI Chat request and records TTFT without using callback transport", async () => {
	const owner = createProviderAttemptOwner();
	const transport = scriptedStreamTransport(owner, [{ok: true, reader: streamReader(streamFrames("实时流式"))}]);
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
	const translated = await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness), resolve));

	assert.equal(translated, "实时流式");
	assert.equal(transport.calls.length, 1);
	assert.equal(harness.calls.length, 0);
	const wire = JSON.parse(transport.calls[0].options.body);
	assert.equal(wire.stream, true);
	assert.equal(wire.model, "compat-x");
	assert.equal(harness.latencyEvents.length, 1);
	assert.equal(harness.latencyEvents[0].streaming, true);
	assert.equal(harness.latencyEvents[0].ttftMs, 0);
	assert.equal(harness.latencyEvents[0].streamChunkCount, 1);
	assert.equal(harness.latencyEvents[0].status, "ok");
	assert.equal(owner.getSnapshot().active, 0);
});

test("F2b consumes JSON 200 once, remembers unsupported capability and retries streaming after a model change", async () => {
	const owner = createProviderAttemptOwner();
	const jsonBody = JSON.stringify({choices: [{message: {content: "JSON 译文"}}]});
	const transport = scriptedStreamTransport(owner, [
		{ok: false, errorKind: "content_type", status: 200, contentType: "application/json", body: jsonBody},
		{ok: true, reader: streamReader(streamFrames("新模型流式"))}
	], [{ok: true, errorKind: null, status: 200, body: jsonBody, contentType: "application/json"}]);
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
	assert.equal(await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness), resolve)), "JSON 译文");
	assert.equal(transport.calls.length, 1, "the JSON response is consumed from the original fetch");
	assert.equal(harness.calls.length, 0, "JSON 200 never creates a compatibility request");

	const second = await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness), resolve));
	assert.equal(second, "JSON 译文");
	assert.equal(transport.textCalls.length, 1, "the remembered capability uses abortable native text transport");
	assert.equal(harness.calls.length, 0);
	assert.equal(transport.calls.length, 1);

	harness.authKeys.oaicompat.model = "compat-y";
	assert.equal(await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness), resolve)), "新模型流式");
	assert.equal(transport.calls.length, 2, "model is part of the capability fingerprint");
});

test("F2b explicit stream incompatibility spends one shared retry and preserves reasoning bytes", async () => {
	const endpoint = "https://compat.example/v1/chat/completions";
	const model = "compat-x";
	const capability = {support: "accepted", candidateId: "openai_on_low", resolvedValue: "low", evidence: "confirmed", endpointKey: endpoint, format: "openai_chat", checkedAt: 1};
	const auth = {key: "k", endpoint, model, interfaceFormat: "openai_chat", reasoningModels: {[model]: {mode: "on", profile: "openai", effort: "low", capability}}};
	const owner = createProviderAttemptOwner();
	const transport = scriptedStreamTransport(owner, [{ok: false, errorKind: "content_type", status: 400, contentType: "application/json", body: JSON.stringify({error: {message: "Unknown parameter: stream"}})}], [{ok: true, errorKind: null, status: 200, body: JSON.stringify({choices: [{message: {content: "兼容译文"}}]}), contentType: "application/json"}]);
	const harness = createHarness({authKeys: {oaicompat: auth}, providerAttemptOwner: owner, streamTransport: transport});
	const budget = createProviderCompatibilityBudget();
	const translated = await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness, {compatibilityBudget: budget}), resolve));
	assert.equal(transport.textCalls.length, 1);
	assert.equal(harness.calls.length, 0);
	const fallbackBody = JSON.parse(transport.textCalls[0].options.body);
	assert.equal(fallbackBody.stream, undefined);
	assert.equal(fallbackBody.reasoning_effort, "low", "stream fallback removes only stream mode, never reasoning intent");
	assert.deepEqual(budget.getSnapshot(), {limit: 1, used: 1, remaining: 0, reasons: ["stream_to_nonstream"]});
	assert.equal(translated, "兼容译文");
	assert.equal(harness.latencyEvents.filter(event => event.streaming).length, 1);
	assert.equal(harness.latencyEvents.find(event => event.streaming).streamFallback, true);
});

test("F2b never exceeds the shared budget and never replays a truncated body on the same provider", async () => {
	for (const fixture of [
		{
			name: "budget-used",
			build(owner) {
				const budget = createProviderCompatibilityBudget();
				budget.consume("reasoning_shape");
				return {budget, transport: scriptedStreamTransport(owner, [{ok: false, errorKind: "content_type", status: 400, contentType: "application/json", body: JSON.stringify({error: {message: "stream is unsupported"}})}])};
			}
		},
		{
			name: "truncated-after-text",
			build(owner) {
				return {budget: createProviderCompatibilityBudget(), transport: scriptedStreamTransport(owner, [{ok: true, reader: streamReader([new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: "partial"}, finish_reason: null}]})}\n\n`)])}])};
			}
		}
	]) {
		const owner = createProviderAttemptOwner();
		const built = fixture.build(owner);
		const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: built.transport});
		const translated = await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness, {compatibilityBudget: built.budget}), resolve));
		assert.equal(translated, "", fixture.name);
		assert.equal(harness.calls.length, 0, `${fixture.name} must not issue non-stream transport`);
		assert.equal(owner.getSnapshot().active, 0);
	}
});

test("F2b rechecks currentness after stream negotiation before any compatibility dispatch", async () => {
	const owner = createProviderAttemptOwner();
	let resolveOpen = null;
	const transport = {
		calls: [],
		textCalls: [],
		openStream(args) {
			this.calls.push(args);
			return new Promise(resolve => {resolveOpen = () => {owner.finish(args.token); resolve({ok: false, errorKind: "content_type", status: 400, contentType: "application/json", body: JSON.stringify({error: {message: "stream unsupported"}})});};});
		},
		requestText(args) {this.textCalls.push(args); owner.finish(args.token); return Promise.resolve({ok: true, status: 200, body: "{}"});}
	};
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
	let current = true;
	const budget = createProviderCompatibilityBudget();
	const requestContext = Object.freeze({logicalRequestId: "live-currentness", signal: null, isCurrent: () => current, compatibilityBudget: budget});
	const pending = new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness, {requestContext}), resolve));
	await nextTurn();
	current = false;
	resolveOpen();
	assert.equal(await pending, "");
	assert.equal(transport.textCalls.length, 0);
	assert.equal(harness.calls.length, 0);
});

test("F2b leaves manual single requests and every batch on their established non-stream transport", async () => {
	const owner = createProviderAttemptOwner();
	const transport = scriptedStreamTransport(owner, []);
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
	const manual = new Promise(resolve => harness.client.openAiCompatibleTranslate(translationData({engine: {id: "oaicompat"}}), resolve));
	assert.equal(harness.calls.length, 1);
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "手动译文"}}]}));
	assert.equal(await manual, "手动译文");

	const batch = harness.client.requestAiBatchTranslation("oaicompat", preparedItems());
	assert.equal(harness.calls.length, 2);
	harness.respond(1, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: JSON.stringify([{id: "100", translation: "甲"}, {id: "200", translation: "乙"}])}}]}));
	assert.deepEqual(await batch, {"100": "甲", "200": "乙"});
	assert.equal(transport.calls.length, 0);
});

test("the live streaming UI switch changes the next request without rebuilding the provider client", async () => {
	let enabled = false;
	const owner = createProviderAttemptOwner();
	const transport = scriptedStreamTransport(owner, [{ok: true, reader: streamReader(streamFrames("流式开启"))}]);
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport, isLiveStreamingEnabled: () => enabled});
	const nonstream = new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness), resolve));
	assert.equal(harness.calls.length, 1);
	assert.equal(transport.calls.length, 0);
	harness.respond(0, null, {statusCode: 200}, JSON.stringify({choices: [{message: {content: "流式关闭"}}]}));
	assert.equal(await nonstream, "流式关闭");
	enabled = true;
	harness.client.resetOpenAiChatStreamCapabilities();
	assert.equal(await new Promise(resolve => harness.client.openAiCompatibleTranslate(liveRequestData(harness), resolve)), "流式开启");
	assert.equal(transport.calls.length, 1);
});

test("S4 clean OpenAI-compatible historical batch uses abortable text fetch with identical wire bytes", async () => {
	const authKeys = {oaicompat: AI_AUTH.oaicompat};
	const baseline = createHarness({authKeys});
	const owner = createProviderAttemptOwner();
	const responseBody = JSON.stringify({choices: [{message: {content: JSON.stringify([{id: "100", translation: "甲"}, {id: "200", translation: "乙"}])}}]});
	const transport = scriptedStreamTransport(owner, [], [{ok: true, errorKind: null, status: 200, body: responseBody, contentType: "application/json"}]);
	const observed = createHarness({authKeys, providerAttemptOwner: owner, streamTransport: transport});
	const baselinePending = baseline.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems());
	const requestContext = Object.freeze({logicalRequestId: "history-clean", signal: null, isCurrent: () => true, compatibilityBudget: createProviderCompatibilityBudget()});
	const admissionLease = Object.freeze({granted: true, attemptId: 1});
	const releases = [], observations = [];
	const observedPending = observed.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems(), {
		token: Object.freeze({requestId: 101, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
		role: "primary", engineKey: "oaicompat", messageCount: 2, requestContext, historicalBatch: true,
		historicalAdmission: {acquireAttempt: () => Promise.resolve(admissionLease), releaseAttempt: (lease, outcome) => releases.push({lease, outcome}), isCurrent: () => true},
		historicalAttemptFactory: () => ({onRequest: event => observations.push(["request", event]), onSettle: event => observations.push(["settle", event])})
	});
	await nextTurn();
	assert.equal(observed.calls.length, 0);
	assert.equal(transport.textCalls.length, 1);
	assert.equal(transport.textCalls[0].url, baseline.calls[0].url);
	assert.deepEqual(transport.textCalls[0].options, baseline.calls[0].options);
	baseline.respond(0, null, {statusCode: 200}, responseBody);
	assert.deepEqual(await observedPending, await baselinePending);
	assert.equal(releases.length, 1);
	assert.equal(releases[0].lease, admissionLease);
	assert.equal(releases[0].outcome.physicalSettled, true);
	assert.equal(observations[1][1].physicalAbort, false);
	assert.deepEqual(owner.getSnapshot(), {generation: 0, active: 0, highWater: 1, controllerCount: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
});

test("S4 historical batch timeout and logical cancellation physically abort fetch and report honest diagnostics", async () => {
	for (const mode of ["timeout", "cancel"]) {
		const owner = createProviderAttemptOwner();
		const timers = [];
		let fetchSignal = null;
		const transport = createAbortableProviderTransport({
			attemptOwner: owner,
			setTimeout(callback) {timers.push(callback); return timers.length;},
			fetchFunction(_url, options) {
				fetchSignal = options.signal;
				return new Promise((_resolve, reject) => fetchSignal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
			}
		});
		const logical = new AbortController();
		const current = {value: true};
		const requestContext = Object.freeze({logicalRequestId: `history-${mode}`, signal: logical.signal, isCurrent: () => current.value, compatibilityBudget: createProviderCompatibilityBudget()});
		const releases = [], observations = [];
		const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
		const pending = harness.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems(), {
			token: Object.freeze({requestId: mode === "timeout" ? 102 : 103, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
			role: "primary", engineKey: "oaicompat", messageCount: 2, requestContext, historicalBatch: true,
			historicalAdmission: {acquireAttempt: () => Promise.resolve(Object.freeze({granted: true, attemptId: 1})), releaseAttempt: (lease, outcome) => releases.push({lease, outcome}), isCurrent: () => current.value},
			historicalAttemptFactory: () => ({onRequest: event => observations.push(["request", event]), onSettle: event => observations.push(["settle", event])})
		});
		await nextTurn();
		assert.ok(fetchSignal);
		if (mode === "timeout") timers[0]();
		else {current.value = false; logical.abort("edited");}
		const result = await pending;
		assert.equal(fetchSignal.aborted, true);
		assert.equal(result.failureKind, mode === "timeout" ? "timeout" : "transient");
		assert.equal(harness.calls.length, 0);
		assert.equal(releases.length, 1);
		assert.equal(releases[0].outcome.physicalSettled, true);
		assert.equal(observations[1][1].physicalAbort, true);
		assert.equal(owner.getSnapshot().active, 0);
		assert.equal(owner.getSnapshot().timerCount, 0);
		assert.equal(owner.getSnapshot().logicalSignalCount, 0);
	}
});

test("S4 late body is discarded and no child continuation starts before the parent fetch settles", async () => {
	const owner = createProviderAttemptOwner();
	let resolveFetch = null, fetchSignal = null;
	const responseBody = JSON.stringify({choices: [{message: {content: JSON.stringify([{id: "100", translation: "迟到甲"}, {id: "200", translation: "迟到乙"}])}}]});
	const transport = createAbortableProviderTransport({
		attemptOwner: owner,
		setTimeout: () => 1,
		fetchFunction(_url, options) {
			fetchSignal = options.signal;
			return new Promise(resolve => {resolveFetch = () => resolve({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(responseBody)});});
		}
	});
	const logical = new AbortController();
	let current = true, childStarted = false, settled = false;
	const requestContext = Object.freeze({logicalRequestId: "history-late", signal: logical.signal, isCurrent: () => current, compatibilityBudget: createProviderCompatibilityBudget()});
	const releases = [], observations = [];
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
	const pending = harness.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems(), {
		token: Object.freeze({requestId: 104, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
		role: "primary", engineKey: "oaicompat", messageCount: 2, requestContext, historicalBatch: true,
		historicalAdmission: {acquireAttempt: () => Promise.resolve(Object.freeze({granted: true, attemptId: 1})), releaseAttempt: (lease, outcome) => releases.push({lease, outcome}), isCurrent: () => current},
		historicalAttemptFactory: () => ({onRequest: event => observations.push(["request", event]), onSettle: event => observations.push(["settle", event])})
	}).then(result => {settled = true; childStarted = true; return result;});
	await nextTurn();
	current = false;
	logical.abort("source-edited");
	assert.equal(fetchSignal.aborted, true);
	assert.equal(owner.getSnapshot().active, 0);
	await nextTurn();
	assert.equal(settled, false, "parent promise waits for the physical fetch settle boundary");
	assert.equal(childStarted, false);
	assert.equal(releases.length, 0, "S3H lease remains with the physical parent until settle");
	resolveFetch();
	const result = await pending;
	assert.deepEqual(result, {translations: null, failureKind: "transient", statusCode: 200});
	assert.equal(childStarted, true);
	assert.equal(releases.length, 1);
	assert.equal(releases[0].outcome.physicalSettled, true);
	assert.equal(observations.filter(([type]) => type === "settle").length, 1);
	assert.equal(observations.at(-1)[1].physicalAbort, true);
	assert.equal(harness.latencyEvents.length, 1);
	assert.equal(harness.latencyEvents[0].status, "cancelled");
});

test("S4 one hundred success/cancel cycles zero attempt controller timer signal and S3H lease resources", async () => {
	const owner = createProviderAttemptOwner();
	const budgetOwner = createHistoricalProviderBudgetOwner({capacity: 4});
	let currentSignal = null;
	let cancelFixture = false;
	const successBody = JSON.stringify({choices: [{message: {content: JSON.stringify([{id: "100", translation: "甲"}, {id: "200", translation: "乙"}])}}]});
	const transport = createAbortableProviderTransport({attemptOwner: owner, fetchFunction: (_url, options) => {
		currentSignal = options.signal;
		if (cancelFixture) return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
		return Promise.resolve({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(successBody)});
	}});
	const harness = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: owner, streamTransport: transport});
	for (let cycle = 0; cycle < 100; cycle++) {
		let current = true;
		const logical = new AbortController();
		cancelFixture = !!(cycle % 2);
		const logicalBudget = budgetOwner.beginLogical({isCurrent: () => current});
		const admission = {acquireAttempt: meta => budgetOwner.acquireAttempt(logicalBudget, Object.assign({}, meta, {isCurrent: () => current})), releaseAttempt: lease => budgetOwner.releaseAttempt(lease), isCurrent: () => current};
		const pending = harness.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems(), {
			token: Object.freeze({requestId: 200 + cycle, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}),
			role: "primary", engineKey: "oaicompat", messageCount: 2, requestContext: Object.freeze({logicalRequestId: `cycle-${cycle}`, signal: logical.signal, isCurrent: () => current, compatibilityBudget: createProviderCompatibilityBudget()}), historicalBatch: true, historicalAdmission: admission
		});
		if (cycle % 2) {
			while (!currentSignal) await nextTurn();
			current = false;
			logical.abort("cycle-cancel");
		}
		await pending;
		budgetOwner.finishLogical(logicalBudget);
		const resources = owner.getSnapshot();
		assert.equal(resources.active, 0, `cycle ${cycle}`);
		assert.equal(resources.controllerCount, 0, `cycle ${cycle}`);
		assert.equal(resources.readerCount, 0, `cycle ${cycle}`);
		assert.equal(resources.decoderCount, 0, `cycle ${cycle}`);
		assert.equal(resources.timerCount, 0, `cycle ${cycle}`);
		assert.equal(resources.logicalSignalCount, 0, `cycle ${cycle}`);
		assert.equal(resources.bufferBytes, 0, `cycle ${cycle}`);
		assert.deepEqual(budgetOwner.getSnapshot().resources, {active: 0, waiting: 0, logicals: 0, keys: 0}, `cycle ${cycle}`);
		currentSignal = null;
		cancelFixture = false;
	}
});

test("S5 historical callback classifies roots, captures Retry-After, and skips the global backoff bucket", async () => {
	for (const fixture of [
		{status: 429, body: "{}", expected: "rate_limit", headers: {"retry-after": "2.5"}, retryAfterMs: 2500},
		{status: 503, body: "{}", expected: "server", headers: {}, retryAfterMs: null},
		{status: 400, body: JSON.stringify({error: {message: "Response schema invalid"}}), expected: "schema", headers: {}, retryAfterMs: null}
	]) {
		const harness = createHarness({authKeys: AI_AUTH});
		const releases = [];
		const pending = harness.client.requestAiBatchTranslationDetailed("openai", preparedItems(), {
			token: Object.freeze({requestId: fixture.status, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}), role: "primary", engineKey: "openai", messageCount: 2,
			historicalAdmission: {acquireAttempt: () => Promise.resolve(Object.freeze({granted: true, attemptId: 1})), releaseAttempt: (lease, outcome) => releases.push({lease, outcome})}
		});
		await nextTurn();
		harness.respond(0, null, {statusCode: fixture.status, headers: {get: name => fixture.headers[String(name).toLowerCase()] || null}}, fixture.body);
		assert.equal((await pending).failureKind, fixture.expected);
		assert.equal(releases.length, 1);
		assert.equal(releases[0].outcome.retryAfterMs, fixture.retryAfterMs);
		assert.equal(harness.backoffNotices.length, 0);
	}
});

test("S5 migrated timeout is distinguished from unmigrated callback timeout", async () => {
	const migratedOwner = createProviderAttemptOwner();
	const timers = [];
	const migratedTransport = createAbortableProviderTransport({attemptOwner: migratedOwner, setTimeout(callback) {timers.push(callback); return timers.length;}, fetchFunction: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")), {once: true}))});
	const migrated = createHarness({authKeys: {oaicompat: AI_AUTH.oaicompat}, providerAttemptOwner: migratedOwner, streamTransport: migratedTransport});
	const requestContext = Object.freeze({logicalRequestId: "timeout-migrated", signal: null, isCurrent: () => true, compatibilityBudget: createProviderCompatibilityBudget()});
	const migratedPending = migrated.client.requestAiBatchTranslationDetailed("oaicompat", preparedItems(), {token: Object.freeze({requestId: 401, generation: 0, kind: "historical", queueWaitMs: null, messageCount: 2, inputChars: 17}), role: "primary", engineKey: "oaicompat", messageCount: 2, requestContext, historicalBatch: true, historicalAdmission: {acquireAttempt: () => Promise.resolve(Object.freeze({granted: true, attemptId: 1})), releaseAttempt: () => true, isCurrent: () => true}});
	await nextTurn();
	timers[0]();
	const migratedOutcome = await migratedPending;
	assert.equal(migratedOutcome.failureKind, "timeout");
	assert.equal(migratedOutcome.historicalPhysicalSettled, true);

	const callback = createHarness({authKeys: AI_AUTH});
	const callbackPending = callback.client.requestAiBatchTranslationDetailed("openai", preparedItems());
	callback.fireTimer(0);
	const callbackOutcome = await callbackPending;
	assert.equal(callbackOutcome.failureKind, "transient");
	assert.equal(callbackOutcome.historicalPhysicalSettled, undefined);
});

// W4 observer regression: real transport owner, entirely local fetch substitutes.
test("W4 diagnostics callback stream canary and historical wrappers retain one anonymous request and settle", async t => {
 for (const mode of ["callback", "canary", "stream", "history"]) await t.test(mode, async () => {
  const owner=createProviderAttemptOwner(), sent=[], requests=[], settles=[];
  const content=mode === "history" ? JSON.stringify([{id:"100",translation:"甲"},{id:"200",translation:"乙"}]) : "译文";
  const body=JSON.stringify({choices:[{message:{content},finish_reason:"stop"}]});
  const transport=createAbortableProviderTransport({attemptOwner:owner,fetchFunction:async (_url,options)=>{sent.push(options); return {status:200,headers:{get:()=>"application/json"},text:async()=>body};}});
  const h=createHarness({authKeys:{oaicompat:AI_AUTH.oaicompat},providerAttemptOwner:owner,streamTransport:transport});
  const requestContext={logicalRequestId:"live:observer",signal:null,isCurrent:()=>true,compatibilityBudget:createProviderCompatibilityBudget(),wholeMarkerCanary:mode === "canary"};
  const timingContext={token:{requestId:9050,generation:0,kind:mode === "history"?"historical":mode === "stream"?"live":"manual"},role:mode === "history"?"retry":"primary",engineKey:"oaicompat",messageCount:mode === "history"?2:1,requestContext,diagnosticRequestObserver:event=>requests.push(event),diagnosticStageObserver:event=>settles.push(event)};
  let pending;
  if(mode === "history")pending=h.client.requestAiBatchTranslationDetailed("oaicompat",preparedItems(),Object.assign(timingContext,{historicalBatch:true}));
  else pending=new Promise(resolve=>h.client.openAiCompatibleTranslate(translationData({engine:{id:"oaicompat"},timingContext,requestContext}),resolve));
  if(mode === "callback") {sent.push(h.lastCall().options);h.respond(0,null,{statusCode:200},body);}
  const translated=await pending;
  if(mode === "history")assert.deepEqual(translated.translations,{"100":"甲","200":"乙"});else assert.equal(translated,"译文");
  assert.equal(sent.length,1);assert.equal(requests.length,1);assert.equal(settles.length,1);
  const actualBody=sent[0].body,expectedDigest=crypto.createHash("md5").update("discord-ai-translator:h1:body:v1\u0000"+JSON.stringify(actualBody)).digest("hex").slice(0,20);
  assert.deepEqual(requests[0],{bodyBytes:Buffer.byteLength(actualBody),bodyIdentity:"bi1:"+expectedDigest,role:mode === "history"?"repair":"primary"});
  assert.equal(settles[0].httpStatus,200);assert.equal(settles[0].status,"ok");
  assert.doesNotMatch(JSON.stringify({requests,settles}),/hello there|hello\\nthere|k-compat|compat\.example|diagnosticRequestObserver|diagnosticStageObserver/);
  assert.equal(owner.getSnapshot().active,0);assert.equal(h.latencyEvents.length,1);
 });
});

test("W4 diagnostics abortable observers isolate synchronous throws and rejected promises from successful transport", async t => {
 const unhandled=[];const onUnhandled=error=>unhandled.push(error);process.on("unhandledRejection",onUnhandled);
 try {
  for (const mode of ["canary","stream","history"]) for (const failure of ["throw","reject"]) await t.test(mode+" "+failure,async()=>{
   const owner=createProviderAttemptOwner();let physical=0,requested=0,settled=0;
   const content=mode === "history"?JSON.stringify([{id:"100",translation:"甲"},{id:"200",translation:"乙"}]):"译文";
   const transport=createAbortableProviderTransport({attemptOwner:owner,fetchFunction:async()=>{physical++;return{status:200,headers:{get:()=>"application/json"},text:async()=>JSON.stringify({choices:[{message:{content}}]})};}});
   const h=createHarness({authKeys:{oaicompat:AI_AUTH.oaicompat},providerAttemptOwner:owner,streamTransport:transport});
   const fault=()=>{if(failure === "throw")throw new Error("PRIVATE_OBSERVER_SENTINEL");return Promise.reject(new Error("PRIVATE_OBSERVER_SENTINEL"));};
   const requestContext={logicalRequestId:"live:observer-fault",signal:null,isCurrent:()=>true,compatibilityBudget:createProviderCompatibilityBudget(),wholeMarkerCanary:mode === "canary"};
   const timingContext={token:{requestId:9051,generation:0,kind:mode === "history"?"historical":mode === "stream"?"live":"manual"},role:"primary",engineKey:"oaicompat",messageCount:1,requestContext,diagnosticRequestObserver:()=>{requested++;return fault();},diagnosticStageObserver:()=>{settled++;return fault();},wireObservationProbe:{observe:()=>fault()}};
   let result;
   if(mode === "history")result=await h.client.requestAiBatchTranslationDetailed("oaicompat",preparedItems(),Object.assign(timingContext,{historicalBatch:true}));
   else result=await new Promise(resolve=>h.client.openAiCompatibleTranslate(translationData({engine:{id:"oaicompat"},timingContext,requestContext}),resolve));
   if(mode === "history")assert.deepEqual(result.translations,{"100":"甲","200":"乙"});else assert.equal(result,"译文");
   await nextTurn();await nextTurn();assert.deepEqual(unhandled,[]);
   assert.deepEqual([physical,requested,settled],[1,1,1]);assert.equal(h.calls.length,0);assert.equal(owner.getSnapshot().active,0);
   assert.doesNotMatch(JSON.stringify(h.latencyEvents),/PRIVATE_OBSERVER_SENTINEL|diagnosticRequestObserver|diagnosticStageObserver/);
  });
 } finally {process.removeListener("unhandledRejection",onUnhandled);}
});

test("W4 diagnostics already stale canary and live requests emit no sent-body observation", async () => {
 for (const streaming of [false,true]) {
  const owner=createProviderAttemptOwner();let physical=0,observed=0;
  const transport=createAbortableProviderTransport({attemptOwner:owner,fetchFunction:async()=>{physical++;throw new Error("must stay local and undispatched");}});
  const h=createHarness({authKeys:{oaicompat:AI_AUTH.oaicompat},providerAttemptOwner:owner,streamTransport:transport});
  const requestContext={logicalRequestId:"live:already-stale",signal:null,isCurrent:()=>false,compatibilityBudget:createProviderCompatibilityBudget(),wholeMarkerCanary:!streaming};
  const timingContext={token:{requestId:9052,generation:0,kind:streaming?"live":"manual"},role:"primary",engineKey:"oaicompat",messageCount:1,requestContext,diagnosticRequestObserver:()=>{observed++;}};
  const result=await new Promise(resolve=>h.client.openAiCompatibleTranslate(translationData({engine:{id:"oaicompat"},timingContext,requestContext}),resolve));
  assert.equal(result,"");assert.deepEqual([physical,observed,h.calls.length],[0,0,0]);assert.equal(owner.getSnapshot().active,0);
 }
});
