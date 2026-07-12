const test = require("node:test");
const assert = require("node:assert/strict");
const {createPluginInstance} = require("./helpers/createPluginInstance");

function createMessage(id, content) {
	return {
		id,
		channel_id: "channel-history-job",
		content,
		embeds: [],
		author: {id: "other-user"}
	};
}

test("historical job commits all translated IDs atomically with one rerender", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const appliedIds = [];
	let rerenderCount = 0;
	let resolveBatch;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-1",
		channelId: "channel-history-job",
		generation: 1,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => new Promise(resolve => {
				resolveBatch = resolve;
			}),
			validate: (item, translatedText) => ({
				ok: true,
				translation: {messageId: item.message.id, translatedContent: translatedText}
			}),
			repair: () => ({status: "failed", reason: "unexpected-repair"}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: summary => {
				appliedIds.push(...summary.translated.map(item => item.message.id));
			},
			rerender: () => {
				rerenderCount++;
			}
		}
	});

	job.add(createMessage("100", "first"));
	job.add(createMessage("200", "second"));
	const running = job.start();
	await new Promise(resolve => setTimeout(resolve, 0));

	assert.deepEqual(appliedIds, []);
	assert.equal(rerenderCount, 0);
	assert.equal(job.isMessagePending("100"), true);
	assert.equal(job.isMessagePending("200"), true);

	resolveBatch({"100": "first translated", "200": "second translated"});
	await running;

	assert.deepEqual(appliedIds, ["100", "200"]);
	assert.equal(rerenderCount, 1);
	assert.equal(job.state, "committed");
});

test("historical job repairs missing IDs before the atomic commit", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	const repairIds = [];
	let committedSummary = null;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-repair",
		channelId: "channel-history-job",
		generation: 2,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => Promise.resolve({"100": "first translated"}),
			validate: (item, translatedText) => translatedText ? {
				ok: true,
				translation: {messageId: item.message.id, translatedContent: translatedText}
			} : {ok: false},
			repair: item => {
				repairIds.push(item.message.id);
				return Promise.resolve({
					status: "translated",
					translation: {messageId: item.message.id, translatedContent: "repaired translation"}
				});
			},
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: summary => {
				committedSummary = summary;
			},
			rerender: () => {}
		}
	});

	job.add(createMessage("100", "first"));
	job.add(createMessage("200", "second"));
	await job.start();

	assert.deepEqual(repairIds, ["200"]);
	assert.equal(committedSummary.translated.length, 2);
	assert.equal(committedSummary.failed.length, 0);
});

test("cancelled historical job ignores late provider results", async () => {
	const plugin = createPluginInstance({callSetLanguages: false});
	let resolveBatch;
	let commitCount = 0;
	let rerenderCount = 0;
	const job = plugin.createHistoricalTranslationJob({
		id: "job-cancel",
		channelId: "channel-history-job",
		generation: 3,
		dependencies: {
			prepare: item => ({status: "pending", prepared: item}),
			translateBatch: () => new Promise(resolve => {
				resolveBatch = resolve;
			}),
			validate: (_item, translatedText) => ({ok: true, translation: {translatedContent: translatedText}}),
			repair: () => ({status: "failed"}),
			waitForCommit: () => Promise.resolve(),
			isCurrent: () => true,
			commit: () => {
				commitCount++;
			},
			rerender: () => {
				rerenderCount++;
			}
		}
	});

	job.add(createMessage("100", "first"));
	const running = job.start();
	await new Promise(resolve => setTimeout(resolve, 0));
	job.cancel("channel-disabled");
	resolveBatch({"100": "late translation"});
	await running;

	assert.equal(job.state, "cancelled");
	assert.equal(commitCount, 0);
	assert.equal(rerenderCount, 0);
	assert.equal(job.isMessagePending("100"), false);
});
