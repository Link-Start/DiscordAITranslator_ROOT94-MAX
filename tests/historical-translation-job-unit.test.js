const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HistoricalTranslationJob,
	HISTORICAL_TERMINAL_ITEM_STATES,
	HISTORICAL_AI_BATCH_ITEM_LIMIT_MAX
} = require("../src/orchestrator/historical-translation-job");

test("historical jobs retain the earliest seal time across merge and implicit start", async () => {
	const first = new HistoricalTranslationJob({now: () => 100});
	const second = new HistoricalTranslationJob({now: () => 60});
	first.add({message: {id: "first"}});
	second.add({message: {id: "second"}});
	assert.equal(first.seal(), true);
	assert.equal(second.seal(), true);
	assert.equal(first.sealedAt, 100);
	assert.deepEqual(first.absorb(second), ["second"]);
	assert.equal(first.sealedAt, 60);

	const implicit = new HistoricalTranslationJob({now: () => 200});
	await implicit.start();
	assert.equal(implicit.sealedAt, 200);
	const throwing = new HistoricalTranslationJob({now: () => {throw new Error("clock failed");}});
	assert.doesNotThrow(() => throwing.seal());
	assert.ok(Number.isFinite(throwing.sealedAt));
});

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

test("a job that becomes stale while commit awaits acknowledgement never publishes committed", async () => {
	const commit = createDeferred();
	let current = true;
	const job = new HistoricalTranslationJob({dependencies: {
		prepare: item => ({status: "translated", translation: item}),
		waitForCommit: () => Promise.resolve(),
		isCurrent: () => current,
		commit: () => commit.promise
	}});
	job.add(createMessage("late-commit"));
	const running = job.start();
	await settle();
	current = false;
	commit.resolve();
	await running;
	assert.equal(job.state, "cancelled");
	assert.equal(job.cancelReason, "stale_after_commit");
});

test("S3H repair stays inside original failed primary blocks and never replays a successful sibling", async () => {
	const repairCalls = [];
	const job = new HistoricalTranslationJob({
		repairBatchSize: 10,
		dependencies: {
			prepare: source => ({status: "pending", prepared: Object.assign({}, source, {protectedText: source.message.content})}),
			translateBatch: () => {
				const outcome = {translations: {ok: "translated-ok"}, failureKind: null, statusCode: 200};
				Object.defineProperty(outcome, "historicalFailureBlocks", {value: [{blockId: 0, messageIds: ["a"]}, {blockId: 1, messageIds: ["b", "c"]}], enumerable: false});
				return outcome;
			},
			validate: (_prepared, raw) => raw ? {ok: true, translation: raw} : {ok: false},
			repairBatch: prepared => {
				repairCalls.push(prepared.map(item => item.message.id));
				return {translations: Object.fromEntries(prepared.map(item => [item.message.id, `repair-${item.message.id}`])), failureKind: null, statusCode: 200};
			},
			repair: () => ({status: "failed"})
		}
	});
	for (const id of ["ok", "a", "b", "c"]) job.add(createMessage(id, `body-${id}`));
	const summary = await job.start();
	assert.deepEqual(repairCalls, [["a"], ["b", "c"]]);
	assert.deepEqual(summary.translated.map(item => item.message.id), ["ok", "a", "b", "c"]);
});

test("S3H repair partitions multi-item blocks by protected chars and leaves one oversized item alone", async () => {
	const repairCalls = [];
	const texts = {a: "a".repeat(7000), b: "b".repeat(7000), c: "c".repeat(13000)};
	const job = new HistoricalTranslationJob({
		repairBatchSize: 10,
		dependencies: {
			prepare: source => ({status: "pending", prepared: Object.assign({}, source, {protectedText: texts[source.message.id]})}),
			translateBatch: () => null,
			validate: () => ({ok: false}),
			repairBatch: prepared => {
				repairCalls.push(prepared.map(item => item.message.id));
				return {translations: Object.fromEntries(prepared.map(item => [item.message.id, `repair-${item.message.id}`])), failureKind: null, statusCode: 200};
			},
			repair: () => ({status: "failed"})
		}
	});
	for (const id of ["a", "b", "c"]) job.add(createMessage(id));
	await job.start();
	assert.deepEqual(repairCalls, [["a"], ["b"], ["c"]]);
});

