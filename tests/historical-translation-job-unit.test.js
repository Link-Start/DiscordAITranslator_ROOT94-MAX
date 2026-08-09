const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HistoricalTranslationJob,
	HISTORICAL_TERMINAL_ITEM_STATES,
	HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX
} = require("../src/orchestrator/historical-translation-job");

// Unit-level coverage of the job class itself. tests/historical-translation-job.test.js
// drives the same class through a built plugin instance; everything here builds fakes
// instead, so a failure points at the state machine rather than at the runtime.

function createMessage(id, content = `body-${id}`) {
	return {id, channel_id: "channel-1", content};
}

// Lets a test hold a dependency call open and settle it at a chosen point, which is how
// "a result that lands after a cancel" is expressed without timers.
function createDeferred() {
	const deferred = {};
	deferred.promise = new Promise((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	return deferred;
}

// The job awaits its dependencies, so several macrotask turns can be needed before it
// parks on the call a test wants to interfere with.
async function settle(turns = 4) {
	for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
}

function statusOf(job, messageId) {
	const record = job.items.get(String(messageId));
	return record ? record.status : null;
}

function summaryIds(bucket) {
	return bucket.map(item => item.message.id);
}

test("terminal item states are the ones a record can never leave", () => {
	assert.deepEqual([...HISTORICAL_TERMINAL_ITEM_STATES].sort(), ["cancelled", "failed", "skipped", "translated"]);
	assert.equal(HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX, 100);
});

test("collecting accepts raw messages and wrappers, dedupes, and stops at the seal", () => {
	const stateChanges = [];
	const job = new HistoricalTranslationJob({
		id: "job-collect",
		channelId: "channel-1",
		dependencies: {onStateChange: instance => stateChanges.push(instance.state)}
	});

	assert.equal(job.add(createMessage("1")), true, "a bare message is wrapped into a source record");
	assert.equal(job.add({message: createMessage("2"), extra: true}), true, "an already wrapped source is taken as is");
	assert.equal(job.add(createMessage("1")), false, "the same message id may not be collected twice");
	assert.equal(job.add(null), false);
	assert.equal(job.add({message: {}}), false, "a message without an id is not addressable");
	assert.equal(job.items.size, 2);
	assert.equal(job.items.get("2").source.extra, true, "the caller's source object is preserved for the summary");

	assert.equal(job.seal(), true);
	assert.equal(job.seal(), false, "sealing twice is not a state change");
	assert.equal(job.add(createMessage("3")), false, "a sealed job is closed to new messages");
	assert.equal(stateChanges.length, 3, "one notification per accepted message plus the seal");
});

test("records reach every terminal state through their own pipeline stage", async () => {
	const job = new HistoricalTranslationJob({
		id: "job-states",
		channelId: "channel-1",
		generation: 7,
		dependencies: {
			prepare: source => {
				const id = source.message.id;
				if (id == "skip") return {status: "skipped", reason: "same-language"};
				if (id == "dead") return {status: "failed", reason: "no-content"};
				if (id == "early") return {status: "translated", translation: "cached"};
				return {status: "pending", prepared: source};
			},
			translateBatch: prepared => Promise.resolve(prepared.some(item => item.message.id == "batch") ? {batch: "from-batch"} : null),
			validate: (prepared, rawTranslation) => rawTranslation == null ? {ok: false} : {ok: true, translation: rawTranslation},
			repairBatch: null,
			repair: prepared => Promise.resolve(prepared.message.id == "repaired" ? {status: "translated", translation: "from-repair"} : {status: "failed", reason: "unresolved"})
		}
	});

	for (const id of ["skip", "dead", "early", "batch", "repaired", "lost"]) job.add(createMessage(id));
	const summary = await job.start();

	assert.equal(statusOf(job, "skip"), "skipped");
	assert.equal(statusOf(job, "dead"), "failed");
	assert.equal(statusOf(job, "early"), "translated", "prepare may resolve an item outright");
	assert.equal(statusOf(job, "batch"), "translated");
	assert.equal(statusOf(job, "repaired"), "translated", "per-item repair is the last chance to succeed");
	assert.equal(statusOf(job, "lost"), "failed");

	assert.deepEqual(summaryIds(summary.translated).sort(), ["batch", "early", "repaired"]);
	assert.deepEqual(summaryIds(summary.skipped), ["skip"]);
	assert.deepEqual(summaryIds(summary.failed).sort(), ["dead", "lost"]);
	assert.equal(summary.jobId, "job-states");
	assert.equal(summary.generation, 7);
	assert.equal(job.state, "committed");

	for (const id of ["skip", "dead", "early", "batch", "repaired", "lost"]) {
		assert.equal(job.isMessagePending(id), false, `${id} settled, so it is no longer pending`);
	}
	assert.equal(job.isMessagePending("never-collected"), false);
});

test("a thrown prepare and a non-terminal repair both land on failed", async () => {
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => {
				if (source.message.id == "boom") throw new Error("prepare exploded");
				return {status: "pending", prepared: source};
			},
			translateBatch: () => Promise.resolve(null),
			validate: () => ({ok: false}),
			// A repair that answers with a non-terminal status would otherwise leave the
			// record stuck in "repairing" and the summary would silently drop it.
			repair: () => Promise.resolve({status: "pending", prepared: null})
		}
	});

	job.add(createMessage("boom"));
	job.add(createMessage("limp"));
	const summary = await job.start();

	assert.equal(statusOf(job, "boom"), "failed");
	assert.equal(job.items.get("boom").reason, "prepare_failed");
	assert.equal(statusOf(job, "limp"), "failed");
	assert.equal(job.items.get("limp").reason, "repair_failed");
	assert.deepEqual(summaryIds(summary.failed).sort(), ["boom", "limp"]);
});

