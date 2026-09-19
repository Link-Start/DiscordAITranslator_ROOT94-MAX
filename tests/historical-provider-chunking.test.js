const test = require("node:test");
const assert = require("node:assert/strict");
const {runChunkedHistoricalBatch, HISTORICAL_PROVIDER_CHUNK_SIZE, HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT, HISTORICAL_PROVIDER_CONCURRENCY_MAX} = require("../src/orchestrator/historical-provider-chunking");

function createItems(count) {
	return Array.from({length: count}, (_, index) => ({message: {id: String(100 + index)}, channelId: "channel-1"}));
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {resolve = resolvePromise; reject = rejectPromise;});
	return {promise, resolve, reject};
}

function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

test("a batch within the chunk size costs exactly one provider request", async () => {
	const requests = [];
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: createItems(5),
		requestChunk: items => {
			requests.push(items.map(item => item.message.id));
			return Promise.resolve(Object.fromEntries(items.map(item => [item.message.id, `译文 ${item.message.id}`])));
		}
	});

	assert.deepEqual(requests, [["100", "101", "102", "103", "104"]]);
	assert.deepEqual(outcome, {translations: Object.fromEntries([100, 101, 102, 103, 104].map(id => [String(id), `译文 ${id}`])), failureKind: null, statusCode: null});
});

test("an oversized batch splits into chunks and merges map and detailed outcomes", async () => {
	const requests = [];
	const requestMeta = [];
	const settled = [];
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: createItems(25),
		requestChunk: (items, meta) => {
			requests.push(items.length);
			requestMeta.push({...meta});
			// The first chunk answers with the legacy map shape, the second with the
			// detailed typed shape; the merge must accept both.
			if (requests.length === 1) return Promise.resolve(Object.fromEntries(items.map(item => [item.message.id, `a ${item.message.id}`])));
			return Promise.resolve({translations: Object.fromEntries(items.map(item => [item.message.id, `b ${item.message.id}`])), failureKind: null, statusCode: 200});
		},
		onChunkSettled: progress => settled.push({...progress})
	});

	assert.deepEqual(requests, [10, 10, 5]);
	assert.deepEqual(requestMeta, [
		{chunkIndex: 0, chunkCount: 3},
		{chunkIndex: 1, chunkCount: 3},
		{chunkIndex: 2, chunkCount: 3}
	], "observation metadata does not change the sequential request plan");
	assert.deepEqual(settled.map(progress => progress.answered), [10, 20, 25]);
	assert.equal(Object.keys(outcome.translations).length, 25);
	assert.equal(outcome.translations["109"], "a 109");
	assert.equal(outcome.translations["110"], "b 110");
	assert.equal(outcome.failureKind, null);
});

test("a terminal failure on the first chunk short-circuits the remaining chunks", async () => {
	const requests = [];
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: createItems(25),
		requestChunk: items => {
			requests.push(items.length);
			return Promise.resolve({translations: null, failureKind: "auth", statusCode: 401});
		}
	});

	assert.deepEqual(requests, [10], "an auth failure must not hammer the key with more chunks");
	assert.deepEqual(outcome, {translations: null, failureKind: "auth", statusCode: 401});
});

test("a cancelled job stops issuing chunks and returns what already settled", async () => {
	const requests = [];
	let current = true;
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: createItems(25),
		requestChunk: items => {
			requests.push(items.length);
			return Promise.resolve(Object.fromEntries(items.map(item => [item.message.id, `x ${item.message.id}`])));
		},
		isCurrent: () => current,
		onChunkSettled: () => {current = false;}
	});

	assert.deepEqual(requests, [10]);
	assert.equal(outcome.translations["109"], "x 109");
	assert.equal(Object.keys(outcome.translations).length, 10);
});

test("the provider chunk size stays at the progress-granularity contract", () => {
	assert.equal(HISTORICAL_PROVIDER_CHUNK_SIZE, 10);
	assert.equal(HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT, 12000);
	assert.equal(HISTORICAL_PROVIDER_CONCURRENCY_MAX, 4);
});