test("S3H multi-request budget denial is terminal and never fans out into repair", async () => {
	let repairBatchCalls = 0, repairCalls = 0;
	const job = new HistoricalTranslationJob({dependencies: {
		prepare: source => ({status: "pending", prepared: source}),
		translateBatch: () => ({translations: null, failureKind: "request_budget", statusCode: 413}),
		validate: () => ({ok: false}),
		repairBatch: () => {repairBatchCalls++; return null;},
		repair: () => {repairCalls++; return {status: "failed"};}
	}});
	job.add(createMessage("a"));
	job.add(createMessage("b"));
	const summary = await job.start();
	assert.equal(repairBatchCalls, 0);
	assert.equal(repairCalls, 0);
	assert.deepEqual(summary.failed.map(item => item.reason), ["provider_request_budget", "provider_request_budget"]);
});

test("S4 invalidation and cancellation synchronously notify the physical-attempt owner once", () => {
	const events = [];
	const job = new HistoricalTranslationJob({dependencies: {
		onInvalidate: (_job, messageId, reason) => events.push(["invalidate", messageId, reason]),
		onCancel: (_job, reason) => events.push(["cancel", reason])
	}});
	job.add(createMessage("m1"));
	assert.equal(job.invalidateMessage("m1", "source-edited"), true);
	assert.deepEqual(events, [["invalidate", "m1", "source-edited"]]);
	assert.equal(job.invalidateMessage("m1", "again"), false);
	assert.equal(job.cancel("channel-switch"), true);
	assert.deepEqual(events, [["invalidate", "m1", "source-edited"], ["cancel", "channel-switch"]]);
	assert.equal(job.cancel("again"), false);
	const throwing = new HistoricalTranslationJob({dependencies: {onInvalidate: () => {throw new Error("hook");}, onCancel: () => {throw new Error("hook");}}});
	throwing.add(createMessage("m2"));
	assert.doesNotThrow(() => throwing.invalidateMessage("m2"));
	assert.doesNotThrow(() => throwing.cancel());
});

test("S5 physically-settled timeout block is bisected once and never replayed intact", async () => {
	const repairCalls = [];
	const job = new HistoricalTranslationJob({dependencies: {
		prepare: source => ({status: "pending", prepared: Object.assign({}, source, {protectedText: source.message.content})}),
		translateBatch: () => {
			const outcome = {translations: null, failureKind: "timeout", statusCode: null};
			const block = {blockId: 0, messageIds: ["a", "b", "c", "d"]};
			Object.defineProperty(block, "failureKind", {value: "timeout", enumerable: false});
			Object.defineProperty(block, "physicalSettled", {value: true, enumerable: false});
			Object.defineProperty(outcome, "historicalFailureBlocks", {value: [block], enumerable: false});
			return outcome;
		},
		validate: (_prepared, raw) => raw ? {ok: true, translation: raw} : {ok: false},
		repairBatch: prepared => {repairCalls.push(prepared.map(item => item.message.id)); return {translations: Object.fromEntries(prepared.map(item => [item.message.id, `repair-${item.message.id}`])), failureKind: null, statusCode: 200};},
		repair: () => {throw new Error("split success needs no per-item request");}
	}});
	for (const id of ["a", "b", "c", "d"]) job.add(createMessage(id));
	const summary = await job.start();
	assert.deepEqual(repairCalls, [["a", "b"], ["c", "d"]]);
	assert.equal(repairCalls.some(call => call.length === 4), false);
	assert.deepEqual(summary.translated.map(item => item.message.id), ["a", "b", "c", "d"]);
});

test("S5 one-item timeout cannot be shrunk and sends zero retry requests", async () => {
	let batchRepairs = 0, itemRepairs = 0;
	const job = new HistoricalTranslationJob({dependencies: {
		prepare: source => ({status: "pending", prepared: source}),
		translateBatch: () => {
			const outcome = {translations: null, failureKind: "timeout", statusCode: null};
			const block = {blockId: 0, messageIds: ["a"]};
			Object.defineProperty(block, "failureKind", {value: "timeout"});
			Object.defineProperty(block, "physicalSettled", {value: true});
			Object.defineProperty(outcome, "historicalFailureBlocks", {value: [block]});
			return outcome;
		},
		validate: () => ({ok: false}),
		repairBatch: () => {batchRepairs++; return null;},
		repair: () => {itemRepairs++; return {status: "failed"};}
	}});
	job.add(createMessage("a"));
	const summary = await job.start();
	assert.equal(batchRepairs, 0);
	assert.equal(itemRepairs, 0);
	assert.deepEqual(summary.failed.map(item => item.reason), ["provider_timeout"]);
});

