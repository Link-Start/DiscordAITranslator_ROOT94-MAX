const test = require("node:test");
const assert = require("node:assert/strict");
const {
	MAX_FAILED_SNAPSHOT_CHANNELS,
	MAX_FAILED_SNAPSHOT_ITEMS_PER_CHANNEL,
	createHistoricalJobRegistry
} = require("../src/orchestrator/historical-job-registry");

test("a queue is created on demand and only when asked for", () => {
	const registry = createHistoricalJobRegistry();

	assert.equal(registry.getQueue("c1", false), null, "asking about an unknown channel must not allocate");
	assert.equal(registry.hasQueue("c1"), false);

	const entry = registry.getQueue("c1");
	assert.equal(entry.channelId, "c1");
	assert.deepEqual(entry.jobs, []);
	assert.equal(registry.getQueue("c1"), entry, "the same entry is returned on re-entry");
	assert.equal(registry.hasQueue("c1"), true);
});

test("a superseded queue entry is no longer current", () => {
	const registry = createHistoricalJobRegistry();
	const first = registry.getQueue("c1");

	assert.equal(registry.isCurrentQueue("c1", first), true);
	registry.deleteQueue("c1");
	assert.equal(registry.isCurrentQueue("c1", first), false, "a deleted entry must not pass the currency check");

	const second = registry.getQueue("c1");
	assert.notEqual(second, first);
	assert.equal(registry.isCurrentQueue("c1", first), false, "a replaced entry stays stale");
	assert.equal(registry.isCurrentQueue("c1", second), true);
});

test("job ids are unique per registry and carry their channel", () => {
	const registry = createHistoricalJobRegistry();

	const first = registry.nextJobId("c1");
	const second = registry.nextJobId("c1");
	const other = registry.nextJobId("c2");

	assert.match(first, /^c1:\d+$/);
	assert.notEqual(first, second);
	assert.match(other, /^c2:\d+$/);
	assert.equal(new Set([first, second, other]).size, 3);
});

test("advancing the runtime generation is how a bulk cancel makes jobs stale", () => {
	const registry = createHistoricalJobRegistry();
	const before = registry.getRuntimeGeneration();

	assert.equal(registry.advanceRuntimeGeneration(), before + 1);
	assert.equal(registry.getRuntimeGeneration(), before + 1);
});

test("failed snapshots are channel scoped and independently clearable", () => {
	const registry = createHistoricalJobRegistry();
	registry.setFailedSnapshot("c1", {channelId: "c1", items: [{id: "m1"}], updatedAt: 1});
	registry.setFailedSnapshot("c2", {channelId: "c2", items: [{id: "m2"}], updatedAt: 2});

	assert.equal(registry.getFailedSnapshot("c1").items.length, 1);
	assert.equal(registry.deleteFailedSnapshot("c1"), true);
	assert.equal(registry.getFailedSnapshot("c1"), null);
	assert.equal(registry.getFailedSnapshot("c2").items.length, 1, "other channels are untouched");

	registry.clearFailedSnapshots();
	assert.equal(registry.getFailedSnapshot("c2"), null);
});

test("a matching failed message stays parked until its configuration or retry intent changes", () => {
	const registry = createHistoricalJobRegistry();
	registry.setFailedSnapshot("c1", {
		channelId: "c1",
		items: [
			{message: {id: "m1"}, signature: "sig-a"},
			{message: {id: "legacy"}}
		]
	});

	assert.equal(registry.hasFailedMessage("c1", "m1", "sig-a"), true);
	assert.equal(registry.hasFailedMessage("c1", "m1", "sig-b"), false, "an edited or reconfigured message may enter as new work");
	assert.equal(registry.hasFailedMessage("c1", "legacy", "any"), true, "a legacy snapshot without a signature remains parked");
	assert.equal(registry.hasFailedMessage("c2", "m1", "sig-a"), false);
	assert.equal(registry.hasFailedMessage("c1", "missing", "sig-a"), false);
});

test("listQueues sees every live channel and clearQueues empties them", () => {
	const registry = createHistoricalJobRegistry();
	registry.getQueue("c1");
	registry.getQueue("c2");

	assert.deepEqual(registry.listQueues().map(entry => entry.channelId).sort(), ["c1", "c2"]);
	registry.clearQueues();
	assert.deepEqual(registry.listQueues(), []);
});

test("failed snapshot retention is explicitly bounded by channel and item count", () => {
	assert.equal(MAX_FAILED_SNAPSHOT_CHANNELS, 32);
	assert.equal(MAX_FAILED_SNAPSHOT_ITEMS_PER_CHANNEL, 200);
	const registry = createHistoricalJobRegistry({maxFailedSnapshotChannels: 3, maxFailedSnapshotItemsPerChannel: 2});
	const oversized = {
		channelId: "c1",
		items: ["m1", "m2", "m3", "m4"].map(id => ({message: {id}})),
		updatedAt: 1
	};

	const stored = registry.setFailedSnapshot("c1", oversized);
	assert.deepEqual(stored.items.map(item => item.message.id), ["m3", "m4"], "only the newest retryable items survive");
	assert.equal(oversized.items.length, 4, "bounding does not mutate the caller's snapshot");
	registry.setFailedSnapshot("c2", {channelId: "c2", items: []});
	registry.setFailedSnapshot("c3", {channelId: "c3", items: []});
	registry.setFailedSnapshot("c4", {channelId: "c4", items: []});

	assert.equal(registry.getFailedSnapshot("c1"), null, "the oldest untouched channel is retired");
	assert.ok(registry.getFailedSnapshot("c2"));
	assert.ok(registry.getFailedSnapshot("c3"));
	assert.ok(registry.getFailedSnapshot("c4"));
});

test("reading and replacing a failed snapshot protects the active channel from LRU eviction", () => {
	const registry = createHistoricalJobRegistry({maxFailedSnapshotChannels: 2});
	registry.setFailedSnapshot("c1", {channelId: "c1", items: [{message: {id: "m1"}}]});
	registry.setFailedSnapshot("c2", {channelId: "c2", items: [{message: {id: "m2"}}]});
	assert.ok(registry.getFailedSnapshot("c1"), "a read refreshes active-channel recency");
	registry.setFailedSnapshot("c3", {channelId: "c3", items: [{message: {id: "m3"}}]});

	assert.equal(registry.getFailedSnapshot("c2"), null);
	assert.ok(registry.getFailedSnapshot("c1"));
	registry.setFailedSnapshot("c1", {channelId: "c1", items: [{message: {id: "replacement"}}]});
	registry.setFailedSnapshot("c4", {channelId: "c4", items: []});
	assert.equal(registry.getFailedSnapshot("c3"), null, "replacement writes also refresh recency");
	assert.equal(registry.getFailedSnapshot("c1").items[0].message.id, "replacement");
});

test("the default failed-snapshot channel cap holds under a long-session stress sequence", () => {
	const registry = createHistoricalJobRegistry();
	for (let index = 0; index < MAX_FAILED_SNAPSHOT_CHANNELS + 25; index++) {
		registry.setFailedSnapshot(`c${index}`, {channelId: `c${index}`, items: [{message: {id: `m${index}`}}]});
	}

	for (let index = 0; index < 25; index++) assert.equal(registry.getFailedSnapshot(`c${index}`), null);
	for (let index = 25; index < MAX_FAILED_SNAPSHOT_CHANNELS + 25; index++) assert.ok(registry.getFailedSnapshot(`c${index}`));
});
