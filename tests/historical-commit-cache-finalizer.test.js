const test = require("node:test");
const assert = require("node:assert/strict");
const {createHistoricalCommitCacheFinalizer} = require("../src/orchestrator/historical-commit-cache-finalizer");

function createHarness() {
	let jobCurrent = true;
	let currentMessage = {id: "m1", content: "source", embeds: []};
	let view = {messageId: "m1", generation: 1, sourceSignature: "c1:source", status: "translated", translation: {content: "译文", translatedContent: "译文"}};
	const cache = [];
	const skips = [];
	const plugin = {
		isHistoricalTranslationJobCurrent: () => jobCurrent,
		getReceivedDisplayRuntimeView: () => view,
		extractOriginalContentData: message => ({content: message.content, embeds: message.embeds || []}),
		createReceivedTranslationSignature: (message, channelId, data) => `${channelId}:${data.content}`,
		persistTranslationCacheEntry: (...args) => cache.push(args),
		persistReceivedSkipDecision: (...args) => skips.push(args),
		buildTranslationRequestText: data => data.content || ""
	};
	const finalizer = createHistoricalCommitCacheFinalizer({BDFDB: {LibraryStores: {MessageStore: {getMessage: () => currentMessage}}}});
	const record = {status: "translated"};
	const job = {channelId: "c1", items: new Map([["m1", record]])};
	const item = {message: {id: "m1", content: "source", embeds: []}, originalContentData: {content: "source", embeds: []}};
	const translation = {content: "译文", translatedContent: "译文"};
	const result = {messageId: "m1", generation: 1, sourceSignature: "c1:source", status: "translated", translation};
	return {finalizer, plugin, job, item, translation, result, cache, skips, setJobCurrent: value => {jobCurrent = value;}, setItemCurrent: value => {record.status = value ? "translated" : "cancelled";}, setMessage: value => {currentMessage = value;}, setView: value => {view = value;}};
}

test("only an atomically committed and still-current translation reaches cache", () => {
	const h = createHarness();
	assert.deepEqual(h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: {committedIds: ["m1"]}, entries: [{item: h.item, result: h.result, translation: h.translation}]}), {acceptedIds: ["m1"], supersededTranslatedIds: [], translated: 1, skipped: 0, rejected: 0});
	assert.deepEqual(h.cache, [["m1", "c1:source", h.translation]]);
});

test("rejected store result edited source stale view and stale job all write zero cache", () => {
	for (const mode of ["store-rejected", "edited", "view-replaced", "job-stale"]) {
		const h = createHarness();
		if (mode === "edited") h.setMessage({id: "m1", content: "edited", embeds: []});
		if (mode === "view-replaced") h.setView({...h.result, translation: {content: "live", translatedContent: "live"}});
		if (mode === "job-stale") h.setJobCurrent(false);
		const batchOutcome = mode === "store-rejected" ? {committedIds: [], rejectedIds: ["m1"]} : {committedIds: ["m1"]};
		h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome, entries: [{item: h.item, result: h.result, translation: h.translation}]});
		assert.equal(h.cache.length, 0, mode);
	}
});

test("skip decisions also wait for committed current store state", () => {
	const h = createHarness();
	const result = {...h.result, status: "skipped", translation: undefined};
	h.setView({messageId: "m1", generation: 1, sourceSignature: "c1:source", status: "skipped", translation: null});
	h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: {committedIds: ["m1"], confirmedIds: ["m1"]}, entries: [{item: h.item, result, reason: "local_guard"}]});
	assert.deepEqual(h.skips, [["m1", "c1:source", "local_guard", "source"]]);
});

test("confirmed-only or explicitly empty acknowledgement never writes translation cache", () => {
	for (const batchOutcome of [{confirmedIds: ["m1"]}, {committedIds: [], confirmedIds: ["m1"]}]) {
		const h = createHarness();
		const outcome = h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome, entries: [{item: h.item, result: h.result, translation: h.translation}]});
		assert.deepEqual(outcome.acceptedIds, []);
		assert.equal(h.cache.length, 0);
	}
});

test("a virtualized source absent from MessageStore remains cacheable while its job record is current", () => {
	const h = createHarness();
	h.setMessage(null);
	const outcome = h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: {committedIds: ["m1"], missingIds: ["m1"]}, entries: [{item: h.item, result: h.result, translation: h.translation}]});
	assert.deepEqual(outcome.acceptedIds, ["m1"]);
	assert.equal(h.cache.length, 1);
	h.setItemCurrent(false);
	assert.deepEqual(h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: {committedIds: ["m1"]}, entries: [{item: h.item, result: h.result, translation: h.translation}]}).acceptedIds, []);
});

test("failed results use the same store source and view fence without writing cache", () => {
	const h = createHarness();
	const result = {...h.result, status: "failed", translation: undefined};
	h.setView({messageId: "m1", generation: 1, sourceSignature: "c1:source", status: "failed", translation: null});
	assert.deepEqual(h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: {committedIds: ["m1"]}, entries: [{item: h.item, result}]}), {acceptedIds: ["m1"], supersededTranslatedIds: [], translated: 0, skipped: 0, rejected: 0});
	assert.equal(h.cache.length, 0);
	assert.equal(h.skips.length, 0);

	h.setItemCurrent(false);
	assert.deepEqual(h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: {committedIds: ["m1"]}, entries: [{item: h.item, result}]}), {acceptedIds: [], supersededTranslatedIds: [], translated: 0, skipped: 0, rejected: 1});
});

test("a current provider failure survives a render exception, but a same-source live success supersedes it", () => {
	const h = createHarness();
	const result = {...h.result, status: "failed", translation: undefined};
	h.setView(null);
	assert.deepEqual(h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: null, entries: [{item: h.item, result}]}).acceptedIds, ["m1"]);
	h.setView({messageId: "m1", generation: 1, sourceSignature: "c1:source", status: "translated", translated: true, translation: {content: "live", translatedContent: "live"}});
	const outcome = h.finalizer.finalize(h.plugin, {job: h.job, batchOutcome: null, entries: [{item: h.item, result}]});
	assert.deepEqual(outcome.acceptedIds, []);
	assert.deepEqual(outcome.supersededTranslatedIds, ["m1"]);
});