test("S5 rate-limit and server roots skip same-key batch retry and permit per-item backup flow", async () => {
	for (const failureKind of ["rate_limit", "server"]) {
		let batchRepairs = 0;
		const itemRepairs = [];
		const job = new HistoricalTranslationJob({dependencies: {
			prepare: source => ({status: "pending", prepared: source}),
			translateBatch: () => ({translations: null, failureKind, statusCode: failureKind === "rate_limit" ? 429 : 503}),
			validate: () => ({ok: false}),
			repairBatch: () => {batchRepairs++; return null;},
			repair: prepared => {itemRepairs.push(prepared.message.id); return {status: "translated", translation: `backup-${prepared.message.id}`};}
		}});
		job.add(createMessage("a"));
		job.add(createMessage("b"));
		const summary = await job.start();
		assert.equal(batchRepairs, 0);
		assert.deepEqual(itemRepairs.sort(), ["a", "b"]);
		assert.equal(summary.translated.length, 2);
	}
});

test("S5 malformed and missing response repairs only invalid IDs and never a successful sibling", async () => {
	const repairCalls = [];
	const job = new HistoricalTranslationJob({dependencies: {
		prepare: source => ({status: "pending", prepared: source}),
		translateBatch: () => ({translations: {ok: "translated-ok"}, failureKind: "malformed", statusCode: 200}),
		validate: (_prepared, raw) => raw ? {ok: true, translation: raw} : {ok: false},
		repairBatch: prepared => {repairCalls.push(prepared.map(item => item.message.id)); return {translations: Object.fromEntries(prepared.map(item => [item.message.id, `repair-${item.message.id}`])), failureKind: null, statusCode: 200};},
		repair: () => {throw new Error("small batch resolved all invalid IDs");}
	}});
	for (const id of ["ok", "missing-a", "missing-b"]) job.add(createMessage(id));
	const summary = await job.start();
	assert.deepEqual(repairCalls, [["missing-a", "missing-b"]]);
	assert.equal(repairCalls.flat().includes("ok"), false);
	assert.equal(summary.translated.length, 3);
});

const {runChunkedHistoricalBatch} = require("../src/orchestrator/historical-provider-chunking");

test("historical semantic_schema isolates one exhausted block without replaying its twelve siblings", async () => {
	const requests = [];
	const validated = [];
	const commits = [];
	let repairs = 0;
	const job = new HistoricalTranslationJob({dependencies: {
		translateBatch: preparedItems => runChunkedHistoricalBatch({
			preparedItems, maxConcurrency: 4,
			requestChunk: (items, meta) => {
				requests.push(items.map(item => item.message.id));
				return meta.chunkIndex === 1
					? {translations: null, failureKind: "semantic_schema", statusCode: 200}
					: Object.fromEntries(items.map(item => [item.message.id, `translated-${item.message.id}`]));
			}
		}),
		validate: (item, translation) => {validated.push(item.message.id); return {ok: translation != null, translation};},
		repairBatch: () => {repairs++; return null;},
		repair: () => {repairs++; return {status: "failed"};},
		commit: summary => commits.push(summary)
	}});
	for (let id = 0; id < 22; id++) job.add(createMessage(String(id)));
	const summary = await job.start();
	assert.equal(summary.translated.length, 12);
	assert.deepEqual(summaryIds(summary.failed), ["10", "11", "12", "13", "14", "15", "16", "17", "18", "19"]);
	assert.ok(summary.failed.every(item => item.reason === "provider_semantic_schema"));
	assert.deepEqual(validated, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "20", "21"]);
	assert.deepEqual(requests.map(items => items.length), [10, 10, 2]);
	assert.equal(new Set(requests.flat()).size, 22);
	assert.equal(repairs, 0);
	assert.deepEqual(commits, [summary]);
});
test("historical local response containment covers cap1/cap4 single and multiple exhausted blocks", async () => {
	for (const maxConcurrency of [1, 4]) for (const count of [2, 22]) {
		let requests = 0;
		let repairs = 0;
		let commits = 0;
		const validated = [];
		const job = new HistoricalTranslationJob({dependencies: {
			translateBatch: preparedItems => runChunkedHistoricalBatch({preparedItems, maxConcurrency, requestChunk: (items, meta) => {
				requests++;
				return meta.chunkIndex < 2 ? {translations: null, failureKind: "semantic_schema", statusCode: 200}
					: Object.fromEntries(items.map(item => [item.message.id, "ok"]));
			}}),
			validate: (item, translation) => {validated.push(item.message.id); return {ok: translation != null, translation};},
			repairBatch: () => {repairs++; return null;},
			repair: () => {repairs++; return {status: "failed"};},
			commit: () => {commits++;}
		}});
		for (let id = 0; id < count; id++) job.add(createMessage(String(id)));
		const summary = await job.start();
		assert.equal(summary.failed.length, count === 2 ? 2 : 20);
		assert.equal(summary.translated.length, count === 2 ? 0 : 2);
		assert.deepEqual(validated, count === 2 ? [] : ["20", "21"]);
		assert.ok(summary.failed.every(item => item.reason === "provider_semantic_schema"));
		assert.equal(requests, count === 2 ? 1 : 3);
		assert.equal(repairs, 0);
		assert.equal(commits, 1);
	}
});