test("character-aware chunks split a ten-message announcement before the timeout-sized payload", async () => {
	const requests = [];
	const items = createItems(10).map(item => Object.assign(item, {protectedText: "文".repeat(3000)}));
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: items,
		requestChunk: (chunk, meta) => {
			requests.push({count: chunk.length, chars: chunk.reduce((sum, item) => sum + item.protectedText.length, 0), meta: {...meta}});
			return Promise.resolve(Object.fromEntries(chunk.map(item => [item.message.id, "ok"])));
		}
	});
	assert.deepEqual(requests.map(request => [request.count, request.chars]), [[4, 12000], [4, 12000], [2, 6000]]);
	assert.deepEqual(requests.map(request => request.meta.chunkCount), [3, 3, 3]);
	assert.equal(Object.keys(outcome.translations).length, 10);
});

test("one message over the character limit remains intact and never pulls a neighbour into its request", async () => {
	const requests = [];
	const items = createItems(3).map((item, index) => Object.assign(item, {protectedText: "x".repeat([13000, 1000, 1000][index])}));
	await runChunkedHistoricalBatch({
		preparedItems: items,
		requestChunk: chunk => {
			requests.push(chunk.map(item => item.protectedText.length));
			return Promise.resolve(Object.fromEntries(chunk.map(item => [item.message.id, "ok"])));
		}
	});
	assert.deepEqual(requests, [[13000], [1000, 1000]]);
});

test("S7 cap3 and cap4 launch a full first wave with no production probe barrier", async () => {
	for (const cap of [3, 4]) {
		const requests = [];
		let active = 0;
		let highWater = 0;
		const running = runChunkedHistoricalBatch({
			preparedItems: createItems((cap + 2) * 10),
			maxConcurrency: cap,
			requestChunk: (items, meta) => {
				const deferred = createDeferred();
				active++;
				highWater = Math.max(highWater, active);
				requests.push({items, meta, deferred, settled: false});
				return deferred.promise.finally(() => {active--;});
			}
		});
		await settle();
		assert.deepEqual(requests.map(request => request.meta.chunkIndex), Array.from({length: cap}, (_, index) => index));
		assert.equal(highWater, cap);
		requests[0].settled = true;
		requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, "ok"])));
		await settle(); await settle();
		assert.equal(requests.length, cap + 1);
		assert.equal(highWater, cap);
		requests[1].settled = true;
		requests[1].deferred.resolve(Object.fromEntries(requests[1].items.map(item => [item.message.id, "ok"])));
		await settle(); await settle();
		assert.equal(requests.length, cap + 2);
		for (const request of requests.filter(request => !request.settled)) {
			request.settled = true;
			request.deferred.resolve(Object.fromEntries(request.items.map(item => [item.message.id, "ok"])));
		}
		const outcome = await running;
		assert.equal(Object.keys(outcome.translations).length, (cap + 2) * 10);
		assert.equal(active, 0);
	}
});

test("S7 cap2 launches two real chunks immediately and keeps at most two active", async () => {
	const requests = [];
	const progress = [];
	let active = 0;
	let highWater = 0;
	const running = runChunkedHistoricalBatch({
		preparedItems: createItems(50),
		maxConcurrency: 2,
		requestChunk: (items, meta) => {
			const deferred = createDeferred();
			active++;
			highWater = Math.max(highWater, active);
			requests.push({items, meta, deferred});
			return deferred.promise.finally(() => {active--;});
		},
		onChunkSettled: update => progress.push({...update})
	});
	await settle();
	assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1], "the first wave uses both selected slots");
	requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, `t-${item.message.id}`])));
	await settle();
	await settle();
	assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1, 2]);
	requests[2].deferred.resolve(Object.fromEntries(requests[2].items.map(item => [item.message.id, `t-${item.message.id}`])));
	await settle();
	await settle();
	assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1, 2, 3]);
	requests[1].deferred.resolve(Object.fromEntries(requests[1].items.map(item => [item.message.id, `t-${item.message.id}`])));
	await settle();
	await settle();
	assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1, 2, 3, 4]);
	for (const index of [4, 3]) requests[index].deferred.resolve(Object.fromEntries(requests[index].items.map(item => [item.message.id, `t-${item.message.id}`])));
	const outcome = await running;
	assert.equal(Object.keys(outcome.translations).length, 50);
	assert.equal(highWater, 2);
	assert.equal(active, 0);
	assert.deepEqual(progress.map(update => update.answered), [10, 20, 30, 40, 50]);
	assert.deepEqual(progress.map(update => update.chunkIndex), [0, 2, 1, 4, 3], "progress follows settle order but remains monotonic");
});

