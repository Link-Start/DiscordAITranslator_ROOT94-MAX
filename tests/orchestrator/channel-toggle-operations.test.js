const test = require("node:test");
const assert = require("node:assert/strict");
const {createChannelToggleOperations} = require("../../src/orchestrator/channel-toggle-operations");

test("a newer toggle supersedes only the older operation in the same channel", () => {
	const operations = createChannelToggleOperations();
	const first = operations.begin("c1");
	const otherChannel = operations.begin("c2");
	const second = operations.begin("c1");

	assert.equal(operations.isCurrent("c1", first), false);
	assert.equal(operations.isCurrent("c1", second), true);
	assert.equal(operations.isCurrent("c2", otherChannel), true);
});

test("reset invalidates every outstanding toggle operation", () => {
	const operations = createChannelToggleOperations();
	const operation = operations.begin("c1");

	operations.reset();

	assert.equal(operations.isCurrent("c1", operation), false);
});
