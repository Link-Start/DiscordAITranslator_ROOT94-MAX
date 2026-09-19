// Splits historical provider work while retaining the original merged outcome and
// settle-counted progress. Optional chunk outcomes let the job validate completed
// blocks before their siblings; this transport layer never commits display results.
const {normalizeBatchOutcome} = require("./historical-translation-job");

const HISTORICAL_PROVIDER_CHUNK_SIZE = 10;
const HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT = 12000;
const HISTORICAL_PROVIDER_CONCURRENCY_MAX = 4;

function preparedItemCharacters(item) {
	return String(item && item.protectedText || "").length;
}

function chunkPreparedItems(preparedItems, chunkSize, chunkCharLimit) {
	const chunks = [];
	let chunk = [];
	let characters = 0;
	for (const item of preparedItems) {
		const itemCharacters = preparedItemCharacters(item);
		if (chunk.length && (chunk.length >= chunkSize || characters + itemCharacters > chunkCharLimit)) {
			chunks.push(chunk);
			chunk = [];
			characters = 0;
		}
		chunk.push(item);
		characters += itemCharacters;
		// An indivisible oversized message is kept intact, but it owns the request so
		// no neighbour increases an already exceptional payload.
		if (chunk.length >= chunkSize || characters > chunkCharLimit) {
			chunks.push(chunk);
			chunk = [];
			characters = 0;
		}
	}
	if (chunk.length) chunks.push(chunk);
	return chunks;
}

function isTerminalFailure(failureKind) {
	return ["auth", "configuration", "schema", "permanent", "request_budget", "attempt_budget"].includes(failureKind);
}

function selectDeterministicFailure(current, candidate, priorities) {
	if (!current) return candidate;
	const currentPriority = priorities[current.failureKind] || 0;
	const candidatePriority = priorities[candidate.failureKind] || 0;
	if (candidatePriority !== currentPriority) return candidatePriority > currentPriority ? candidate : current;
	return candidate.chunkIndex < current.chunkIndex ? candidate : current;
}

