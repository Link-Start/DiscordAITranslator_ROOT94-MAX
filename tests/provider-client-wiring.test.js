const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginProviderClient} = require("../src/providers/provider-client-wiring");

function createFixture({fetchFunction = null} = {}) {
	const calls = [];
	const timer = {id: "provider-timer"};
	const settingsStore = {
		getAuthKeys: () => (calls.push(["getAuthKeys"]), {openai: {key: "fixture-key"}}),
		replaceAuthKeys: value => (calls.push(["saveAuthKeys", value]), value),
		getReasoningModelPref: (engineKey, modelId) => (calls.push(["getReasoningModelPref", engineKey, modelId]), {mode: "follow"}),
		setReasoningModelPref: (engineKey, modelId, preference) => (calls.push(["setReasoningModelPref", engineKey, modelId, preference]), preference),
		setReasoningModelCapability: (engineKey, modelId, capability) => (calls.push(["setReasoningModelCapability", engineKey, modelId, capability]), capability),
		setReasoningModelTierState: (engineKey, modelId, raw, tierState) => (calls.push(["setReasoningModelTierState", engineKey, modelId, raw, tierState]), tierState),
		clearReasoningModelCapability: (engineKey, modelId) => (calls.push(["clearReasoningModelCapability", engineKey, modelId]), true),
		setInterfaceDetection: (engineKey, detection) => (calls.push(["setInterfaceDetection", engineKey, detection]), detection),
		clearInterfaceDetection: engineKey => (calls.push(["clearInterfaceDetection", engineKey]), true),
		getLanguages: () => (calls.push(["getLanguages"]), {en: {id: "en"}})
	};
	const plugin = {
		labels: {provider_error: "Provider error"},
		ensureSettingsStore: () => settingsStore,
		getCustomText: key => (calls.push(["getCustomText", key]), `custom:${key}`),
		getEngineLabel: engineKey => (calls.push(["getEngineLabel", engineKey]), `engine:${engineKey}`),
		shouldUseAiAutoTranslateDecision: channelId => (calls.push(["shouldUseAiAutoTranslateDecision", channelId]), channelId == "channel-1"),
		getAiAutoTranslatePrompt: data => (calls.push(["getAiAutoTranslatePrompt", data]), `prompt:${data.text}`)
	};
	const BDFDB = {
		DataUtils: {
			load: (_plugin, key) => (calls.push(["loadData", key]), key == "modelCatalogs" ? {openai: {items: ["gpt-fixture"]}} : null),
			save: (value, _plugin, key) => (calls.push(["saveData", key, value]), value)
		},
		LibraryRequires: {
			request: (url, options, callback) => (calls.push(["request", url, options, callback]), "request-result")
		},
		TimeUtils: {
			timeout: (callback, delay) => (calls.push(["setTimeout", callback, delay]), timer),
			clear: value => calls.push(["clearTimeout", value])
		},
		NotificationUtils: {
			toast: (message, options) => (calls.push(["notify", message, options]), "toast-result")
		}
	};
	const sleep = ms => (calls.push(["sleep", ms]), Promise.resolve(`slept:${ms}`));
	let dependencies = null;
	const client = {tag: "provider-client"};
	const created = createPluginProviderClient({
		plugin,
		BDFDB,
		now: () => 456,
		sleep,
		fetchFunction,
		createClient: input => (dependencies = input, client)
	});
	return {plugin, BDFDB, calls, timer, sleep, dependencies, client, created};
}

test("provider client wiring creates the client with the complete dependency contract", () => {
	const fixture = createFixture();

	assert.notEqual(fixture.created, fixture.client);
	assert.equal(fixture.created.tag, fixture.client.tag);
	assert.ok(Object.isFrozen(fixture.created));
	for (const method of ["beginLatencyRequest", "recordLatencyEvent", "recordSemanticObservation", "recordAttemptOutcome", "recordWireObservationEvent", "recordDisplayObservation", "getLatencySnapshot", "getWireObservationSnapshot", "getLatencyGeneration", "resetLatency", "abortProviderAttempts", "drainProviderAttempts", "getProviderAttemptSnapshot"]) assert.equal(typeof fixture.created[method], "function");
	assert.deepEqual(Object.keys(fixture.dependencies).sort(), [
		"beginLatencyRequest",
		"clearReasoningModelCapability",
		"clearInterfaceDetection",
		"clearTimeout",
		"createReasoningRawKey",
		"compileWholeMarkerBatchItem",
		"wholeMarkerBatchValidation",
		"isWholeMarkerBatchItemCurrent",
		"getAiAutoTranslatePrompt",
		"getAuthKeys",
		"getCustomText",
		"getEngineLabel",
		"getLabels",
		"getLanguages",
		"getReasoningModelPref",
		"isLiveStreamingEnabled",
		"observeCompactWireShadowBatch",
		"loadModelCatalogs",
		"notify",
		"now",
		"providerAttemptOwner",
		"recordLatencyEvent",
		"recordSemanticObservation",
		"recordAttemptOutcome",
		"request",
		"saveAuthKeys",
		"saveModelCatalogs",
		"setReasoningModelCapability",
		"setReasoningModelPref",
		"setReasoningModelTierState",
		"setInterfaceDetection",
		"setTimeout",
		"shouldUseAiAutoTranslateDecision",
		"sleep",
		"streamTransport"
	].sort());
	assert.equal(fixture.dependencies.now(), 456);
});

