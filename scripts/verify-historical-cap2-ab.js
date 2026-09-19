"use strict";

const assert = require("node:assert/strict");
const {runChunkedHistoricalBatch} = require("../src/orchestrator/historical-provider-chunking");

function deferred() {
	let resolve;
	const promise = new Promise(done => {resolve = done;});
	return {promise, resolve};
}

function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

function items(count = 50) {
	return Array.from({length: count}, (_, index) => ({message: {id: `m${index}`}, protectedText: `fixture ${index}`}));
}

async function runArm(concurrency) {
	const requests = [];
	const progress = [];
	let active = 0;
	let highWater = 0;
	let finished = false;
	const running = runChunkedHistoricalBatch({
		preparedItems: items(),
		maxConcurrency: concurrency,
		requestChunk(chunk, meta) {
			const turn = deferred();
			active++;
			highWater = Math.max(highWater, active);
			const request = {
				index: meta.chunkIndex,
				ids: chunk.map(item => item.message.id),
				wireProjection: JSON.stringify(chunk.map(item => ({id: item.message.id, text: item.protectedText}))),
				turn,
				settled: false
			};
			requests.push(request);
			return turn.promise.finally(() => {active--; request.settled = true;});
		},
		onChunkSettled: update => progress.push({...update})
	});
	running.finally(() => {finished = true;});
	let waves = 0;
	while (!finished) {
		await settle();
		await settle();
		const inFlight = requests.filter(request => !request.settled);
		if (!inFlight.length) {
			await settle();
			if (!finished) throw new Error("scheduler stalled without an in-flight chunk");
			break;
		}
		waves++;
		for (const request of inFlight) request.turn.resolve(Object.fromEntries(request.ids.map(id => [id, `translated ${id}`])));
	}
	const outcome = await running;
	return {
		concurrency,
		waves,
		logicalTotalMs: waves * 100 + 20,
		highWater,
		active,
		requests: requests.map(({index, ids, wireProjection}) => ({index, ids, wireProjection})),
		progress,
		translatedIds: Object.keys(outcome.translations).sort()
	};
}

async function verify() {
	const cap1 = await runArm(1);
	const cap2 = await runArm(2);
	assert.deepEqual(cap2.requests, cap1.requests, "only overlap timing may differ between arms");
	assert.deepEqual(cap2.translatedIds, cap1.translatedIds);
	assert.equal(cap1.highWater, 1);
	assert.equal(cap2.highWater, 2);
	assert.equal(cap1.waves, 5);
	assert.equal(cap2.waves, 3, "probe + two dual-slot waves");
	assert.equal(cap1.active, 0);
	assert.equal(cap2.active, 0);
	const improvementPercent = (cap1.logicalTotalMs - cap2.logicalTotalMs) / cap1.logicalTotalMs * 100;
	assert.ok(improvementPercent >= 20);
	return {ok: true, cap1, cap2, improvementPercent};
}

if (require.main === module) verify().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), error => {
	console.error(error && error.stack || error);
	process.exitCode = 1;
});

module.exports = {runArm, verify};