test("an unrelated missing sibling row keeps its existing repair lane after local response failure", async () => {
	for (const maxConcurrency of [1, 4]) {
		const repairs = [];
		const validations = [];
		const job = new HistoricalTranslationJob({dependencies: {
			translateBatch: preparedItems => runChunkedHistoricalBatch({preparedItems, chunkSize: 2, maxConcurrency, requestChunk: (_items, meta) => {
				if (meta.chunkIndex === 0) return {translations: null, failureKind: "semantic_schema", statusCode: 200};
				if (meta.chunkIndex === 1) return {translations: {"2": "valid"}, failureKind: null, statusCode: 200};
				return null;
			}}),
			validate: (item, translation) => {validations.push(item.message.id); return {ok: translation != null, translation};},
			repairBatch: items => {repairs.push(items.map(item => item.message.id)); return Object.fromEntries(items.map(item => [item.message.id, "repaired"]));},
			repair: item => {repairs.push([item.message.id]); return {status: "translated", translation: "repaired"};}
		}});
		for (let id = 0; id < 6; id++) job.add(createMessage(String(id)));
		const summary = await job.start();
		assert.deepEqual(summaryIds(summary.failed), ["0", "1"]);
		assert.deepEqual(summaryIds(summary.translated), ["2", "3", "4", "5"]);
		assert.deepEqual(repairs, [["3"], ["4", "5"]]);
		assert.equal(validations.includes("0") || validations.includes("1"), false);
		assert.equal(repairs.flat().includes("2"), false, "successful sibling never replays");
	}
});

test("unscoped semantic_schema remains terminal without trusted block metadata", async () => {
	let validates = 0;
	let repairs = 0;
	const job = new HistoricalTranslationJob({dependencies: {
		translateBatch: () => ({translations: {a: "not trusted"}, failureKind: "semantic_schema", statusCode: 200}),
		validate: () => {validates++; return {ok: true, translation: "bad"};},
		repairBatch: () => {repairs++; return null;},
		repair: () => {repairs++; return {status: "failed"};}
	}});
	job.add(createMessage("a")); job.add(createMessage("b"));
	const summary = await job.start();
	assert.deepEqual(summaryIds(summary.failed), ["a", "b"]);
	assert.equal(validates, 0);
	assert.equal(repairs, 0);
});