test("provider stream wiring uses BdApi.Net.fetch with plugin timeout ownership", async () => {
	let fetchOptions = null;
	const body = JSON.stringify({choices: [{message: {content: "fixture"}}]});
	const previous = globalThis.BdApi;
	globalThis.BdApi = {Net: {fetch: (_url, options) => {
		fetchOptions = options;
		return Promise.resolve({status: 200, headers: {get: () => "application/json"}, text: () => Promise.resolve(body), body: null});
	}}};
	try {
		const fixture = createFixture();
		assert.ok(fixture.dependencies.streamTransport);
		const token = fixture.dependencies.providerAttemptOwner.begin({logicalRequestId: "live-1"});
		const result = await fixture.dependencies.streamTransport.requestText({token, url: "https://fixture.test", options: {method: "post"}, timeoutMs: 0});
		assert.equal(result.body, body);
		assert.equal(fetchOptions.timeout, 0);
		assert.ok(fetchOptions.signal);
	}
	finally {
		if (previous === undefined) delete globalThis.BdApi;
		else globalThis.BdApi = previous;
	}
});

test("provider attempt ownership is plugin-scoped and stop abort is synchronous", async () => {
	const fixture = createFixture();
	const owner = fixture.dependencies.providerAttemptOwner;
	let readerCancels = 0;
	const token = owner.begin({logicalRequestId: "live-1"});
	const signal = owner.getSignal(token);
	owner.attachReader(token, {cancel() {readerCancels++; return Promise.resolve();}});

	assert.equal(fixture.created.getProviderAttemptSnapshot().active, 1);
	assert.equal(fixture.created.abortProviderAttempts("plugin-stopped"), 1);
	assert.equal(signal.aborted, true);
	assert.equal(readerCancels, 1);
	assert.equal(fixture.created.getProviderAttemptSnapshot().active, 0);
	await fixture.created.drainProviderAttempts();
});

test("provider latency state is isolated per plugin client facade", () => {
	const first = createFixture().created;
	const second = createFixture().created;
	const token = first.beginLatencyRequest({kind: "live"});
	first.recordLatencyEvent({token, engineKey: "openai", transportMs: 25, status: "ok"});
	assert.equal(first.getLatencySnapshot().attemptsCount, 1);
	assert.equal(second.getLatencySnapshot().attemptsCount, 0);
	first.resetLatency();
	assert.equal(first.getLatencySnapshot().attemptsCount, 0);
});

test("provider client wiring keeps request, managed retry timers and raw backoff sleep on their established seams", async () => {
	const fixture = createFixture();
	const callback = () => {};
	const options = {method: "POST"};

	assert.equal(fixture.dependencies.request("https://fixture.example", options, callback), "request-result");
	assert.equal(fixture.dependencies.setTimeout(callback, 500), fixture.timer);
	fixture.dependencies.clearTimeout(fixture.timer);
	assert.equal(await fixture.dependencies.sleep(25), "slept:25");

	assert.deepEqual(fixture.calls, [
		["request", "https://fixture.example", options, callback],
		["setTimeout", callback, 500],
		["clearTimeout", fixture.timer],
		["sleep", 25]
	]);
});