test("the whole snapshot is translated in a single batch call", async () => {
	const batchCalls = [];
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => source.message.id == "skip" ? {status: "skipped", reason: "same-language"} : {status: "pending", prepared: source},
			translateBatch: prepared => {
				batchCalls.push(prepared.map(item => item.message.id));
				return Promise.resolve(Object.fromEntries(prepared.map(item => [item.message.id, `t-${item.message.id}`])));
			},
			validate: (_prepared, rawTranslation) => rawTranslation == null ? {ok: false} : {ok: true, translation: rawTranslation}
		}
	});

	for (const id of ["1", "2", "skip", "3"]) job.add(createMessage(id));
	const summary = await job.start();

	assert.equal(batchCalls.length, 1, "one request for the snapshot, not one per message");
	assert.deepEqual(batchCalls[0], ["1", "2", "3"], "items prepare already resolved never reach the provider");
	assert.deepEqual(summaryIds(summary.translated), ["1", "2", "3"]);
});

test("an authentication batch failure is terminal and never enters repair", async () => {
	let batchCalls = 0;
	let repairBatchCalls = 0;
	let repairCalls = 0;
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => {batchCalls++; return Promise.resolve({translations: null, failureKind: "auth", statusCode: 401});},
			validate: () => ({ok: false}),
			repairBatch: () => {repairBatchCalls++; return Promise.resolve(null);},
			repair: () => {repairCalls++; return Promise.resolve({status: "failed"});}
		}
	});
	job.add(createMessage("a"));
	job.add(createMessage("b"));

	const summary = await job.start();

	assert.equal(batchCalls, 1);
	assert.equal(repairBatchCalls, 0);
	assert.equal(repairCalls, 0);
	assert.deepEqual(summaryIds(summary.failed), ["a", "b"]);
	assert.equal(job.items.get("a").reason, "provider_auth");
});