test("local response isolation still obeys cancellation, source invalidation and the atomic currentness gate", async () => {
	for (const mode of ["cancel", "invalidate", "stale-at-commit"]) {
		const pending = createDeferred();
		const commitGate = createDeferred();
		let current = true;
		let waitingForCommit = false;
		let commits = 0;
		let repairs = 0;
		const job = new HistoricalTranslationJob({dependencies: {
			translateBatch: preparedItems => runChunkedHistoricalBatch({preparedItems, chunkSize: 2, maxConcurrency: 4, isCurrent: () => current, requestChunk: (_items, meta) => meta.chunkIndex === 0
				? {translations: null, failureKind: "semantic_schema", statusCode: 200} : pending.promise}),
			validate: (_item, translation) => ({ok: translation != null, translation}),
			repairBatch: () => {repairs++; return null;},
			repair: () => {repairs++; return {status: "failed"};},
			isCurrent: () => current,
			waitForCommit: () => {waitingForCommit = true; return commitGate.promise;},
			commit: () => {commits++;}
		}});
		for (let id = 0; id < 4; id++) job.add(createMessage(String(id)));
		const running = job.start();
		await settle();
		if (mode === "cancel") {job.cancel("user-cancel"); current = false;}
		if (mode === "invalidate") job.invalidateMessage("2");
		pending.resolve({"2": "old source", "3": "valid"});
		await settle();
		if (mode === "stale-at-commit") {assert.equal(waitingForCommit, true); current = false;}
		commitGate.resolve();
		const summary = await running;
		assert.equal(repairs, 0);
		assert.equal(commits, mode === "invalidate" ? 1 : 0);
		if (mode === "invalidate") {
			assert.deepEqual(summaryIds(summary.translated), ["3"]);
			assert.deepEqual(summaryIds(summary.failed), ["0", "1"]);
			assert.equal(statusOf(job, "2"), "cancelled");
		}
		else assert.equal(job.state, "cancelled");
	}
});
test("a transient sibling retains its one bounded batch retry beside an exhausted response block", async () => {
	for (const maxConcurrency of [1, 4]) {
		const repairs = [];
		let itemRepairs = 0;
		const job = new HistoricalTranslationJob({dependencies: {
			translateBatch: preparedItems => runChunkedHistoricalBatch({preparedItems, chunkSize: 2, maxConcurrency,
				requestChunk: (_items, meta) => ({translations: null, failureKind: meta.chunkIndex === 0 ? "semantic_schema" : "transient", statusCode: 503})}),
			repairBatch: items => {repairs.push(items.map(item => item.message.id)); return {translations: {"2": "recovered"}, failureKind: null, statusCode: 200};},
			repair: () => {itemRepairs++; return {status: "translated", translation: "third request"};}
		}});
		for (let id = 0; id < 4; id++) job.add(createMessage(String(id)));
		const summary = await job.start();
		assert.equal(itemRepairs, 0, "a local root must not erase the sibling's transient attempt ceiling");
		assert.deepEqual(repairs, [["2", "3"]]);
		assert.deepEqual(summaryIds(summary.translated), ["2"]);
		assert.deepEqual(summaryIds(summary.failed), ["0", "1", "3"]);
		assert.equal(job.items.get("3").reason, "provider_transient");
	}
});
test("exhausted historical response blocks keep zero-replay identity beside a thrown sibling", async () => {
	for (const maxConcurrency of [1, 4]) {
		const repairs = [];
		let itemRepairs = 0;
		const job = new HistoricalTranslationJob({dependencies: {
			translateBatch: preparedItems => runChunkedHistoricalBatch({preparedItems, chunkSize: 2, maxConcurrency,
				requestChunk: (_items, meta) => meta.chunkIndex === 0
					? {translations: null, failureKind: "semantic_schema", statusCode: 200}
					: Promise.reject(new Error("sibling threw"))}),
			repairBatch: items => {repairs.push(items.map(item => item.message.id)); return {translations: {"2": "recovered"}, failureKind: null, statusCode: 200};},
			repair: () => {itemRepairs++; return {status: "failed"};}
		}});
		for (let id = 0; id < 4; id++) job.add(createMessage(String(id)));
		const summary = await job.start();
		assert.deepEqual(repairs, [["2", "3"]], `cap ${maxConcurrency}: only the thrown block gets its bounded retry`);
		assert.equal(itemRepairs, 0);
		assert.deepEqual(summaryIds(summary.translated), ["2"]);
		assert.deepEqual(summaryIds(summary.failed), ["0", "1", "3"]);
		assert.equal(job.items.get("0").reason, "provider_semantic_schema");
		assert.equal(job.items.get("1").reason, "provider_semantic_schema");
		assert.equal(job.items.get("3").reason, "provider_transient");
	}
});
test("progressive history accepts one whole validated block before primary siblings or repair finish", async () => {
 const primary = createDeferred(), repair = createDeferred();
 const progress = [], validations = [], finalCommits = [];
 let publish, prepared;
 const job = new HistoricalTranslationJob({dependencies: {
  translateBatch: (items, _job, onChunkOutcome) => {prepared = items; publish = onChunkOutcome; return primary.promise;},
  validate: (item, raw) => {validations.push(item.message.id); return {ok: raw != null, translation: raw};},
  commitProgress: summary => {const ids = summaryIds(summary.translated); progress.push(ids); return {committedIds: ids};},
  repair: () => repair.promise,
  commit: summary => finalCommits.push(summaryIds(summary.translated))
 }});
 for (const id of ["a", "b", "c"]) job.add(createMessage(id));
 const running = job.start(); await settle();
 assert.equal(typeof publish, "function");
 assert.equal(publish({preparedItems: prepared.slice(0, 2), outcome: {a: "A", b: "B"}, isCurrent: () => true}), undefined);
 await settle();
 assert.deepEqual(progress, [["a", "b"]]);
 assert.deepEqual([...job.progressCommittedIds], ["a", "b"]);
 assert.equal(finalCommits.length, 0);
 primary.resolve({a: "A", b: "B"}); await settle();
 assert.deepEqual(validations, ["a", "b", "c"], "accepted rows are not revalidated at primary completion");
 assert.equal(finalCommits.length, 0);
 repair.resolve({status: "translated", translation: "C"});
 const summary = await running;
 assert.deepEqual(summaryIds(summary.translated), ["a", "b", "c"]);
 assert.deepEqual(finalCommits, [["a", "b", "c"]]);
});
test("progress is optional and a producer without chunk callbacks still publishes before repair", async () => {
 for (const enabled of [false, true]) {
  const repair = createDeferred(), progress = []; let args;
  const deps = {translateBatch: (...received) => {args = received; return {a: "A"};}, repair: () => repair.promise};
  if (enabled) deps.commitProgress = summary => {progress.push(summaryIds(summary.translated)); return {committedIds: ["a"]};};
  const job = new HistoricalTranslationJob({dependencies: deps});
  job.add(createMessage("a")); job.add(createMessage("b")); const running = job.start(); await settle();
  assert.equal(args.length, enabled ? 3 : 2);
  assert.deepEqual(progress, enabled ? [["a"]] : []);
  repair.resolve({status: "failed"}); await running;
 }
});

