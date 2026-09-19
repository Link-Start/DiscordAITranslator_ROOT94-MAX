const test = require("node:test");
const assert = require("node:assert/strict");
const {HistoricalTranslationJob} = require("../src/orchestrator/historical-translation-job");

function deferred() {
	let resolve;
	const promise = new Promise(done => {resolve = done;});
	return {promise, resolve};
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const ids = summary => summary.translated.map(item => item.message.id);

function createMixedJob(overrides = {}, cachedCount = 25) {
	const primary = deferred(), calls = [], progress = [], final = [];
	const job = new HistoricalTranslationJob({dependencies: {
		prepare: source => source.message.id.startsWith("cached-")
			? {status: "translated", translation: "已缓存的译文"}
			: {status: "pending", prepared: source},
		translateBatch: items => {calls.push(items.map(item => item.message.id)); return primary.promise;},
		commitProgress: summary => {progress.push(ids(summary)); return {committedIds: ids(summary)};},
		commit: summary => {final.push(ids(summary));},
		...overrides
	}});
	for (let index = 0; index < cachedCount; index++) job.add({message: {id: `cached-${index}`}});
	for (let index = 0; index < 3; index++) job.add({message: {id: `pending-${index}`}});
	return {job, primary, calls, progress, final};
}

const translations = {"pending-0": "译文一", "pending-1": "译文二", "pending-2": "译文三"};

test("a mixed historical job displays its 25 cached rows while the three-row provider request is pending", async () => {
	const h = createMixedJob();
	const running = h.job.start();
	try {
		await flush();
		assert.deepEqual(h.calls, [["pending-0", "pending-1", "pending-2"]]);
		assert.equal(h.progress.length, 1, "cache hits should form one early display batch");
		assert.equal(h.progress[0].length, 25);
		assert.equal(h.job.progressCommittedIds.size, 25);
		assert.deepEqual(h.final, [], "the provider work is still pending");
	}
	finally {h.primary.resolve(translations); await running;}
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.progress.map(batch => batch.length), [25, 3]);
	assert.equal(h.final[0].length, 28);
});

test("a pending cached display acknowledgement never delays provider dispatch or overlaps another display batch", async () => {
	const ack = deferred(), progress = [];
	const h = createMixedJob({commitProgress: summary => {
		progress.push(summary);
		return progress.length === 1 ? ack.promise : {committedIds: ids(summary)};
	}});
	const running = h.job.start();
	try {
		await flush();
		assert.equal(h.calls.length, 1);
		assert.equal(progress.length, 1);
		h.primary.resolve(translations);
		await flush();
		assert.equal(progress.length, 1, "display acknowledgements remain serialized");
		assert.equal(h.final.length, 0);
	}
	finally {ack.resolve({committedIds: progress[0] ? ids(progress[0]) : []}); h.primary.resolve(translations); await running;}
	assert.equal(progress.length, 2);
	assert.equal(h.calls.length, 1);
});

for (const mode of ["cancel", "edit", "stale"]) test(`cached progress rejects a late acknowledgement after ${mode}`, async () => {
	const ack = deferred(); let proposal, current = true;
	const h = createMixedJob({isCurrent: () => current, commitProgress: summary => {proposal = summary; return ack.promise;}}, 1);
	const running = h.job.start();
	try {
		await flush();
		assert.ok(proposal);
		if (mode === "cancel") h.job.cancel("channel-left");
		if (mode === "edit") h.job.invalidateMessage("cached-0", "source-edited");
		if (mode === "stale") current = false;
		assert.equal(proposal.isCurrent(), false);
	}
	finally {ack.resolve({committedIds: ["cached-0"]}); h.primary.resolve(translations); await running;}
	assert.equal(h.job.progressCommittedIds.has("cached-0"), false);
});

test("a rejected early cache commit remains in the final commit without another request", async () => {
	const h = createMixedJob({commitProgress: () => {throw new Error("display unavailable");}}, 1);
	const running = h.job.start();
	await flush();
	h.primary.resolve(translations);
	await running;
	assert.equal(h.calls.length, 1);
	assert.equal(h.job.progressCommittedIds.size, 0);
	assert.deepEqual(h.final, [["cached-0", "pending-0", "pending-1", "pending-2"]]);
});

test("the historical single-commit mode still waits and never calls the progress sink", async () => {
	const h = createMixedJob({commitProgress: null}, 1);
	const running = h.job.start();
	await flush();
	assert.deepEqual(h.final, []);
	h.primary.resolve(translations);
	await running;
	assert.deepEqual(h.progress, []);
	assert.equal(h.final.length, 1);
	assert.equal(h.calls.length, 1);
});
