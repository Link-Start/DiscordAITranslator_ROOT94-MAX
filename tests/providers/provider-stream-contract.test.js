const test = require("node:test");
const assert = require("node:assert/strict");
const {
	PROVIDER_STREAM_EVENT_TYPES,
	createProviderStreamChunk,
	createProviderStreamFinal,
	createProviderStreamError,
	isProviderStreamEvent
} = require("../../src/providers/provider-stream-contract");

test("stream contract creates exact frozen chunk final and error events", () => {
	const chunk = createProviderStreamChunk({attemptId: "a1", text: "译"});
	const final = createProviderStreamFinal({attemptId: "a1", text: "译文", usage: {output_tokens: 2}, finishReason: "stop", streamed: true});
	const error = createProviderStreamError({attemptId: "a2", errorKind: "http", httpStatus: 422, hadText: true, streamUnsupported: true});
	assert.deepEqual(chunk, {type: "chunk", attemptId: "a1", text: "译"});
	assert.equal(final.type, PROVIDER_STREAM_EVENT_TYPES.FINAL);
	assert.equal(final.usage.output_tokens, 2);
	assert.equal(Object.isFrozen(final.usage), true);
	assert.deepEqual(error, {type: "error", attemptId: "a2", errorKind: "http", httpStatus: 422, hadText: true, streamUnsupported: true});
	for (const event of [chunk, final, error]) {
		assert.equal(Object.isFrozen(event), true);
		assert.equal(isProviderStreamEvent(event), true);
	}
});

test("stream contract rejects empty chunks unknown errors and missing attempt identity", () => {
	assert.throws(() => createProviderStreamChunk({attemptId: "a", text: "  "}), /non-empty/);
	assert.throws(() => createProviderStreamChunk({attemptId: "", text: "x"}), /attemptId/);
	assert.throws(() => createProviderStreamError({attemptId: "a", errorKind: "mystery"}), /unknown/);
	assert.equal(isProviderStreamEvent({type: "chunk", attemptId: "a", text: "x"}), false, "unfrozen caller objects are not contract events");
});