test("progress validates only owned returned rows and reuses invalid and skip verdicts without replaying observers", async () => {
 const primary = createDeferred(), progress = [], validated = [], repairs = []; let publish, prepared;
 const job = new HistoricalTranslationJob({dependencies: {
  translateBatch: (items, _job, callback) => {prepared = items; publish = callback; return primary.promise;},
  validate: (item, raw) => {validated.push([item.message.id, raw]); return raw === "skip" ? {skipped: true, reason: "skip"} : {ok: raw === "good", translation: raw};},
  commitProgress: summary => {progress.push(summaryIds(summary.translated)); assert.deepEqual(summary.skipped, []); return {committedIds: ["a", "foreign"]};},
  repair: item => {repairs.push(item.message.id); return {status: "failed"};}
 }});
 for (const id of ["a", "b", "c", "d"]) job.add(createMessage(id)); const running = job.start(); await settle();
 const event = {preparedItems: [...prepared.slice(0, 3), {message: {id: "d"}}], outcome: {a: "good", b: "bad", c: "skip", d: "good", foreign: "good"}, isCurrent: () => true};
 publish(event); publish(event); await settle();
 assert.deepEqual(validated, [["a", "good"], ["b", "bad"], ["c", "skip"]]);
 assert.deepEqual(progress, [["a"]]);
 assert.deepEqual([...job.progressCommittedIds], ["a"]);
 primary.resolve({a: "good", b: "bad", c: "skip"}); const summary = await running;
 assert.deepEqual(validated, [["a", "good"], ["b", "bad"], ["c", "skip"], ["d", null]]);
 assert.deepEqual(repairs, ["b", "d"]);
 assert.deepEqual(summaryIds(summary.skipped), ["c"]);
});