test("S7 cap2 terminal first-wave failure sends no refill beyond its two in-flight requests", async () => {
	const requests = [];
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: createItems(50),
		maxConcurrency: 2,
		requestChunk: (items, meta) => {
			requests.push(meta.chunkIndex);
			return {translations: null, failureKind: "auth", statusCode: 401};
		}
	});
	assert.deepEqual(requests, [0, 1]);
	assert.deepEqual(outcome, {translations: null, failureKind: "auth", statusCode: 401});
});

test("a later terminal failure drains its sibling and never refills", async () => {
	const requests = [];
	const running = runChunkedHistoricalBatch({
		preparedItems: createItems(50),
		maxConcurrency: 2,
		requestChunk: (items, meta) => {
			const deferred = createDeferred();
			requests.push({items, meta, deferred});
			return deferred.promise;
		}
	});
	await settle();
	requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1, 2]);
	requests[1].deferred.resolve({translations: null, failureKind: "configuration", statusCode: 400});
	await settle(); await settle();
	assert.equal(requests.length, 3);
	let finished = false;
	running.finally(() => {finished = true;});
	await settle();
	assert.equal(finished, false, "the already-started sibling owns a physical lease until settle");
	requests[2].deferred.resolve(Object.fromEntries(requests[2].items.map(item => [item.message.id, "paid-but-terminal-dominated"])));
	const outcome = await running;
	assert.deepEqual(outcome, {translations: null, failureKind: "configuration", statusCode: 400});
	assert.equal(requests.length, 3);
});

test("live pressure suppresses the speculative slot and pressure waits before refill", async () => {
	const requests = [];
	let liveBusy = false;
	const pressureGate = createDeferred();
	let pressureWaits = 0;
	const running = runChunkedHistoricalBatch({
		preparedItems: createItems(50),
		maxConcurrency: 2,
		getDesiredConcurrency: () => liveBusy ? 1 : 2,
		awaitBeforeDispatch: ({pressure}) => {
			if (!pressure) return true;
			pressureWaits++;
			return pressureGate.promise.then(() => true);
		},
		requestChunk: (items, meta) => {
			const deferred = createDeferred();
			requests.push({items, meta, deferred});
			return deferred.promise;
		}
	});
	await settle();
	requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	requests[1].deferred.resolve({translations: null, failureKind: "transient", statusCode: 429});
	liveBusy = true;
	await settle(); await settle();
	assert.equal(requests.length, 3, "the sibling was already in flight, but no third refill starts");
	requests[2].deferred.resolve(Object.fromEntries(requests[2].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(pressureWaits, 1);
	assert.equal(requests.length, 3, "backoff gate holds the next base request");
	pressureGate.resolve();
	await settle(); await settle();
	assert.equal(requests.length, 4);
	requests[3].deferred.resolve(Object.fromEntries(requests[3].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(requests.length, 5, "the pressured remainder stays cap1 even after live clears");
	requests[4].deferred.resolve(Object.fromEntries(requests[4].items.map(item => [item.message.id, "ok"])));
	const outcome = await running;
	assert.equal(Object.keys(outcome.translations).length, 40, "the transient chunk alone is left for the existing repair stage");
});

test("cap2 cancellation and rejection drain in-flight work without progress or refill", async () => {
	for (const mode of ["cancel", "reject"]) {
		let current = true;
		const requests = [];
		const progress = [];
		const running = runChunkedHistoricalBatch({
			preparedItems: createItems(50),
			maxConcurrency: 2,
			isCurrent: () => current,
			requestChunk: (items, meta) => {
				const deferred = createDeferred();
				requests.push({items, meta, deferred});
				return deferred.promise;
			},
			onChunkSettled: update => progress.push(update)
		});
		await settle();
		requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, "ok"])));
		await settle(); await settle();
		assert.equal(requests.length, 3);
		if (mode === "cancel") {
			current = false;
			requests[1].deferred.resolve({});
			requests[2].deferred.resolve({});
			assert.equal(await running, null);
			assert.equal(progress.length, 1, "late cancelled chunks never update progress");
		}
		else {
			const failure = new Error("provider rejected");
			requests[1].deferred.reject(failure);
			let rejected = false;
			running.catch(() => {rejected = true;});
			await settle();
			assert.equal(rejected, false, "rejection waits for its already-started sibling");
			requests[2].deferred.resolve({});
			const outcome = await running;
			assert.equal(Object.keys(outcome.translations).length, 10, "the clean probe survives a later thrown sibling");
			assert.equal(outcome.failureKind, "transient");
		}
		assert.equal(requests.length, 3);
	}
});

