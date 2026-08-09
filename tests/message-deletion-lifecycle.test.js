const test = require("node:test");
const assert = require("node:assert/strict");
const {createMessageDeletionLifecycle} = require("../src/lifecycle/message-deletion-lifecycle");

function createHarness() {
	const failedSnapshots = new Map();
	const jobsByChannel = new Map();
	const calls = {live: [], markers: [], cache: [], display: []};
	const lifecycle = createMessageDeletionLifecycle({
		removeLiveMessage: (messageId, channelId) => {calls.live.push([messageId, channelId]); return true;},
		getHistoricalQueue: channelId => jobsByChannel.get(channelId) || null,
		getFailedSnapshot: channelId => failedSnapshots.get(channelId) || null,
		setFailedSnapshot: (channelId, snapshot) => failedSnapshots.set(channelId, snapshot),
		deleteFailedSnapshot: channelId => failedSnapshots.delete(channelId),
		clearHistoricalMarker: (messageId, jobId) => calls.markers.push([messageId, jobId]),
		hasCachedTranslation: () => true,
		clearCachedTranslation: messageId => calls.cache.push(messageId),
		deleteDisplayMessage: (messageId, channelId) => {calls.display.push([messageId, channelId]); return Promise.resolve({deleted: true});}
	});
	return {lifecycle, failedSnapshots, jobsByChannel, calls};
}

test("the extracted deletion lifecycle owns historical cleanup and bulk action normalization", async () => {
	const harness = createHarness();
	const records = new Map([["m1", {status: "pending"}], ["m2", {status: "pending"}]]);
	const job = {
		id: "job-1",
		items: records,
		invalidateMessage(messageId, reason) {
			const record = records.get(messageId);
			if (!record) return false;
			record.status = "cancelled";
			record.reason = reason;
			return true;
		}
	};
	harness.jobsByChannel.set("c1", {jobs: [job]});
	harness.failedSnapshots.set("c1", {channelId: "c1", items: [{message: {id: "m1"}}, {message: {id: "m2"}}]});

	const outcomes = await harness.lifecycle.handleAction({type: "MESSAGE_DELETE_BULK", channel_id: "c1", message_ids: ["m1", "m2", "m2"]});

	assert.equal(outcomes.length, 2, "duplicate ids are normalized before cleanup");
	assert.equal(records.get("m1").reason, "source-deleted");
	assert.equal(records.get("m2").reason, "source-deleted");
	assert.equal(harness.failedSnapshots.has("c1"), false);
	assert.deepEqual(harness.calls.live, [["m1", "c1"], ["m2", "c1"]]);
	assert.deepEqual(harness.calls.markers, [["m1", "job-1"], ["m2", "job-1"]]);
	assert.deepEqual(harness.calls.cache, ["m1", "m2"]);
	assert.deepEqual(harness.calls.display, [["m1", "c1"], ["m2", "c1"]]);
	assert.equal(await harness.lifecycle.handleAction({type: "MESSAGE_CREATE", channelId: "c1", id: "m3"}), false);
});