test("failed or partial progress ACKs leave the original final commit responsible without another provider call", async () => {
 for (const mode of ["throw", "empty", "partial"]) {
  let primaryCalls = 0, progressCalls = 0; const final = [];
  const job = new HistoricalTranslationJob({dependencies: {
   translateBatch: () => {primaryCalls++; return {a: "A", b: "B"};},
   commitProgress: () => {progressCalls++; if (mode === "throw") throw new Error("display failed"); return {committedIds: mode === "partial" ? ["a", "foreign"] : []};},
   commit: summary => final.push(summaryIds(summary.translated))
  }});
  job.add(createMessage("a")); job.add(createMessage("b")); await job.start();
  assert.equal(primaryCalls, 1); assert.equal(progressCalls, 1);
  assert.deepEqual(final, [["a", "b"]]);
  assert.deepEqual([...job.progressCommittedIds], mode === "partial" ? ["a"] : []);
 }
});

test("global terminal keeps only accepted progress while local exhausted chunks keep independent good siblings", async () => {
 for (const mode of ["global-accepted", "global-unaccepted", "local"]) {
  const primary = createDeferred(); let publish, prepared; const progress = [];
  const job = new HistoricalTranslationJob({dependencies: {
   translateBatch: (items, _job, callback) => {publish = callback; prepared = items; return primary.promise;},
   commitProgress: summary => {progress.push(summaryIds(summary.translated)); return {committedIds: mode === "global-unaccepted" ? [] : ["a"]};}
  }});
  job.add(createMessage("a")); job.add(createMessage("b")); const running = job.start(); await settle();
  publish({preparedItems: [prepared[0]], outcome: {a: "A"}, isCurrent: () => true}); await settle();
  const failureKind = mode === "local" ? "semantic_schema" : "auth";
  publish({preparedItems: [prepared[1]], outcome: {translations: null, failureKind}, isCurrent: () => mode === "local"});
  const outcome = {translations: mode === "local" ? {a: "A"} : null, failureKind};
  if (mode === "local") Object.defineProperty(outcome, "historicalFailureBlocks", {value: [{blockId: 1, messageIds: ["b"], failureKind}]});
  primary.resolve(outcome); const summary = await running;
  assert.deepEqual(summaryIds(summary.translated), mode === "global-unaccepted" ? [] : ["a"]);
  assert.deepEqual(summaryIds(summary.failed), mode === "global-unaccepted" ? ["a", "b"] : ["b"]);
  assert.deepEqual(progress, [["a"]]);
  assert.ok(summary.failed.every(item => item.translation == null), "unaccepted success does not leak into terminal failure payload");
 }
});

test("global terminal invalidates a waiting progress proposal but does not retract an already accepted ACK", async () => {
 for (const alreadyAccepted of [false, true]) {
  const primary = createDeferred(), ack = createDeferred(); let publish, prepared, proposal; const accepted = [];
  const job = new HistoricalTranslationJob({dependencies: {
   translateBatch: (items, _job, callback) => {publish = callback; prepared = items; return primary.promise;},
   commitProgress: async summary => {proposal = summary; if (alreadyAccepted) accepted.push("a"); await ack.promise; return {committedIds: accepted};}
  }});
  job.add(createMessage("a")); job.add(createMessage("b")); const running = job.start(); await settle();
  publish({preparedItems: [prepared[0]], outcome: {a: "A"}, isCurrent: () => true}); await settle();
  assert.equal(proposal.isCurrent(), true); assert.equal(Object.keys(proposal).includes("isCurrent"), false);
  publish({preparedItems: [prepared[1]], outcome: {translations: null, failureKind: "auth"}, isCurrent: () => false});
  assert.equal(proposal.isCurrent(), false);
  primary.resolve({translations: null, failureKind: "auth"}); ack.resolve(); const summary = await running;
  assert.deepEqual(summaryIds(summary.translated), alreadyAccepted ? ["a"] : []);
  assert.deepEqual([...job.progressCommittedIds], alreadyAccepted ? ["a"] : []);
 }
});

