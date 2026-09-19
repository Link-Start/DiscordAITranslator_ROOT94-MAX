const test = require("node:test");
const assert = require("node:assert/strict");

const {createReasoningRawKey} = require("../../src/settings/reasoning-raw-value");
const {createProviderAttemptOwner} = require("../../src/providers/provider-attempt-owner");
const {createAbortableProviderTransport} = require("../../src/providers/abortable-provider-transport");
const {createProviderClient} = require("../../src/providers/provider-client");

const SECRET = "w2-fixture-key-never-export";
const ENDPOINT = "https://w2.fixture.invalid/v1/chat/completions";
const MODEL = "w2-fixture-model-never-export";

function responseFor(format, text = "译文", withUsage = true) {
	if (format === "openai_responses") return JSON.stringify(Object.assign({output_text: text}, withUsage ? {usage: {input_tokens: 11, output_tokens: 7, output_tokens_details: {reasoning_tokens: 2}}} : {}));
	if (format === "gemini_native") return JSON.stringify(Object.assign({candidates: [{content: {parts: [{text}]}}]}, withUsage ? {usageMetadata: {promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 2}} : {}));
	if (format === "anthropic_messages") return JSON.stringify(Object.assign({content: [{type: "text", text}]}, withUsage ? {usage: {input_tokens: 11, output_tokens: 7, output_tokens_details: {thinking_tokens: 2}}} : {}));
	if (format === "ollama_native") return JSON.stringify(Object.assign({message: {content: text}}, withUsage ? {prompt_eval_count: 11, eval_count: 7} : {}));
	return JSON.stringify(Object.assign({choices: [{message: {content: text}}]}, withUsage ? {usage: {prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: {reasoning_tokens: 2}}} : {}));
}

function createHarness({engineKey = "oaicompat", format = "openai_chat", responseBody = null, transport = null, owner = null, authPatch = {}} = {}) {
	const providerAttemptOwner = owner || createProviderAttemptOwner();
	const calls = [];
	const writes = [];
	const authKeys = {[engineKey]: Object.assign({key: SECRET, endpoint: ENDPOINT, model: MODEL, interfaceFormat: format}, authPatch)};
	const streamTransport = transport || {
		async requestText({token, url, options}) {
			calls.push({url, options, body: JSON.parse(options.body)});
			providerAttemptOwner.finish(token);
			return {ok: true, errorKind: null, status: 200, body: responseBody == null ? responseFor(format) : responseBody, retryAfterMs: null};
		},
		async openStream() {return {ok: false, errorKind: "unused", status: 0};}
	};
	let clock = 1000;
	const client = createProviderClient({
		now: () => ++clock,
		getAuthKeys: () => authKeys,
		saveAuthKeys: value => writes.push(["auth", value]),
		createReasoningRawKey,
		getReasoningModelPref: (engineKey, modelId) => authKeys[engineKey] && authKeys[engineKey].reasoningModels && authKeys[engineKey].reasoningModels[modelId] || null,
		setReasoningModelPref: (...args) => writes.push(["reasoning-pref", args]),
		setReasoningModelCapability: (...args) => writes.push(["reasoning-capability", args]),
		setReasoningModelTierState: (...args) => writes.push(["reasoning-tier", args]),
		setInterfaceDetection: (...args) => writes.push(["interface", args]),
		providerAttemptOwner,
		streamTransport
	});
	return {client, calls, writes, authKeys, owner: providerAttemptOwner};
}

function promptFreePayload(payload, format) {
	const copy = JSON.parse(JSON.stringify(payload));
	if (format === "openai_responses") {delete copy.instructions; delete copy.input;}
	else if (format === "gemini_native") {delete copy.system_instruction; delete copy.contents;}
	else if (format === "anthropic_messages") {delete copy.system; delete copy.messages;}
	else delete copy.messages;
	return copy;
}

test("W2 provider capability is redacted and rejects a missing abortable transport", () => {
	const missing = createProviderClient({getAuthKeys: () => ({oaicompat: {key: SECRET, endpoint: ENDPOINT, model: MODEL, interfaceFormat: "openai_chat"}})});
	assert.deepEqual(missing.getWireExperimentCapability("oaicompat"), {
		ok: false,
		reason: "abort-transport-unavailable",
		engineKey: "oaicompat"
	});

	const {client} = createHarness();
	const capability = client.getWireExperimentCapability("oaicompat");
	assert.equal(capability.ok, true);
	assert.equal(capability.protocolFamily, "openai_chat");
	assert.match(capability.configDigest, /^w2c1:[0-9a-f]{20}$/);
	const encoded = JSON.stringify(capability);
	for (const secret of [SECRET, ENDPOINT, MODEL, "Authorization"]) assert.equal(encoded.includes(secret), false, secret);
});