function runChunkedHistoricalBatch({
	preparedItems,
	chunkSize = HISTORICAL_PROVIDER_CHUNK_SIZE,
	chunkCharLimit = HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT,
	requestChunk,
	isCurrent = null,
	onChunkSettled = null,
	onChunkOutcome = null,
	maxConcurrency = 1,
	getDesiredConcurrency = null,
	awaitBeforeDispatch = null,
	onPressure = null
}) {
	if (!Array.isArray(preparedItems) || !preparedItems.length) return Promise.resolve(null);
	const size = Math.max(1, Math.floor(chunkSize) || HISTORICAL_PROVIDER_CHUNK_SIZE);
	const charLimit = Math.max(1, Math.floor(chunkCharLimit) || HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT);
	if (!requestChunk) return Promise.resolve(null);
	const chunks = chunkPreparedItems(preparedItems, size, charLimit);
	const blockFailureMeta = new Map();
	const hasExhaustedResponseBlock = () => [...blockFailureMeta.values()].some(block => block.failureKind === "semantic_schema");
	const noteBlockFailure = (blockId, rawOutcome) => {
		const normalized = normalizeBatchOutcome(rawOutcome);
		if (normalized && normalized.failureKind) blockFailureMeta.set(blockId, {failureKind: normalized.failureKind, physicalSettled: rawOutcome && rawOutcome.historicalPhysicalSettled === true});
		return normalized;
	};
	const withFailureBlocks = outcome => {
		if (!outcome || typeof outcome != "object") return outcome;
		const translations = outcome.translations && typeof outcome.translations == "object" ? outcome.translations : {};
		const blocks = chunks.map((chunk, blockId) => ({blockId, messageIds: chunk.map(item => item && item.message && String(item.message.id)).filter(messageId => messageId && !Object.prototype.hasOwnProperty.call(translations, messageId))})).filter(block => block.messageIds.length);
		if (!blocks.length) return outcome;
		const frozenBlocks = Object.freeze(blocks.map(block => {
			const value = {blockId: block.blockId, messageIds: Object.freeze(block.messageIds)};
			const failure = blockFailureMeta.get(block.blockId);
			if (failure) {Object.defineProperty(value, "failureKind", {value: failure.failureKind, enumerable: false}); Object.defineProperty(value, "physicalSettled", {value: failure.physicalSettled, enumerable: false});}
			return Object.freeze(value);
		}));
		try {Object.defineProperty(outcome, "historicalFailureBlocks", {value: frozenBlocks, enumerable: false}); return outcome;}
		catch (error) {const copy = Object.assign({}, outcome); Object.defineProperty(copy, "historicalFailureBlocks", {value: frozenBlocks, enumerable: false}); return copy;}
	};
	const concurrency = Math.max(1, Math.min(HISTORICAL_PROVIDER_CONCURRENCY_MAX, Math.floor(Number(maxConcurrency)) || 1));
	const current = () => {
		try {return !isCurrent || !!isCurrent();}
		catch (error) {return false;}
	};
	let outcomeBlocked = false;
	const outcomeIsCurrent = () => !outcomeBlocked && current();
	const notifyOutcome = (index, rawOutcome) => {
		const outcome = normalizeBatchOutcome(rawOutcome);
		if (rawOutcome && rawOutcome.cancelledBeforeDispatch || !current()) {outcomeBlocked = true; return;}
		const alreadyBlocked = outcomeBlocked;
		if (isTerminalFailure(outcome.failureKind)) outcomeBlocked = true;
		// The first global failure is itself a stop event; its currentness is false.
		if (typeof onChunkOutcome !== "function" || alreadyBlocked) return;
		try {
			const pending = onChunkOutcome({preparedItems: chunks[index], outcome, isCurrent: outcomeIsCurrent, chunkIndex: index, chunkCount: chunks.length});
			if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
		}
		catch (error) {}
	};
	const notifyPressure = (failureKind, index) => {
		if (!failureKind || !onPressure) return;
		try {onPressure({failureKind, chunkIndex: index});}
		catch (error) {}
	};
	// Control hooks are deliberately non-enumerable: the cap-1 request metadata
	// remains byte-for-byte/deep-equal compatible, while the physical owner can make
	// a final currentness decision and publish an outcome before releasing its lease.
	const createChunkMeta = (chunkIndex, chunkCount, additions = null) => {
		const meta = {chunkIndex, chunkCount};
		for (const [key, value] of Object.entries(additions || {})) Object.defineProperty(meta, key, {value, enumerable: false});
		return meta;
	};
	if (chunks.length === 1) {
		const onlyChunk = chunks[0];
		let outcomeHandled = false;
		let errorHandled = false;
		const handleOutcome = rawOutcome => {
			if (outcomeHandled) return;
			outcomeHandled = true;
			const normalized = noteBlockFailure(0, rawOutcome);
			if (normalized && normalized.failureKind) notifyPressure(normalized.failureKind, 0);
			notifyOutcome(0, rawOutcome);
		};
		const handleError = () => {
			if (errorHandled) return;
			errorHandled = true;
			notifyPressure("thrown", 0);
		};
		let request;
		try {
			request = requestChunk(onlyChunk, createChunkMeta(0, 1, {
				isDispatchCurrent: current,
				onOutcomeBeforeRelease: handleOutcome,
				onErrorBeforeRelease: handleError
			}));
		}
		catch (error) {
			handleError(error);
			return Promise.reject(error);
		}
		return Promise.resolve(request).then(outcome => {
			handleOutcome(outcome);
			if (outcome && outcome.cancelledBeforeDispatch) return null;
			if (concurrency > 1 && !current()) return null;
			return withFailureBlocks(normalizeBatchOutcome(outcome));
		}, error => {
			handleError(error);
			throw error;
		});
	}
	// The sequential path retains its request bytes/order/progress. A block-local
	// exhausted response does not suppress the remaining untouched primary chunks.
	if (concurrency === 1) return (async () => {
		const translations = {};
		let firstFailure = null;
		let answered = 0;
		for (let index = 0; index < chunks.length; index++) {
			if (isCurrent && !isCurrent()) break;
			let rawOutcome;
			let outcomeHandled = false;
			let errorHandled = false;
			const handleOutcome = outcome => {
				if (outcomeHandled) return;
				outcomeHandled = true;
				const normalized = noteBlockFailure(index, outcome);
				if (normalized && normalized.failureKind) notifyPressure(normalized.failureKind, index);
				notifyOutcome(index, outcome);
			};
			const handleError = () => {
				if (errorHandled) return;
				errorHandled = true;
				notifyPressure("thrown", index);
			};
			try {
				rawOutcome = await requestChunk(chunks[index], createChunkMeta(index, chunks.length, {
					isDispatchCurrent: current,
					onOutcomeBeforeRelease: handleOutcome,
					onErrorBeforeRelease: handleError
				}));
			}
			catch (error) {
				handleError(error);
				// Preserve exhausted-block identity if a later sibling throws; otherwise
				// the job catches a bare exception and buys repair for those IDs again.
				if (hasExhaustedResponseBlock()) return withFailureBlocks({translations: Object.keys(translations).length ? translations : null, failureKind: "transient", statusCode: null});
				throw error;
			}
			handleOutcome(rawOutcome);
			const outcome = noteBlockFailure(index, rawOutcome);
			if (outcome && outcome.translations) Object.assign(translations, outcome.translations);
			else if (!firstFailure && outcome && outcome.failureKind) firstFailure = {failureKind: outcome.failureKind, statusCode: outcome.statusCode == null ? null : outcome.statusCode};
			answered += chunks[index].length;
			if (onChunkSettled) {
				try {onChunkSettled({answered, total: preparedItems.length, chunkIndex: index, chunkCount: chunks.length});}
				catch (error) {}
			}
			// Global provider/budget failures dominate even after a local failure or
			// successful sibling. Exhausted local blocks remain terminal only for their IDs.
			if (outcome && isTerminalFailure(outcome.failureKind)) return withFailureBlocks({translations: null, failureKind: outcome.failureKind, statusCode: outcome.statusCode == null ? null : outcome.statusCode});
		}
		if (!Object.keys(translations).length) return firstFailure ? withFailureBlocks({translations: null, failureKind: firstFailure.failureKind, statusCode: firstFailure.statusCode}) : null;
		return withFailureBlocks({translations, failureKind: firstFailure ? firstFailure.failureKind : null, statusCode: firstFailure ? firstFailure.statusCode : null});
	})();

	// Exhausted response-shape failures belong to their original block; they still
	// exert pressure, but do not discard validated-capable siblings.
	const terminalKinds = new Set(["auth", "configuration", "schema", "permanent", "request_budget", "attempt_budget"]);
	const terminalPriorities = {auth: 7, configuration: 6, schema: 5, request_budget: 3, attempt_budget: 2, permanent: 1};
	const nonTerminalPriorities = {semantic_schema: 4, transient: 3, malformed: 2, thrown: 1};
	return (async () => {
		const outcomes = new Array(chunks.length);
		let firstFailure = null;
		let answered = 0;
		let nextIndex = 0;
		let active = 0;
		let pressure = false;
		let terminalFailure = null;
		let firstThrown = null;
		let stopped = false;
		let pumping = false;
		let pumpAgain = false;
		let doneResolve;
		const done = new Promise(resolve => {doneResolve = resolve;});

		const notifySettled = index => {
			answered += chunks[index].length;
			if (!onChunkSettled) return;
			try {onChunkSettled({answered, total: preparedItems.length, chunkIndex: index, chunkCount: chunks.length});}
			catch (error) {}
		};
		const desiredConcurrency = () => {
			if (pressure) return 1;
			if (!getDesiredConcurrency) return concurrency;
			try {return Math.max(1, Math.min(concurrency, Math.floor(Number(getDesiredConcurrency())) || 1));}
			catch (error) {return 1;}
		};
		const maybeDone = () => {
			if (!pumping && active === 0 && (stopped || nextIndex >= chunks.length)) doneResolve();
		};
		const settle = (index, rawOutcome) => {
			if (!current()) {
				outcomeBlocked = true;
				stopped = true;
				return;
			}
			if (rawOutcome && rawOutcome.cancelledBeforeDispatch) {
				outcomeBlocked = true;
				stopped = true;
				return;
			}
			const outcome = noteBlockFailure(index, rawOutcome);
			outcomes[index] = outcome;
			notifyOutcome(index, rawOutcome);
			notifySettled(index);
			if (!outcome || !outcome.failureKind) return;
			const failure = {failureKind: outcome.failureKind, statusCode: outcome.statusCode == null ? null : outcome.statusCode, chunkIndex: index};
			if (terminalKinds.has(outcome.failureKind)) {
				terminalFailure = selectDeterministicFailure(terminalFailure, failure, terminalPriorities);
				stopped = true;
				notifyPressure(outcome.failureKind, index);
				return;
			}
			firstFailure = selectDeterministicFailure(firstFailure, failure, nonTerminalPriorities);
			// A pressured/malformed response can still preserve successful siblings, but
			// this job loses its speculative second slot for every remaining primary chunk.
			pressure = true;
			notifyPressure(outcome.failureKind, index);
		};
		const launch = index => {
			active++;
			let request;
			let outcomeHandled = false;
			let errorHandled = false;
			const handleOutcome = rawOutcome => {
				if (outcomeHandled || errorHandled) return;
				outcomeHandled = true;
				settle(index, rawOutcome);
			};
			const handleError = error => {
				if (errorHandled || outcomeHandled) return;
				errorHandled = true;
				firstThrown = firstThrown || error;
				pressure = true;
				stopped = true;
				notifyPressure("thrown", index);
			};
			try {
				const meta = createChunkMeta(index, chunks.length, {
					isDispatchCurrent: () => !stopped && current(),
					onOutcomeBeforeRelease: handleOutcome,
					onErrorBeforeRelease: handleError,
					onDesiredConcurrencyChanged: queuePump
				});
				meta.concurrency = desiredConcurrency();
				request = requestChunk(chunks[index], meta);
			}
			catch (error) {
				handleError(error);
				active--;
				queuePump();
				return;
			}
			Promise.resolve(request).then(outcome => handleOutcome(outcome), error => handleError(error)).finally(() => {
				active--;
				queuePump();
			});
		};
		async function pump() {
			if (pumping) {pumpAgain = true; return;}
			pumping = true;
			try {
				while (!stopped && nextIndex < chunks.length && current()) {
					const desired = desiredConcurrency();
					if (active >= desired) break;
					const index = nextIndex;
					if (awaitBeforeDispatch) {
						let allowed = false;
						try {allowed = await awaitBeforeDispatch({chunkIndex: index, chunkCount: chunks.length, pressure});}
						catch (error) {firstThrown = firstThrown || error; stopped = true; break;}
						if (allowed === false || !current()) {stopped = true; break;}
						if (active >= desiredConcurrency()) break;
					}
					nextIndex++;
					launch(index);
				}
				if (!current()) stopped = true;
			}
			finally {
				pumping = false;
				const rerun = pumpAgain;
				pumpAgain = false;
				if (rerun && !stopped) queuePump();
				maybeDone();
			}
		}
		function queuePump() {
			if (typeof queueMicrotask == "function") queueMicrotask(pump);
			else Promise.resolve().then(pump);
		}

		await pump();
		await done;
		if (terminalFailure) return withFailureBlocks({translations: null, failureKind: terminalFailure.failureKind, statusCode: terminalFailure.statusCode});
		if (!current()) return null;
		const translations = {};
		for (const outcome of outcomes) if (outcome && outcome.translations) Object.assign(translations, outcome.translations);
		if (firstThrown && !Object.keys(translations).length && !hasExhaustedResponseBlock()) throw firstThrown;
		if (firstThrown) return withFailureBlocks({translations, failureKind: "transient", statusCode: null});
		if (!Object.keys(translations).length) return firstFailure ? withFailureBlocks({translations: null, failureKind: firstFailure.failureKind, statusCode: firstFailure.statusCode}) : null;
		return withFailureBlocks({translations, failureKind: firstFailure ? firstFailure.failureKind : null, statusCode: firstFailure ? firstFailure.statusCode : null});
	})();
}

module.exports = {runChunkedHistoricalBatch, HISTORICAL_PROVIDER_CHUNK_SIZE, HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT, HISTORICAL_PROVIDER_CONCURRENCY_MAX};