test("progress rejects cancellation, invalidation, stale event and stale job during asynchronous validation or ACK", async () => {
 for (const phase of ["validate", "ack"]) for (const mode of ["cancel", "invalidate", "event", "job"]) {
  const primary = createDeferred(), gate = createDeferred(); let publish, prepared, current = true, eventCurrent = true, offers = 0;
  const job = new HistoricalTranslationJob({dependencies: {
   translateBatch: (items, _job, callback) => {publish = callback; prepared = items; return primary.promise;},
   validate: async (_item, raw) => {if (phase === "validate") await gate.promise; return {ok: true, translation: raw};},
   isCurrent: () => current,
   commitProgress: async () => {offers++; if (phase === "ack") await gate.promise; return {committedIds: ["a"]};}
  }});
  job.add(createMessage("a")); const running = job.start(); await settle();
  publish({preparedItems: prepared, outcome: {a: "A"}, isCurrent: () => eventCurrent}); await settle();
  if (mode === "cancel") job.cancel(); if (mode === "invalidate") job.invalidateMessage("a"); if (mode === "event") eventCurrent = false; if (mode === "job") current = false;
  gate.resolve(); await settle();
  if (phase === "validate") assert.equal(offers, 0, mode + " rejects a late validation");
  assert.equal(job.progressCommittedIds.size, 0, mode + " rejects a late ACK");
  job.cancel(); primary.resolve({a: "A"}); await running;
 }
});

test("whole-marker completed blocks reuse progress validation and ACK without replay", async () => {
 const primary = createDeferred(); let publish, prepared; const validations = [], progress = [];
 const job = new HistoricalTranslationJob({dependencies: {
  prepare: item => ({prepared: {...item, wholeMarkerBatchFinal: true, wholeMarkerBatchIsCurrent: () => true}}),
  translateBatch: (items, _job, callback) => {prepared = items; publish = callback; return primary.promise;},
  validate: (item, raw) => {validations.push(item.message.id); return {ok: true, translation: raw};},
  commitProgress: summary => {progress.push(summary); return {committedIds: ["a"]};}
 }});
 job.add(createMessage("a")); const running = job.start(); await settle();
 publish({preparedItems: prepared, outcome: {a: "A"}, isCurrent: () => true}); await settle();
 assert.deepEqual(validations, ["a"]); assert.equal(progress.length, 1);
 assert.equal(progress[0].translated[0].wholeMarkerBatchFinal, true, "progress retains the W5 cache exclusion");
 assert.equal(progress[0].isCurrent(), true);
 primary.resolve({a: "A"}); await running;
 assert.deepEqual(validations, ["a"]); assert.equal(progress.length, 1);
 assert.deepEqual([...job.progressCommittedIds], ["a"]);
});

for (const phase of ["validate", "ack"]) test(`whole-marker result currentness fences asynchronous ${phase} before store acceptance`, async () => {
 const primary = createDeferred(), gate = createDeferred();
 let publish, prepared, current = true, proposal, offers = 0;
 const job = new HistoricalTranslationJob({dependencies: {
  prepare: item => ({prepared: {...item, wholeMarkerBatchFinal: true, wholeMarkerBatchIsCurrent: () => current}}),
  translateBatch: (items, _job, callback) => {prepared = items; publish = callback; return primary.promise;},
  validate: async (_item, raw) => {if (phase === "validate") await gate.promise; return {ok: true, translation: raw};},
  commitProgress: async summary => {offers++; proposal = summary; if (phase === "ack") await gate.promise; return {committedIds: summary.isCurrent() ? ["a"] : []};}
 }});
 job.add(createMessage("a")); const running = job.start(); await settle();
 publish({preparedItems: prepared, outcome: {a: "A"}, isCurrent: () => true}); await settle();
 if (proposal) assert.equal(proposal.isCurrent(), true);
 current = false;
 if (proposal) assert.equal(proposal.isCurrent(), false, "display proposal observes revoked grant or changed W5 source");
 gate.resolve(); await settle();
 assert.equal(offers, phase === "validate" ? 0 : 1);
 assert.equal(job.progressCommittedIds.size, 0, "stale ACK does not claim an accepted result");
 primary.resolve({a: "A"}); const summary = await running;
 assert.deepEqual(summary.translated, []); assert.equal(job.items.get("a").status, "cancelled");
});
