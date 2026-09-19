const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("../helpers/createPluginInstance");
const {createProviderCompatibilityBudget} = require("../../src/providers/provider-attempt-owner");

function streamReader(text) {
	const parts = [
		new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: text}, finish_reason: "stop"}], usage: {prompt_tokens: 9, completion_tokens: 4, completion_tokens_details: {reasoning_tokens: 0}}})}\n\n`),
		new TextEncoder().encode("data: [DONE]\n\n")
	];
	let index = 0;
	return {
		read: async () => index < parts.length ? {done: false, value: parts[index++]} : {done: true, value: undefined},
		cancel: () => Promise.resolve()
	};
}

test("built plugin routes one live OpenAI Chat message through BdApi SSE and finishes once", async () => {
	const previousBdApi = globalThis.BdApi;
	let fetchOptions = null;
	let callbackRequests = 0;
	const fetch = (_url, options) => {
		fetchOptions = options;
		return Promise.resolve({
			status: 200,
			headers: {get: name => name.toLowerCase() === "content-type" ? "text/event-stream" : null},
			body: {getReader: () => streamReader("组合根流式")},
			text: () => Promise.resolve("")
		});
	};
	try {
		const plugin = createPluginInstance({
			callSetLanguages: false,
			bdfdb: {LibraryRequires: {request: () => {callbackRequests++;}}},
			settings: {engines: {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Fixture"}]}}
		});
		globalThis.BdApi.Net = {fetch};
		plugin.setLanguages();
		const settings = plugin.ensureSettingsStore();
		for (const [field, value] of Object.entries({key: "fixture-key", endpoint: "https://fixture.test/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat"})) settings.setCredentialField("oaicompat", field, value);
		const requestContext = Object.freeze({logicalRequestId: "live-built-1", signal: null, isCurrent: () => true, compatibilityBudget: createProviderCompatibilityBudget()});
		const token = plugin.ensureProviderClient().beginLatencyRequest({kind: "live", messageCount: 1, inputChars: 5});
		let callbackCount = 0;
		const translated = await new Promise(resolve => plugin.openAiCompatibleTranslate({
			input: {id: "en", name: "English"},
			output: {id: "zh-CN", name: "Chinese"},
			text: "hello",
			specialCase: null,
			autoDecision: false,
			engine: {id: "oaicompat"},
			requestContext,
			timingContext: {token, role: "primary", engineKey: "oaicompat", messageCount: 1, requestContext}
		}, value => {callbackCount++; resolve(value);}));

		assert.equal(translated, "组合根流式");
		assert.equal(callbackCount, 1);
		assert.equal(callbackRequests, 0);
		assert.equal(JSON.parse(fetchOptions.body).stream, true);
		assert.equal(fetchOptions.timeout, 0);
		assert.ok(fetchOptions.signal);
		assert.equal(plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
		assert.equal(plugin.ensureProviderClient().getLatencySnapshot().streamAttemptCount, 1);
		assert.deepEqual([plugin.ensureProviderClient().getLatencySnapshot().latestTranslation.promptTokens, plugin.ensureProviderClient().getLatencySnapshot().latestTranslation.completionTokens, plugin.ensureProviderClient().getLatencySnapshot().latestTranslation.reasoningTokens], [9, 4, 0]);
	}
	finally {
		if (previousBdApi === undefined) delete globalThis.BdApi;
		else globalThis.BdApi = previousBdApi;
	}
});

test("built live pipeline aborts the physical SSE reader when its request is invalidated", async () => {
	const previousBdApi = globalThis.BdApi;
	let physicalSignal = null;
	let cancelCount = 0;
	let rejectRead = null;
	try {
		const plugin = createPluginInstance({
			callSetLanguages: false,
			isTranslationEnabled: () => true,
			settings: {engines: {translator: "oaicompat", backup: "----", customProviders: [{id: "oaicompat", name: "Fixture"}]}}
		});
		globalThis.BdApi.Net = {fetch: (_url, options) => {
			physicalSignal = options.signal;
			const reader = {
				read: () => new Promise((_resolve, reject) => {rejectRead = reject;}),
				cancel() {cancelCount++; if (rejectRead) rejectRead(new Error("cancelled")); return Promise.resolve();}
			};
			return Promise.resolve({status: 200, headers: {get: () => "text/event-stream"}, body: {getReader: () => reader}, text: () => Promise.resolve("")});
		}};
		plugin.setLanguages();
		const settings = plugin.ensureSettingsStore();
		for (const [field, value] of Object.entries({key: "fixture-key", endpoint: "https://fixture.test/v1/chat/completions", model: "fixture-model", interfaceFormat: "openai_chat"})) settings.setCredentialField("oaicompat", field, value);
		plugin.shouldSkipReceivedTranslationBeforeRequest = () => false;
		plugin.getCachedReceivedTranslation = () => null;
		const channel = {id: "channel-stream-cancel"};
		const message = {id: "message-stream-cancel", channel_id: channel.id, content: "hello", embeds: [], attachments: [], author: {id: "role-fixture"}};
		const originalContentData = {content: message.content, embeds: []};
		const signature = plugin.createReceivedTranslationSignature(message, channel.id, originalContentData);
		const liveRequest = plugin.createLiveTranslationRequest(message, channel.id, originalContentData, signature);
		const pending = plugin.translateMessage(message, channel, {auto: true, silent: true, trackBusy: false, originalContentData, liveRequest});
		for (let index = 0; index < 10 && !rejectRead; index++) await new Promise(resolve => setImmediate(resolve));
		assert.ok(physicalSignal);
		assert.equal(typeof rejectRead, "function");
		plugin.invalidateLiveTranslationRequests(channel.id);
		assert.equal(await pending, false);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(physicalSignal.aborted, true);
		assert.equal(cancelCount, 1);
		assert.equal(plugin.ensureProviderClient().getProviderAttemptSnapshot().active, 0);
	}
	finally {
		if (previousBdApi === undefined) delete globalThis.BdApi;
		else globalThis.BdApi = previousBdApi;
	}
});