test("a throw with no successful chunk still rejects", async () => {
	const failure = new Error("probe rejected");
	for (const maxConcurrency of [1, 4]) await assert.rejects(runChunkedHistoricalBatch({
		preparedItems: createItems(20),
		maxConcurrency,
		requestChunk: () => Promise.reject(failure)
	}), error => error === failure);
});

test("cap4 terminal failure dominates a thrown sibling and prevents refill", async () => {
	const requests = [];
	const running = runChunkedHistoricalBatch({
		preparedItems: createItems(60),
		maxConcurrency: 4,
		requestChunk: (items, meta) => {
			const deferred = createDeferred();
			requests.push({items, meta, deferred});
			return deferred.promise;
		}
	});
	await settle();
	requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(requests.length, 5);
	requests[1].deferred.reject(new Error("sibling threw"));
	requests[2].deferred.resolve({translations: null, failureKind: "auth", statusCode: 401});
	requests[3].deferred.resolve({});
	requests[4].deferred.resolve({});
	assert.deepEqual(await running, {translations: null, failureKind: "auth", statusCode: 401});
	assert.equal(requests.length, 5, "the sixth chunk never refills after terminal pressure");
});

test("cap4 transient pressure drains three siblings then keeps every remainder serial", async () => {
	const requests = [];
	const running = runChunkedHistoricalBatch({
		preparedItems: createItems(80),
		maxConcurrency: 4,
		requestChunk: (items, meta) => {
			const deferred = createDeferred();
			requests.push({items, meta, deferred, settled: false});
			return deferred.promise;
		}
	});
	await settle();
	requests[0].settled = true;
	requests[0].deferred.resolve(Object.fromEntries(requests[0].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(requests.length, 5);
	requests[1].settled = true;
	requests[1].deferred.resolve({translations: null, failureKind: "transient", statusCode: 429});
	for (const request of requests.slice(2, 5)) {
		request.settled = true;
		request.deferred.resolve(Object.fromEntries(request.items.map(item => [item.message.id, "ok"])));
	}
	await settle(); await settle();
	assert.equal(requests.length, 6, "only one remainder refills after the four-request wave drains");
	for (let index = 5; index < 8; index++) {
		requests[index].settled = true;
		requests[index].deferred.resolve(Object.fromEntries(requests[index].items.map(item => [item.message.id, "ok"])));
		await settle(); await settle();
		assert.equal(requests.length, Math.min(8, index + 2));
	}
	const outcome = await running;
	assert.equal(Object.keys(outcome.translations).length, 70);
	assert.equal(outcome.failureKind, "transient");
});

test("sixteen deterministic resolve policies preserve the same five-chunk result", async () => {
	for (let mask = 0; mask < 16; mask++) {
		const requests = [];
		const settled = [];
		let finished = false;
		const running = runChunkedHistoricalBatch({
			preparedItems: createItems(50),
			maxConcurrency: 2,
			requestChunk: (items, meta) => {
				const deferred = createDeferred();
				requests.push({items, meta, deferred, settled: false});
				return deferred.promise.finally(() => {requests.find(request => request.deferred === deferred).settled = true;});
			},
			onChunkSettled: update => settled.push(update.chunkIndex)
		});
		running.finally(() => {finished = true;});
		let step = 0;
		while (!finished) {
			await settle(); await settle();
			const active = requests.filter(request => !request.settled);
			if (!active.length) continue;
			const choice = active.length === 1 ? 0 : (mask >> Math.min(step, 3)) & 1;
			const request = active[choice];
			request.deferred.resolve(Object.fromEntries(request.items.map(item => [item.message.id, `m${mask}-${item.message.id}`])));
			step++;
		}
		const outcome = await running;
		assert.equal(requests.length, 5, `mask ${mask}`);
		assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1, 2, 3, 4], `mask ${mask}`);
		assert.equal(Object.keys(outcome.translations).length, 50, `mask ${mask}`);
		assert.equal(new Set(settled).size, 5, `mask ${mask}`);
	}
});