test("a transient historical batch gets one batch retry and no third per-item request", async () => {
	let batchCalls = 0;
	let repairBatchCalls = 0;
	let repairCalls = 0;
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => {batchCalls++; return Promise.resolve({translations: null, failureKind: "transient", statusCode: 503});},
			validate: () => ({ok: false}),
			repairBatch: () => {repairBatchCalls++; return Promise.resolve({translations: null, failureKind: "transient", statusCode: 503});},
			repair: () => {repairCalls++; return Promise.resolve({status: "failed"});}
		}
	});
	job.add(createMessage("a"));
	job.add(createMessage("b"));

	const summary = await job.start();

	assert.equal(batchCalls, 1);
	assert.equal(repairBatchCalls, 1);
	assert.equal(repairCalls, 0);
	assert.deepEqual(summaryIds(summary.failed), ["a", "b"]);
	assert.equal(job.items.get("a").reason, "provider_transient");
});

test("repair batches are chunked by repairBatchSize, capped at half the translated set", async () => {
	async function runChunking(itemCount, repairBatchSize) {
		const chunkSizes = [];
		const job = new HistoricalTranslationJob({
			repairBatchSize,
			dependencies: {
				prepare: source => ({status: "pending", prepared: source}),
				translateBatch: () => Promise.resolve(null),
				validate: () => ({ok: false}),
				repairBatch: prepared => {
					chunkSizes.push(prepared.length);
					return Promise.resolve(null);
				},
				repair: () => Promise.resolve({status: "failed", reason: "unresolved"})
			}
		});
		for (let index = 0; index < itemCount; index++) job.add(createMessage(`m${index}`));
		await job.start();
		return chunkSizes;
	}

	// chunkSize = min(repairBatchSize, max(1, ceil(translating / 2))).
	assert.deepEqual(await runChunking(10, 3), [3, 3, 3, 1], "repairBatchSize is the binding limit here");
	assert.deepEqual(await runChunking(3, 10), [2, 1], "the half-the-batch cap binds when repairBatchSize is generous");
	assert.deepEqual(await runChunking(1, 10), [], "a lone unresolved item goes straight to per-item repair");
});

test("a repair batch resolves what it can and leaves the rest to per-item repair", async () => {
	const perItemRepairs = [];
	const job = new HistoricalTranslationJob({
		repairBatchSize: 10,
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => Promise.resolve(null),
			validate: (_prepared, rawTranslation) => rawTranslation == null ? {ok: false} : {ok: true, translation: rawTranslation},
			repairBatch: prepared => Promise.resolve(Object.fromEntries(prepared.filter(item => item.message.id == "a").map(item => [item.message.id, "batch-repaired"]))),
			repair: prepared => {
				perItemRepairs.push(prepared.message.id);
				return Promise.resolve({status: "skipped", reason: "gave-up"});
			}
		}
	});

	job.add(createMessage("a"));
	job.add(createMessage("b"));
	const summary = await job.start();

	assert.deepEqual(summaryIds(summary.translated), ["a"]);
	assert.deepEqual(perItemRepairs, ["b"], "an item the repair batch answered is not repaired again");
	assert.deepEqual(summaryIds(summary.skipped), ["b"]);
});

test("per-item repair never runs more calls at once than repairConcurrency", async () => {
	let inFlight = 0;
	let peakInFlight = 0;
	const job = new HistoricalTranslationJob({
		repairConcurrency: 2,
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => Promise.resolve(null),
			validate: () => ({ok: false}),
			repairBatch: null,
			repair: async () => {
				inFlight++;
				peakInFlight = Math.max(peakInFlight, inFlight);
				await settle(2);
				inFlight--;
				return {status: "failed", reason: "unresolved"};
			}
		}
	});

	for (let index = 0; index < 6; index++) job.add(createMessage(`m${index}`));
	await job.start();

	assert.equal(peakInFlight, 2, "the worker pool is exactly repairConcurrency wide");
	assert.equal(job.state, "committed");
});

test("constructor knobs are clamped to something usable", () => {
	const defaults = new HistoricalTranslationJob();
	assert.equal(defaults.repairConcurrency, 4);
	assert.equal(defaults.repairBatchSize, 10);
	assert.equal(defaults.state, "collecting");
	assert.equal(defaults.sealed, false);
	assert.match(defaults.id, /^historical-\d+$/);

	const clamped = new HistoricalTranslationJob({repairConcurrency: 0, repairBatchSize: -5});
	assert.equal(clamped.repairConcurrency, 4, "a falsy parse falls back to the default");
	assert.equal(clamped.repairBatchSize, 1, "a negative size is floored at one, never zero");
});