test("W2 session uses batch controls, one current reasoning wire and no settings writes", async () => {
	const reasoningModels = {[MODEL]: {mode: "off", profile: "openai", effort: "low", onRaw: "low", rawExplicit: true}};
	const {client, calls, writes} = createHarness({authPatch: {reasoningModels}});
	const session = client.createWireExperimentSession("oaicompat", {maxRequests: 3, maxOutputTokens: 123, maxBodyBytes: 8192});
	assert.equal(session.capability.ok, true);
	const outputs = [];
	for (const arm of ["A", "B-array", "B-marker"]) outputs.push(await session.dispatch({systemPrompt: `system-${arm}`, userPrompt: `user-${arm}`, wireObservation: {wireFamily: arm === "A" ? "typed-json" : arm === "B-array" ? "compact-order" : "compact-marker", sourceBytes: 100, endpoint: ENDPOINT}}));
	assert.equal(calls.length, 3);
	for (const call of calls) {
		assert.equal(call.body.temperature, 0.1);
		assert.equal(call.body.top_p, 0.8);
		assert.equal(call.body.max_tokens, 123);
		assert.equal(call.body.reasoning_effort, "none");
	}
	assert.deepEqual(promptFreePayload(calls[0].body, "openai_chat"), promptFreePayload(calls[1].body, "openai_chat"));
	assert.deepEqual(promptFreePayload(calls[1].body, "openai_chat"), promptFreePayload(calls[2].body, "openai_chat"));
	assert.equal(writes.length, 0);
	assert.deepEqual(outputs.map(value => value.usage), [
		{promptTokens: 11, completionTokens: 7, reasoningTokens: 2},
		{promptTokens: 11, completionTokens: 7, reasoningTokens: 2},
		{promptTokens: 11, completionTokens: 7, reasoningTokens: 2}
	]);
	assert.equal(outputs.every(value => value.ok && value.text === "译文" && value.providerMs >= 0), true);
	assert.deepEqual(outputs[0].wireObservation, {wireFamily: "typed-json", sourceBytes: 100});
	assert.equal(JSON.stringify(outputs).includes(ENDPOINT), false);
	assert.equal(JSON.stringify(outputs).includes("译文"), false, "transient response text never enters diagnostics by object spread");
	assert.equal(session.snapshot().activeHighWater, 1);
	await session.drain();
});

test("W2 session applies one output cap and authoritative usage parser across every custom protocol", async t => {
	for (const format of ["openai_chat", "openai_responses", "gemini_native", "anthropic_messages", "ollama_native"]) await t.test(format, async () => {
		const {client, calls} = createHarness({format});
		const session = client.createWireExperimentSession("oaicompat", {maxRequests: 1, maxOutputTokens: 321, maxBodyBytes: 16384});
		const output = await session.dispatch({systemPrompt: "system", userPrompt: "user"});
		assert.equal(output.ok, true);
		assert.deepEqual(output.usage, {promptTokens: 11, completionTokens: 7, reasoningTokens: format === "ollama_native" ? null : 2});
		const body = calls[0].body;
		if (format === "openai_chat") {assert.equal(body.temperature, 0.1); assert.equal(body.max_tokens, 321);}
		if (format === "openai_responses") assert.equal(body.max_output_tokens, 321);
		if (format === "gemini_native") {assert.equal(body.generationConfig.temperature, 0.1); assert.equal(body.generationConfig.maxOutputTokens, 321);}
		if (format === "anthropic_messages") {assert.equal(body.temperature, 0.1); assert.equal(body.max_tokens, 321);}
		if (format === "ollama_native") {assert.equal(body.options.temperature, 0.1); assert.equal(body.options.num_predict, 321);}
	});
});

test("W2 resolves every built-in AI provider without exposing its private request config", async t => {
	for (const [engineKey, format] of [["openai", "openai_responses"], ["gemini", "gemini_native"], ["deepseek", "openai_chat"]]) await t.test(engineKey, async () => {
		const {client, calls} = createHarness({engineKey, format});
		const capability = client.getWireExperimentCapability(engineKey);
		assert.equal(capability.ok, true);
		assert.equal(capability.protocolFamily, format);
		for (const secret of [SECRET, ENDPOINT, MODEL]) assert.equal(JSON.stringify(capability).includes(secret), false);
		const output = await client.createWireExperimentSession(engineKey, {maxRequests: 1, maxOutputTokens: 222}).dispatch({systemPrompt: "system", userPrompt: "user"});
		assert.equal(output.ok, true);
		if (engineKey === "deepseek") assert.deepEqual(calls[0].body.thinking, {type: "disabled"});
	});
});

