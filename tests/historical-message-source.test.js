const test = require("node:test");
const assert = require("node:assert/strict");
const {createHistoricalMessageSource} = require("../src/received/historical-message-source");

function createMessage(id, content = `message-${id}`) {
	return {id: String(id), content, channel_id: "channel-1"};
}

function createChannelMessage(id, content, channelId, key = "channel_id") {
	return {id: String(id), content, [key]: channelId};
}

function createSource(overrides = {}) {
	return createHistoricalMessageSource({
		listCachedMessages: async () => [],
		prefetchMessages: async () => [],
		isEligible: () => true,
		toQueueItem: message => ({id: String(message.id), content: message.content}),
		isGenerationCurrent: () => true,
		...overrides
	});
}

test("build merges rendered and cached messages by id once, preserving newest-first order", async () => {
	const source = createSource({
		listCachedMessages: async () => [
			createMessage(250, "cached-250"),
			createMessage(200, "cached-200 duplicate"),
			createMessage(100, "cached-100")
		]
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 1,
		renderedMessages: [
			createMessage(300, "rendered-300"),
			createMessage(200, "rendered-200")
		],
		limit: 4
	});

	assert.deepEqual(result, {
		items: [
			{id: "300", content: "rendered-300"},
			{id: "250", content: "cached-250"},
			{id: "200", content: "rendered-200"},
			{id: "100", content: "cached-100"}
		],
		total: 4,
		prefetched: 0,
		cancelled: false
	});
});

test("build applies eligibility in newest-first order before enforcing the limit", async () => {
	const source = createSource({
		isEligible: message => message.content !== "skip"
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 1,
		renderedMessages: [
			createMessage(500, "skip"),
			createMessage(400, "keep-400"),
			createMessage(300, "keep-300"),
			createMessage(200, "keep-200")
		],
		limit: 2
	});

	assert.deepEqual(result.items, [
		{id: "400", content: "keep-400"},
		{id: "300", content: "keep-300"}
	]);
	assert.equal(result.total, 2);
	assert.equal(result.prefetched, 0);
	assert.equal(result.cancelled, false);
});

test("build enforces the configured limit even when more eligible messages are available", async () => {
	const source = createSource({
		listCachedMessages: async () => [createMessage(200, "cached-200")]
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 1,
		renderedMessages: [
			createMessage(500, "rendered-500"),
			createMessage(400, "rendered-400"),
			createMessage(300, "rendered-300")
		],
		limit: 2
	});

	assert.deepEqual(result.items, [
		{id: "500", content: "rendered-500"},
		{id: "400", content: "rendered-400"}
	]);
	assert.equal(result.total, 2);
	assert.equal(result.prefetched, 0);
});

test("build prefetches only the missing eligible quantity", async () => {
	const prefetchCalls = [];
	const source = createSource({
		listCachedMessages: async () => [
			createMessage(300, "skip"),
			createMessage(200, "cached-200")
		],
		prefetchMessages: async request => {
			prefetchCalls.push(request);
			return [
				createMessage(150, "prefetched-150"),
				createMessage(100, "prefetched-100"),
				createMessage(50, "prefetched-50 extra")
			];
		},
		isEligible: message => message.content !== "skip"
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 1,
		renderedMessages: [createMessage(400, "rendered-400")],
		limit: 4
	});

	assert.deepEqual(prefetchCalls, [{channelId: "channel-1", beforeMessageId: "200", limit: 2, signal: null}]);
	assert.deepEqual(result.items, [
		{id: "400", content: "rendered-400"},
		{id: "200", content: "cached-200"},
		{id: "150", content: "prefetched-150"},
		{id: "100", content: "prefetched-100"}
	]);
	assert.equal(result.total, 4);
	assert.equal(result.prefetched, 2);
	assert.equal(result.cancelled, false);
});

test("off-channel rendered cached and prefetched messages are excluded before the limit", async () => {
	const prefetchCalls = [];
	const source = createSource({
		listCachedMessages: async () => [
			createChannelMessage(350, "cached-other-channel", "channel-2"),
			createChannelMessage(250, "cached-250", "channel-1")
		],
		prefetchMessages: async request => {
			prefetchCalls.push(request);
			return [
				createChannelMessage(150, "prefetched-other-channel", "channel-2"),
				createChannelMessage(100, "prefetched-100", "channel-1", "channelId")
			];
		}
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 1,
		renderedMessages: [
			createChannelMessage(500, "rendered-other-channel", "channel-2"),
			createMessage(400, "rendered-400")
		],
		limit: 3
	});

	assert.deepEqual(prefetchCalls, [{channelId: "channel-1", beforeMessageId: "250", limit: 1, signal: null}]);
	assert.deepEqual(result, {
		items: [
			{id: "400", content: "rendered-400"},
			{id: "250", content: "cached-250"},
			{id: "100", content: "prefetched-100"}
		],
		total: 3,
		prefetched: 1,
		cancelled: false
	});
});

test("a prefetch failure seals the actual available eligible total", async () => {
	const source = createSource({
		listCachedMessages: async () => [
			createMessage(300, "skip"),
			createMessage(200, "cached-200")
		],
		prefetchMessages: async () => {
			throw new Error("prefetch failed");
		},
		isEligible: message => message.content !== "skip"
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 1,
		renderedMessages: [createMessage(400, "rendered-400")],
		limit: 4
	});

	assert.deepEqual(result, {
		items: [
			{id: "400", content: "rendered-400"},
			{id: "200", content: "cached-200"}
		],
		total: 2,
		prefetched: 0,
		cancelled: false
	});
});

test("a stale generation returns cancelled without publishing items", async () => {
	let generationChecks = 0;
	let prefetched = false;
	const source = createSource({
		listCachedMessages: async () => [createMessage(300, "cached-300")],
		prefetchMessages: async () => {
			prefetched = true;
			return [createMessage(200, "prefetched-200")];
		},
		isGenerationCurrent: () => {
			generationChecks += 1;
			return generationChecks < 2;
		}
	});

	const result = await source.build({
		channelId: "channel-1",
		generation: 7,
		renderedMessages: [createMessage(400, "rendered-400")],
		limit: 2
	});

	assert.deepEqual(result, {
		items: [],
		total: 0,
		prefetched: 0,
		cancelled: true
	});
	assert.equal(prefetched, false);
});