test("cancelling stamps every non-terminal record, keeps settled ones, and is one-way", async () => {
	const batch = createDeferred();
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => source.message.id == "done" ? {status: "skipped", reason: "same-language"} : {status: "pending", prepared: source},
			translateBatch: () => batch.promise,
			validate: () => ({ok: false}),
			repair: () => Promise.resolve({status: "failed", reason: "unresolved"})
		}
	});

	job.add(createMessage("done"));
	job.add(createMessage("open"));
	const running = job.start();
	await settle();

	assert.equal(job.cancel("channel-left"), true);
	assert.equal(job.state, "cancelled");
	assert.equal(job.cancelReason, "channel-left");
	assert.equal(statusOf(job, "open"), "cancelled");
	assert.equal(statusOf(job, "done"), "skipped", "cancel only rewrites records that had not settled");
	assert.equal(job.isMessagePending("open"), false);
	assert.equal(job.isMessagePending("done"), false, "no record of a cancelled job reads as pending");

	assert.equal(job.cancel("again"), false, "a second cancel is not a state change");
	assert.equal(job.cancelReason, "channel-left");
	assert.equal(job.invalidateMessage("open"), false, "a cancelled job takes no further record edits");

	batch.resolve(null);
	const summary = await running;
	assert.deepEqual(summary.translated, []);
	assert.deepEqual(summaryIds(summary.skipped), ["done"], "a decision reached before the cancel is still reported");
	assert.deepEqual(summary.failed, []);
});

test("a job cancelled before it starts commits nothing", async () => {
	let committed = null;
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: () => assert.fail("a cancelled record is never prepared"),
			commit: summary => {committed = summary;}
		}
	});

	job.add(createMessage("1"));
	job.add(createMessage("2"));
	assert.equal(job.cancel("channel-left"), true);

	// start() overwrites the job state, so the record-level stamp - not the job state -
	// is what keeps a cancelled snapshot from reaching the message list.
	const summary = await job.start();
	assert.deepEqual(summary.translated, []);
	assert.deepEqual(summary.skipped, []);
	assert.deepEqual(summary.failed, []);
	assert.equal(committed, summary, "the commit still runs, but there is nothing in it");
	assert.equal(statusOf(job, "1"), "cancelled");
	assert.equal(statusOf(job, "2"), "cancelled");
});

test("a batch result that lands after a cancel is ignored", async () => {
	const batch = createDeferred();
	let validateCalls = 0;
	let commitCalls = 0;
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => batch.promise,
			validate: (_prepared, rawTranslation) => {
				validateCalls++;
				return {ok: true, translation: rawTranslation};
			},
			repair: () => Promise.resolve({status: "failed", reason: "unresolved"}),
			commit: () => {commitCalls++;}
		}
	});

	job.add(createMessage("1"));
	job.add(createMessage("2"));
	const running = job.start();
	await settle();

	assert.equal(job.state, "translating");
	assert.equal(job.cancel("channel-left"), true);
	// The provider was already talking to us when the user left the channel.
	batch.resolve({1: "late-one", 2: "late-two"});
	const summary = await running;

	assert.equal(validateCalls, 0, "a cancelled job must not spend anything on a late result");
	assert.equal(commitCalls, 0);
	assert.equal(job.state, "cancelled");
	assert.deepEqual(summary.translated, [], "nothing from the late result reaches the message list");
	assert.equal(statusOf(job, "1"), "cancelled");
	assert.equal(statusOf(job, "2"), "cancelled");
});