test("provider client wiring delegates credentials, languages, notifications and prompt policy unchanged", () => {
	const fixture = createFixture();
	const authKeys = {gemini: {key: "replacement"}};
	const toastOptions = {type: "danger"};
	const promptData = {text: "hello"};

	assert.deepEqual(fixture.dependencies.getAuthKeys(), {openai: {key: "fixture-key"}});
	assert.equal(fixture.dependencies.saveAuthKeys(authKeys), authKeys);
	assert.deepEqual(fixture.dependencies.loadModelCatalogs(), {openai: {items: ["gpt-fixture"]}});
	assert.deepEqual(fixture.dependencies.saveModelCatalogs({openai: {items: ["gpt-new"]}}), {openai: {items: ["gpt-new"]}});
	assert.deepEqual(fixture.dependencies.getLanguages(), {en: {id: "en"}});
	assert.equal(fixture.dependencies.notify("failure", toastOptions), "toast-result");
	assert.equal(fixture.dependencies.getLabels(), fixture.plugin.labels);
	assert.equal(fixture.dependencies.getCustomText("provider_error"), "custom:provider_error");
	assert.equal(fixture.dependencies.getEngineLabel("googleapi"), "engine:googleapi");
	assert.equal(fixture.dependencies.shouldUseAiAutoTranslateDecision("channel-1"), true);
	assert.equal(fixture.dependencies.getAiAutoTranslatePrompt(promptData), "prompt:hello");
	assert.deepEqual(fixture.dependencies.getReasoningModelPref("custom-a", "model-a"), {mode: "follow"});
	assert.deepEqual(fixture.dependencies.setReasoningModelPref("custom-a", "model-a", {mode: "on"}), {mode: "on"});
	assert.deepEqual(fixture.dependencies.setReasoningModelCapability("custom-a", "model-a", {support: "accepted"}), {support: "accepted"});
	assert.deepEqual(fixture.dependencies.setReasoningModelTierState("custom-a", "model-a", 12000, {state: "confirmed"}), {state: "confirmed"});
	assert.equal(fixture.dependencies.clearReasoningModelCapability("custom-a", "model-a"), true);
	assert.deepEqual(fixture.dependencies.setInterfaceDetection("custom-a", {resolved: "openai_chat"}), {resolved: "openai_chat"});
	assert.equal(fixture.dependencies.clearInterfaceDetection("custom-a"), true);

	assert.deepEqual(fixture.calls, [
		["getAuthKeys"],
		["saveAuthKeys", authKeys],
		["loadData", "modelCatalogs"],
		["saveData", "modelCatalogs", {openai: {items: ["gpt-new"]}}],
		["getLanguages"],
		["notify", "failure", toastOptions],
		["getCustomText", "provider_error"],
		["getEngineLabel", "googleapi"],
		["shouldUseAiAutoTranslateDecision", "channel-1"],
		["getAiAutoTranslatePrompt", promptData],
		["getReasoningModelPref", "custom-a", "model-a"],
		["setReasoningModelPref", "custom-a", "model-a", {mode: "on"}],
		["setReasoningModelCapability", "custom-a", "model-a", {support: "accepted"}],
		["setReasoningModelTierState", "custom-a", "model-a", 12000, {state: "confirmed"}],
		["clearReasoningModelCapability", "custom-a", "model-a"],
		["setInterfaceDetection", "custom-a", {resolved: "openai_chat"}],
		["clearInterfaceDetection", "custom-a"]
	]);
});

test("provider W5 callbacks compile real D and delegate target, similarity and source currentness without side effects", () => {
 const {planReceivedMarkdown} = require("../src/planner/received-markdown-lossless-planner");
 const {dependencies, plugin, BDFDB, calls} = createFixture();
 const source = "Please review the updated schedule.", plan = planReceivedMarkdown(source, {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
 const semanticRequest = {adapter: "typed-json", enabled: true, plan, targetLanguageId: "zh-CN"};
 let compiledInput = null;
 plugin.getAtomicSemanticLocalState = request => {compiledInput = request; return {protectedSegments: {}};};
 const request = dependencies.compileWholeMarkerBatchItem({semanticRequest});
 assert.equal(compiledInput, semanticRequest);
 assert.equal(request.ok, true);
 assert.equal(request.plan.sourceHash, plan.sourceHash);
 assert.equal(request.targetLanguageId, "zh-CN");
 assert.match(request.wire, /^⟪1⟫Please review the updated schedule\./);
 assert.equal(dependencies.compileWholeMarkerBatchItem({semanticRequest: null}), null);
 plugin.isTranslationLikelyInTargetLanguage = (text, target) => {calls.push(["likelyTarget", text, target]); return text === "译文" && target === "zh-CN";};
 plugin.getTextSimilarityScore = (sourceText, translated) => {calls.push(["similarity", sourceText, translated]); return 0.25;};
 const validation = dependencies.wholeMarkerBatchValidation({output: {id: "zh-CN"}});
 assert.equal(validation.likelyTarget("译文"), true);
 assert.equal(validation.similarity("source", "译文"), 0.25);
 assert.equal(validation.maxSimilarity, 0.94);
 assert.deepEqual(calls, [["likelyTarget", "译文", "zh-CN"], ["similarity", "source", "译文"]]);
 const message = {id: "one", content: source}, item = {message, channelId: "channel-1", signature: `channel-1:one:${source}`};
 let enabled = true, storedMessage = message;
 plugin.isTranslationEnabled = channel => enabled && channel === "channel-1";
 plugin.extractOriginalContentData = value => ({content: value.content});
 plugin.createReceivedTranslationSignature = (value, channel, original) => `${channel}:${value.id}:${original.content}`;
 assert.equal(dependencies.isWholeMarkerBatchItemCurrent(item), true, "without a MessageStore the captured source is checked");
 BDFDB.LibraryStores = {MessageStore: {getMessage(channel, id) {assert.equal(channel, "channel-1"); assert.equal(id, "one"); return storedMessage;}}};
 assert.equal(dependencies.isWholeMarkerBatchItemCurrent(item), true);
 storedMessage = {id: "one", content: "Edited source."};
 assert.equal(dependencies.isWholeMarkerBatchItemCurrent(item), false, "current store content wins over the captured message");
 storedMessage = message; enabled = false;
 assert.equal(dependencies.isWholeMarkerBatchItemCurrent(item), false);
});