test("S3H annotates unresolved IDs by original primary block without changing the enumerable outcome", async () => {
	const preparedItems = Array.from({length: 4}, (_, index) => ({message: {id: `m${index}`}, protectedText: `text-${index}`}));
	const outcome = await runChunkedHistoricalBatch({
		preparedItems,
		chunkSize: 2,
		maxConcurrency: 1,
		requestChunk: (_chunk, meta) => meta.chunkIndex === 0
			? {translations: {m0: "ok"}, failureKind: null, statusCode: 200}
			: {translations: {m2: "ok", m3: "ok"}, failureKind: null, statusCode: 200}
	});
	assert.deepEqual(outcome, {translations: {m0: "ok", m2: "ok", m3: "ok"}, failureKind: null, statusCode: null});
	assert.deepEqual(outcome.historicalFailureBlocks, [{blockId: 0, messageIds: ["m1"]}]);
	assert.equal(Object.prototype.propertyIsEnumerable.call(outcome, "historicalFailureBlocks"), false);
});

test("S5 failure block retains non-enumerable timeout root and physical-settle evidence", async () => {
	const raw = {translations: null, failureKind: "timeout", statusCode: null};
	Object.defineProperty(raw, "historicalPhysicalSettled", {value: true, enumerable: false});
	const outcome = await runChunkedHistoricalBatch({preparedItems: createItems(2), requestChunk: () => raw});
	assert.deepEqual(outcome, {translations: null, failureKind: "timeout", statusCode: null});
	assert.equal(outcome.historicalFailureBlocks[0].failureKind, "timeout");
	assert.equal(outcome.historicalFailureBlocks[0].physicalSettled, true);
	assert.equal(Object.keys(outcome.historicalFailureBlocks[0]).includes("failureKind"), false);
});

test("cap1 continues untouched primary blocks after an exhausted local response", async () => {
	const requests = [];
	const outcome = await runChunkedHistoricalBatch({
		preparedItems: createItems(22), maxConcurrency: 1,
		requestChunk: (items, meta) => {
			requests.push(meta.chunkIndex);
			return meta.chunkIndex === 0 ? {translations: null, failureKind: "semantic_schema", statusCode: 200}
				: Object.fromEntries(items.map(item => [item.message.id, "ok"]));
		}
	});
	assert.deepEqual(requests, [0, 1, 2]);
	assert.equal(Object.keys(outcome.translations).length, 12);
	assert.equal(outcome.historicalFailureBlocks.length, 1);
	assert.equal(outcome.historicalFailureBlocks[0].failureKind, "semantic_schema");
});