test("a repair result that lands after a cancel cannot resurrect its record", async () => {
	const repair = createDeferred();
	const job = new HistoricalTranslationJob({
		repairConcurrency: 1,
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => Promise.resolve(null),
			validate: () => ({ok: false}),
			repairBatch: null,
			repair: () => repair.promise,
			commit: () => assert.fail("a cancelled job must never commit")
		}
	});

	job.add(createMessage("1"));
	job.add(createMessage("2"));
	const running = job.start();
	await settle();

	assert.equal(job.state, "repairing");
	job.cancel("plugin-stopped");
	repair.resolve({status: "translated", translation: "too-late"});
	const summary = await running;

	assert.equal(statusOf(job, "1"), "cancelled");
	assert.equal(statusOf(job, "2"), "cancelled");
	assert.deepEqual(summary.translated, []);
	assert.equal(job.state, "cancelled");
});

test("invalidating one message drops only its result, the rest of the job commits", async () => {
	const batch = createDeferred();
	let committed = null;
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => batch.promise,
			validate: (_prepared, rawTranslation) => rawTranslation == null ? {ok: false} : {ok: true, translation: rawTranslation},
			repair: () => Promise.resolve({status: "failed", reason: "unresolved"}),
			commit: summary => {committed = summary;}
		}
	});

	job.add(createMessage("keep"));
	job.add(createMessage("edited"));
	const running = job.start();
	await settle();

	// The user edited this message while its translation was in flight.
	assert.equal(job.invalidateMessage("edited"), true);
	assert.equal(statusOf(job, "edited"), "cancelled");
	assert.equal(job.items.get("edited").reason, "source-changed");
	assert.equal(job.invalidateMessage("edited"), false, "already invalidated");
	assert.equal(job.invalidateMessage("never-collected"), false);

	batch.resolve({keep: "kept", edited: "stale"});
	const summary = await running;

	assert.deepEqual(summaryIds(summary.translated), ["keep"]);
	assert.equal(summaryIds(summary.skipped).concat(summaryIds(summary.failed)).includes("edited"), false, "an invalidated message is reported nowhere");
	assert.equal(committed, summary);
	assert.equal(job.state, "committed");
});

test("a job that lost its generation while waiting cancels instead of committing", async () => {
	const order = [];
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: prepared => Promise.resolve(Object.fromEntries(prepared.map(item => [item.message.id, "ok"]))),
			validate: (_prepared, rawTranslation) => ({ok: true, translation: rawTranslation}),
			waitForCommit: () => {
				order.push("wait");
				return Promise.resolve();
			},
			// The channel moved on while this job was parked in waitForCommit.
			isCurrent: () => false,
			commit: () => order.push("commit")
		}
	});

	job.add(createMessage("1"));
	const summary = await job.start();

	assert.deepEqual(order, ["wait"], "a stale job may not commit");
	assert.equal(job.state, "cancelled");
	assert.equal(job.cancelReason, "stale_generation");
	// The record already reached "translated", so the returned summary still describes
	// it. Not calling commit is the whole protection - the caller must not treat a
	// returned summary as evidence that anything was applied.
	assert.deepEqual(summaryIds(summary.translated), ["1"]);
	assert.equal(statusOf(job, "1"), "translated");
});

test("start is idempotent and hands back the same run", async () => {
	let runs = 0;
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => {
				runs++;
				return {status: "skipped", reason: "same-language"};
			}
		}
	});

	job.add(createMessage("1"));
	const first = job.start();
	const second = job.start();
	assert.equal(job.sealed, true, "starting seals the job");
	assert.equal(job.add(createMessage("2")), false);

	const [firstSummary, secondSummary] = await Promise.all([first, second]);
	assert.equal(runs, 1, "the pipeline runs once no matter how often start is called");
	assert.equal(firstSummary, secondSummary);
	assert.equal(job.seal(), false, "sealing a started job is not a state change");
});

test("the acknowledged commit is the final historical side effect", async () => {
	const order = [];
	const job = new HistoricalTranslationJob({
		dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => Promise.resolve({m1: "translated"}),
			validate: (_prepared, translation) => ({ok: true, translation}),
			commit: () => order.push("commit"),
			rerender: () => {throw new Error("the display transaction already repainted");}
		}
	});
	job.add(createMessage("m1"));

	await job.start();

	assert.deepEqual(order, ["commit"]);
	assert.equal(job.state, "committed");
});
