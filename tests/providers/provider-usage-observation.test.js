const test = require("node:test");
const assert = require("node:assert/strict");

const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
const {createProviderClient} = require("../../src/providers/provider-client");

const LANE_BY_KIND = Object.freeze({
	manual: "manual",
	live: "live-burst",
	historical: "history-primary"
});

function createProviderHarness(kind) {
	let clock = 1000;
	let pending = null;
	const recorded = [];
	const store = createProviderLatencyStore({now: () => clock});
	const client = createProviderClient({
		request: (url, options, callback) => {
			pending = {url, options, callback};
			return {abort() {}};
		},
		setTimeout: () => ({fixture: "timeout"}),
		clearTimeout: () => {},
		sleep: () => Promise.resolve(),
		now: () => (clock += 5),
		getAuthKeys: () => ({
			oaicompat: {
				key: "fixture-key",
				endpoint: "https://fixture.invalid/v1/chat/completions",
				model: "fixture-model",
				interfaceFormat: "openai_chat",
				reasoningMode: "follow",
				reasoningProfile: "openai"
			}
		}),
		getLanguages: () => ({}),
		getLabels: () => ({}),
		getCustomText: key => key,
		getEngineLabel: key => key,
		beginLatencyRequest: options => store.beginLatencyRequest(options),
		recordLatencyEvent: event => {
			const value = store.recordLatencyEvent(event);
			if (value) recorded.push(value);
			return value;
		},
		isLiveStreamingEnabled: () => false
	});
	const token = store.beginLatencyRequest({
		kind,
		lane: LANE_BY_KIND[kind],
		queueWaitMs: 4,
		messageCount: 1
	});
	return {
		store,
		client,
		recorded,
		token,
		respond(body) {
			assert.ok(pending, `${kind} provider request was not dispatched`);
			pending.callback(null, {statusCode: 200, headers: {}}, JSON.stringify(body));
		}
	};
}

async function settleLane(kind, usage) {
	const harness = createProviderHarness(kind);
	const result = new Promise(resolve => harness.client.openAiCompatibleTranslate({
		input: {id: "en", name: "English", auto: false},
		output: {id: "zh-CN", name: "Chinese", auto: false},
		text: "Provider usage fixture",
		autoDecision: false,
		engine: {id: "oaicompat"},
		silent: true,
		timingContext: {
			token: harness.token,
			role: "primary",
			engineKey: "oaicompat",
			engineFamily: "custom",
			lane: LANE_BY_KIND[kind],
			messageCount: 1
		}
	}, resolve));
	harness.respond({
		choices: [{message: {content: "译文"}, finish_reason: "stop"}],
		...(usage === undefined ? {} : {usage})
	});
	assert.equal(await result, "译文", `${kind} translation fixture must still complete`);
	assert.equal(harness.recorded.length, 1, `${kind} must settle exactly one physical attempt`);
	return harness.recorded[0];
}

test("W0 manual/live/history settles authoritative provider usage into the existing attempt owner", async () => {
	const fixtures = [
		["manual", {prompt_tokens: 101, completion_tokens: 31, completion_tokens_details: {reasoning_tokens: 7}}],
		["live", {prompt_tokens: 202, completion_tokens: 42, completion_tokens_details: {reasoning_tokens: 0}}],
		["historical", {prompt_tokens: 303, completion_tokens: 53, completion_tokens_details: {reasoning_tokens: 11}}]
	];
	for (const [kind, usage] of fixtures) {
		const attempt = await settleLane(kind, usage);
		assert.deepEqual({
			promptTokens: attempt.promptTokens,
			completionTokens: attempt.completionTokens,
			reasoningTokens: attempt.reasoningTokens
		}, {
			promptTokens: usage.prompt_tokens,
			completionTokens: usage.completion_tokens,
			reasoningTokens: usage.completion_tokens_details.reasoning_tokens
		}, `${kind} lost authoritative usage before provider-latency-store settle`);
	}
});

test("W0 missing provider usage stays explicit null for every production lane", async () => {
	for (const kind of ["manual", "live", "historical"]) {
		const attempt = await settleLane(kind, undefined);
		assert.deepEqual(
			[attempt.promptTokens, attempt.completionTokens, attempt.reasoningTokens],
			[null, null, null],
			`${kind} must not replace missing provider usage with estimates or zero`
		);
		assert.equal(Object.prototype.hasOwnProperty.call(attempt, "estimatedTokens"), false);
	}
});