test("cap1 global terminal roots dominate an earlier local response failure and stop refill", async () => {
	for (const failureKind of ["auth", "configuration", "schema", "permanent", "request_budget", "attempt_budget"]) {
		const requests = [];
		const outcome = await runChunkedHistoricalBatch({
			preparedItems: createItems(40), maxConcurrency: 1,
			requestChunk: (items, meta) => {
				requests.push(meta.chunkIndex);
				if (meta.chunkIndex === 0) return {translations: null, failureKind: "semantic_schema", statusCode: 200};
				if (meta.chunkIndex === 1) return Object.fromEntries(items.map(item => [item.message.id, "ok"]));
				return {translations: null, failureKind, statusCode: 400};
			}
		});
		assert.deepEqual(requests, [0, 1, 2], failureKind);
		assert.deepEqual(outcome, {translations: null, failureKind, statusCode: 400});
	}
});
test("cap4 local response pressure drains physical siblings and gates each serial refill", async () => {
	const requests = [];
	const pressureEvents = [];
	const gates = [];
	let finished = false;
	const running = runChunkedHistoricalBatch({
		preparedItems: createItems(60), maxConcurrency: 4,
		awaitBeforeDispatch: meta => {
			if (!meta.pressure) return true;
			const gate = createDeferred(); gates.push(gate); return gate.promise;
		},
		onPressure: event => pressureEvents.push(event),
		requestChunk: (items, meta) => {
			const deferred = createDeferred(); requests.push({items, meta, deferred}); return deferred.promise;
		}
	});
	running.then(() => {finished = true;});
	await settle();
	assert.equal(requests.length, 4);
	const failure = {translations: null, failureKind: "semantic_schema", statusCode: 200};
	requests[0].meta.onOutcomeBeforeRelease(failure);
	await settle();
	assert.equal(requests.length, 4);
	assert.equal(finished, false, "publishing outcome does not release physical lease");
	requests[0].deferred.resolve(failure);
	for (const index of [1, 2]) requests[index].deferred.resolve(Object.fromEntries(requests[index].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(gates.length, 0, "one paid sibling still owns the base slot");
	requests[3].deferred.resolve(Object.fromEntries(requests[3].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(gates.length, 1);
	assert.equal(requests.length, 4);
	gates[0].resolve(true);
	await settle(); await settle();
	assert.equal(requests.length, 5);
	assert.equal(requests[4].meta.concurrency, 1);
	requests[4].deferred.resolve(Object.fromEntries(requests[4].items.map(item => [item.message.id, "ok"])));
	await settle(); await settle();
	assert.equal(gates.length, 2);
	assert.equal(requests.length, 5);
	gates[1].resolve(true);
	await settle(); await settle();
	assert.equal(requests.length, 6);
	assert.equal(requests[5].meta.concurrency, 1);
	requests[5].deferred.resolve(Object.fromEntries(requests[5].items.map(item => [item.message.id, "ok"])));
	const outcome = await running;
	assert.equal(Object.keys(outcome.translations).length, 50);
	assert.deepEqual(pressureEvents, [{failureKind: "semantic_schema", chunkIndex: 0}]);
	assert.deepEqual(requests.map(request => request.meta.chunkIndex), [0, 1, 2, 3, 4, 5]);
});

test("cap4 global roots still dominate local response failures and drain without refill", async () => {
	for (const failureKind of ["auth", "configuration", "schema", "permanent", "request_budget", "attempt_budget"]) {
		const requests = [];
		let finished = false;
		const running = runChunkedHistoricalBatch({preparedItems: createItems(60), maxConcurrency: 4, requestChunk: (items, meta) => {
			const deferred = createDeferred(); requests.push({items, meta, deferred}); return deferred.promise;
		}});
		running.then(() => {finished = true;});
		await settle();
		requests[0].deferred.resolve({translations: null, failureKind: "semantic_schema", statusCode: 200});
		requests[1].deferred.resolve({translations: null, failureKind, statusCode: 400});
		requests[2].deferred.resolve(Object.fromEntries(requests[2].items.map(item => [item.message.id, "ok"])));
		await settle(); await settle();
		assert.equal(finished, false);
		assert.equal(requests.length, 4);
		assert.equal(requests[3].meta.isDispatchCurrent(), false);
		requests[3].deferred.resolve({});
		assert.deepEqual(await running, {translations: null, failureKind, statusCode: 400});
	}
});

test("local response pressure respects a denied refill gate and currentness cancellation", async () => {
	for (const mode of ["gate-denied", "cancel"]) {
		let current = true;
		let requests = 0;
		const gate = createDeferred();
		const running = runChunkedHistoricalBatch({preparedItems: createItems(60), maxConcurrency: 4, isCurrent: () => current,
			awaitBeforeDispatch: meta => meta.pressure ? gate.promise : true,
			requestChunk: (items, meta) => {
				requests++;
				return meta.chunkIndex === 0 ? {translations: null, failureKind: "semantic_schema", statusCode: 200}
					: Object.fromEntries(items.map(item => [item.message.id, "ok"]));
			}
		});
		await settle();
		const dispatchedBeforeGate = requests;
		if (mode === "cancel") current = false;
		gate.resolve(mode !== "gate-denied");
		const outcome = await running;
		assert.equal(requests, dispatchedBeforeGate);
		assert.ok(requests <= 4);
		if (mode === "cancel") assert.equal(outcome, null);
		else assert.equal(outcome.historicalFailureBlocks[0].failureKind, "semantic_schema");
	}
});
test("cap1 global failures stop after clean then local or malformed siblings", async () => {
	for (const localKind of ["semantic_schema", "malformed"]) for (const failureKind of ["auth", "configuration"]) {
		const requests = [];
		const outcome = await runChunkedHistoricalBatch({preparedItems: createItems(40), maxConcurrency: 1, requestChunk: (items, meta) => {
			requests.push(meta.chunkIndex);
			if (meta.chunkIndex === 1) return {translations: null, failureKind: localKind, statusCode: 200};
			if (meta.chunkIndex === 2) return {translations: null, failureKind, statusCode: 400};
			return Object.fromEntries(items.map(item => [item.message.id, "ok"]));
		}});
		assert.deepEqual(requests, [0, 1, 2], `${localKind} then ${failureKind}`);
		assert.deepEqual(outcome, {translations: null, failureKind, statusCode: 400});
	}
});
test("optional chunk outcomes publish a fast block once without awaiting its consumer", async () => {
	const requests = [];
	const events = [];
	const consumer = createDeferred();
	const running = runChunkedHistoricalBatch({preparedItems: createItems(22), maxConcurrency: 4,
		requestChunk: (items, meta) => {const deferred = createDeferred(); requests.push({items, meta, deferred}); return deferred.promise;},
		onChunkOutcome: event => {events.push(event); return consumer.promise;}
	});
	await settle();
	const first = Object.fromEntries(requests[0].items.map(item => [item.message.id, "fast"]));
	requests[0].meta.onOutcomeBeforeRelease(first);
	assert.equal(events.length, 1, "result is visible while slower physical siblings remain pending");
	assert.equal(events[0].chunkIndex, 0);
	assert.equal(events[0].chunkCount, 3);
	assert.deepEqual(events[0].preparedItems.map(item => item.message.id), ["100", "101", "102", "103", "104", "105", "106", "107", "108", "109"]);
	assert.deepEqual(events[0].outcome, {translations: first, failureKind: null, statusCode: null});
	assert.equal(events[0].isCurrent(), true);
	requests[0].deferred.resolve(first);
	await settle();
	assert.equal(events.length, 1, "before-release and promise completion are one notification");
	for (const request of requests.slice(1)) request.deferred.resolve(Object.fromEntries(request.items.map(item => [item.message.id, "slow"])));
	const outcome = await running;
	assert.equal(Object.keys(outcome.translations).length, 22);
	assert.equal(events.length, 3, "an unresolved consumer promise does not block transport completion");
	consumer.resolve();
});
test("optional chunk outcomes cover single and cap1 without altering progress or duplicate delivery", async () => {
	for (const maxConcurrency of [1, 4]) for (const count of [2, 22]) {
		const events = [], progress = [];
		const outcome = await runChunkedHistoricalBatch({preparedItems: createItems(count), maxConcurrency,
			requestChunk: (items, meta) => {
				const raw = Object.fromEntries(items.map(item => [item.message.id, "ok"]));
				meta.onOutcomeBeforeRelease(raw); meta.onOutcomeBeforeRelease(raw);
				return Promise.resolve(raw);
			},
			onChunkSettled: value => progress.push(value),
			onChunkOutcome: value => events.push(value)
		});
		assert.equal(events.length, count === 2 ? 1 : 3);
		assert.equal(progress.length, count === 2 ? 0 : 3, "single-chunk legacy progress stays silent");
		assert.deepEqual(events.map(event => event.chunkIndex), count === 2 ? [0] : [0, 1, 2]);
		assert.equal(events.reduce((sum, event) => sum + event.preparedItems.length, 0), count);
		assert.ok(events.every(event => event.isCurrent()));
		assert.ok(progress.every(event => Object.keys(event).sort().join() === "answered,chunkCount,chunkIndex,total"));
		assert.equal(Object.keys(outcome.translations).length, count);
	}
});
test("global terminal outcome emits once and invalidates all earlier deferred deliveries", async () => {
	for (const maxConcurrency of [1, 4]) for (const failureKind of ["auth", "configuration", "schema", "permanent", "request_budget", "attempt_budget"]) {
		const events = [];
		const outcome = await runChunkedHistoricalBatch({preparedItems: createItems(30), maxConcurrency,
			requestChunk: (items, meta) => meta.chunkIndex === 1
				? {translations: null, failureKind, statusCode: 400}
				: Object.fromEntries(items.map(item => [item.message.id, "ok"])),
			onChunkOutcome: event => events.push(event)
		});
		assert.deepEqual(events.map(event => event.chunkIndex), [0, 1]);
		assert.equal(events[1].outcome.failureKind, failureKind);
		assert.equal(events[0].isCurrent(), false);
		assert.equal(events[1].isCurrent(), false);
		assert.deepEqual(outcome, {translations: null, failureKind, statusCode: 400});
	}
});

test("cancelled-before-dispatch blocks new chunk outcomes and invalidates an earlier event", async () => {
	const events = [];
	await runChunkedHistoricalBatch({preparedItems: createItems(30), maxConcurrency: 4,
		requestChunk: (items, meta) => meta.chunkIndex === 1 ? {cancelledBeforeDispatch: true}
			: Object.fromEntries(items.map(item => [item.message.id, "ok"])),
		onChunkOutcome: event => events.push(event)
	});
	assert.deepEqual(events.map(event => event.chunkIndex), [0]);
	assert.equal(events[0].isCurrent(), false);
});
test("optional chunk outcome observer exceptions never reject or stall the provider batch", async () => {
	for (const mode of ["throw", "reject", "then-getter"]) {
		let notifications = 0;
		const result = await runChunkedHistoricalBatch({preparedItems: createItems(22), maxConcurrency: 4,
			requestChunk: items => Object.fromEntries(items.map(item => [item.message.id, "ok"])),
			onChunkOutcome: () => {
				notifications++;
				if (mode === "throw") throw new Error("observer threw");
				if (mode === "reject") return Promise.reject(new Error("observer rejected"));
				return {get then() {throw new Error("then getter threw");}};
			}
		});
		await settle();
		assert.equal(notifications, 3);
		assert.equal(Object.keys(result.translations).length, 22);
	}
});

test("optional chunk outcomes suppress stale single, serial and concurrent results", async () => {
	for (const maxConcurrency of [1, 4]) for (const count of [2, 22]) {
		let current = true;
		const requests = [], events = [];
		const running = runChunkedHistoricalBatch({preparedItems: createItems(count), maxConcurrency, isCurrent: () => current,
			requestChunk: (items, meta) => {const deferred = createDeferred(); requests.push({items, meta, deferred}); return deferred.promise;},
			onChunkOutcome: event => events.push(event)
		});
		await settle();
		current = false;
		for (const request of requests) {
			const raw = Object.fromEntries(request.items.map(item => [item.message.id, "late"]));
			request.meta.onOutcomeBeforeRelease(raw);
			request.deferred.resolve(raw);
		}
		await running;
		assert.equal(events.length, 0);
	}
});

test("local exhausted and thrown outcomes do not suppress paid successful sibling delivery", async () => {
	const requests = [], events = [];
	const running = runChunkedHistoricalBatch({preparedItems: createItems(30), maxConcurrency: 4,
		requestChunk: (items, meta) => {const deferred = createDeferred(); requests.push({items, meta, deferred}); return deferred.promise;},
		onChunkOutcome: event => events.push(event)
	});
	await settle();
	requests[0].deferred.resolve({translations: null, failureKind: "semantic_schema", statusCode: 200});
	requests[1].deferred.reject(new Error("paid sibling threw"));
	await settle();
	requests[2].deferred.resolve(Object.fromEntries(requests[2].items.map(item => [item.message.id, "survivor"])));
	const result = await running;
	assert.deepEqual(events.map(event => event.chunkIndex), [0, 2]);
	assert.equal(events[0].outcome.failureKind, "semantic_schema");
	assert.ok(events.every(event => event.isCurrent()));
	assert.equal(Object.keys(events[1].outcome.translations).length, 10);
	assert.equal(Object.keys(result.translations).length, 10);
	assert.equal(result.historicalFailureBlocks[0].failureKind, "semantic_schema");
});