test("W2 missing provider usage stays null", async () => {
	const {client} = createHarness({responseBody: responseFor("openai_chat", "译文", false)});
	const result = await client.createWireExperimentSession("oaicompat", {maxRequests: 1}).dispatch({systemPrompt: "s", userPrompt: "u"});
	assert.equal(result.ok, true);
	assert.equal(result.usage, null);
});

test("W2 enforces stale config, body and request budgets before physical dispatch", async () => {
	const stale = createHarness();
	const staleSession = stale.client.createWireExperimentSession("oaicompat", {maxRequests: 2});
	stale.authKeys.oaicompat.model = `${MODEL}-changed`;
	assert.equal((await staleSession.dispatch({systemPrompt: "s", userPrompt: "u"})).reason, "stale");
	assert.equal(stale.calls.length, 0);

	const body = createHarness();
	const bodySession = body.client.createWireExperimentSession("oaicompat", {maxRequests: 2, maxBodyBytes: 32});
	assert.equal((await bodySession.dispatch({systemPrompt: "too-large", userPrompt: "too-large"})).reason, "body-budget");
	assert.equal(body.calls.length, 0);

	const attempts = createHarness();
	const attemptSession = attempts.client.createWireExperimentSession("oaicompat", {maxRequests: 1});
	assert.equal((await attemptSession.dispatch({systemPrompt: "s", userPrompt: "one"})).ok, true);
	assert.equal((await attemptSession.dispatch({systemPrompt: "s", userPrompt: "two"})).reason, "attempt-budget");
	assert.equal(attempts.calls.length, 1);
});

test("W2 concurrent dispatches serialize with active high-water one", async () => {
	const owner = createProviderAttemptOwner();
	let active = 0, activeHighWater = 0;
	const transport = {async requestText({token}) {active++; activeHighWater = Math.max(activeHighWater, active); await new Promise(resolve => setImmediate(resolve)); active--; owner.finish(token); return {ok: true, status: 200, body: responseFor("openai_chat")};}, async openStream() {return {ok: false, errorKind: "unused", status: 0};}};
	const {client} = createHarness({owner, transport});
	const session = client.createWireExperimentSession("oaicompat", {maxRequests: 3});
	const results = await Promise.all([0, 1, 2].map(index => session.dispatch({systemPrompt: "s", userPrompt: String(index)})));
	assert.equal(results.every(result => result.ok), true);
	assert.equal(activeHighWater, 1);
	assert.equal(session.snapshot().activeHighWater, 1);
});

test("W2 cancel physically aborts fetch and releases every provider resource", async () => {
	const owner = createProviderAttemptOwner();
	let fetchSignal = null;
	const transport = createAbortableProviderTransport({
		attemptOwner: owner,
		fetchFunction: (_url, options) => {
			fetchSignal = options.signal;
			return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
		}
	});
	const {client} = createHarness({owner, transport});
	const controller = new AbortController();
	const session = client.createWireExperimentSession("oaicompat", {maxRequests: 1, signal: controller.signal});
	const pending = session.dispatch({systemPrompt: "s", userPrompt: "u"});
	while (!fetchSignal) await new Promise(resolve => setImmediate(resolve));
	controller.abort("w2-stop");
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "cancelled");
	assert.equal(fetchSignal.aborted, true);
	await session.drain();
	assert.deepEqual(owner.getSnapshot(), {generation: 0, active: 0, highWater: 1, controllerCount: 0, readerCount: 0, decoderCount: 0, timerCount: 0, logicalSignalCount: 0, bufferBytes: 0});
});

test("W2 plugin-wide provider abort invalidates queued experiment work", async () => {
	const owner = createProviderAttemptOwner();
	let fetchCount = 0, fetchSignal = null;
	const transport = createAbortableProviderTransport({attemptOwner: owner, fetchFunction: (_url, options) => {
		fetchCount++;
		fetchSignal = options.signal;
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("stopped")), {once: true}));
	}});
	const {client} = createHarness({owner, transport});
	const session = client.createWireExperimentSession("oaicompat", {maxRequests: 2});
	const first = session.dispatch({systemPrompt: "s", userPrompt: "one"});
	const queued = session.dispatch({systemPrompt: "s", userPrompt: "two"});
	while (!fetchSignal) await new Promise(resolve => setImmediate(resolve));
	owner.abortAll("plugin-stopped");
	assert.equal((await first).reason, "cancelled");
	assert.equal((await queued).reason, "cancelled");
	assert.equal(fetchCount, 1);
	assert.equal(session.snapshot().cancelled, true);
});
