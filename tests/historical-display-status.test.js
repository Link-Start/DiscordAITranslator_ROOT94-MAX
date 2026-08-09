const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

function translatedItem(messageId) {
	return {
		message: {id: messageId, channel_id: "c1", content: `source ${messageId}`, embeds: []},
		originalContentData: {content: `source ${messageId}`, embeds: []},
		translation: {content: `translation ${messageId}`, signature: `sig-${messageId}`}
	};
}

test("a historical commit keeps unconfirmed mounted rows pending and schedules targeted display retries", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const scheduled = [];
	plugin.isHistoricalTranslationJobCurrent = () => true;
	plugin.isHistoricalTranslationJobItemCurrent = () => true;
	plugin.getReceivedDisplayCommitGeneration = () => 1;
	plugin.getReceivedDisplayRuntimeView = () => ({requestIdentity: null});
	plugin.refreshTranslationDisplay = translation => translation;
	plugin.persistTranslationCacheEntry = () => {};
	plugin.ensureLiveTranslationQueue = () => ({clearQueuedMessage: () => {}});
	plugin.commitHistoricalReceivedDisplayBatch = async () => ({
		confirmedIds: ["m1"],
		missingIds: ["m2"],
		retryIds: ["m2"],
		deferredIds: []
	});
	plugin.updateFailedHistoricalTranslationSnapshots = () => 0;
	plugin.scheduleReceivedDisplayFlush = (channelId, messageId, delay, trackingKey) => {scheduled.push([channelId, messageId, delay, trackingKey]);};

	const summary = {translated: [translatedItem("m1"), translatedItem("m2")], skipped: [], failed: []};
	const job = {id: "c1:job-1", channelId: "c1", items: new Map([["m1", {}], ["m2", {}]])};
	await plugin.commitHistoricalTranslationJob(summary, job);

	assert.deepEqual(scheduled, [["c1", "m2", null, "c1:job-1"]]);
	assert.equal(plugin.getLoadedAutoTranslationStatusText(), "1/2 · 1↻");
	assert.match(plugin.getLoadedAutoTranslationStatusDetailText(), /1 awaiting display/);
});
