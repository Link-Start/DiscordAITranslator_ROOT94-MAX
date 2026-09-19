const PROVIDER_COMPATIBILITY_RETRY_MAX = 1;

function createProviderCompatibilityBudget({maxRetries = PROVIDER_COMPATIBILITY_RETRY_MAX} = {}) {
	const limit = Math.max(0, Math.min(PROVIDER_COMPATIBILITY_RETRY_MAX, Math.floor(Number(maxRetries)) || 0));
	let used = 0;
	const reasons = [];
	return Object.freeze({
		consume(reason = "compatibility") {
			if (used >= limit) return false;
			used++;
			reasons.push(String(reason));
			return true;
		},
		getSnapshot: () => Object.freeze({limit, used, remaining: Math.max(0, limit - used), reasons: Object.freeze(reasons.slice())})
	});
}

function createProviderAttemptOwner({
	createAbortController = () => new AbortController(),
	clearTimeout = timer => globalThis.clearTimeout(timer)
} = {}) {
	let generation = 0;
	let sequence = 0;
	let highWater = 0;
	const active = new Map();
	const drainWaiters = [];

	function owns(token) {
		const entry = token && active.get(token.id);
		return !!entry && entry.token === token && token.generation === generation;
	}

	function resolveDrains() {
		for (let index = drainWaiters.length - 1; index >= 0; index--) {
			const waiter = drainWaiters[index];
			if ([...waiter.ids].some(id => active.has(id))) continue;
			drainWaiters.splice(index, 1);
			waiter.resolve();
		}
	}

	function begin({logicalRequestId = null, role = "primary", signal = null} = {}) {
		const token = Object.freeze({id: `attempt-${++sequence}`, generation});
		const entry = {
			token,
			logicalRequestId: logicalRequestId == null ? null : String(logicalRequestId),
			role: String(role),
			controller: createAbortController(),
			externalSignal: signal && typeof signal.addEventListener == "function" ? signal : null,
			onExternalAbort: null,
			reader: null,
			decoder: null,
			timer: null,
			bufferBytes: 0,
			finished: false
		};
		active.set(token.id, entry);
		highWater = Math.max(highWater, active.size);
		if (entry.externalSignal) {
			entry.onExternalAbort = () => abort(token, entry.externalSignal.reason || "logical-cancelled");
			try {entry.externalSignal.addEventListener("abort", entry.onExternalAbort, {once: true});}
			catch (error) {entry.externalSignal = null; entry.onExternalAbort = null;}
			if (entry.externalSignal && entry.externalSignal.aborted) entry.onExternalAbort();
		}
		return token;
	}

	function entryFor(token) {return owns(token) ? active.get(token.id) : null;}

	function getSignal(token) {
		const entry = entryFor(token);
		return entry && entry.controller && entry.controller.signal || null;
	}

	function attachReader(token, reader) {
		const entry = entryFor(token);
		if (!entry || !reader) return false;
		entry.reader = reader;
		return true;
	}

	function attachDecoder(token, decoder) {
		const entry = entryFor(token);
		if (!entry || !decoder) return false;
		entry.decoder = decoder;
		return true;
	}

	function attachTimer(token, timer) {
		const entry = entryFor(token);
		if (!entry) return false;
		if (entry.timer != null) try {clearTimeout(entry.timer);} catch (error) {}
		entry.timer = timer;
		return true;
	}

	function setBufferBytes(token, value) {
		const entry = entryFor(token);
		if (!entry) return false;
		entry.bufferBytes = Math.max(0, Math.floor(Number(value)) || 0);
		return true;
	}

	function releaseResources(entry) {
		if (entry.timer != null) try {clearTimeout(entry.timer);} catch (error) {}
		if (entry.externalSignal && entry.onExternalAbort) {
			try {entry.externalSignal.removeEventListener("abort", entry.onExternalAbort);}
			catch (error) {}
		}
		entry.timer = null;
		entry.externalSignal = null;
		entry.onExternalAbort = null;
		entry.reader = null;
		entry.decoder = null;
		entry.bufferBytes = 0;
	}

	function finish(token) {
		const entry = entryFor(token);
		if (!entry || entry.finished) return false;
		entry.finished = true;
		releaseResources(entry);
		active.delete(token.id);
		resolveDrains();
		return true;
	}

	function abort(token, reason = "cancelled") {
		const entry = entryFor(token);
		if (!entry || entry.finished) return false;
		try {if (entry.controller && !entry.controller.signal.aborted) entry.controller.abort(reason);}
		catch (error) {}
		try {if (entry.reader && typeof entry.reader.cancel == "function") Promise.resolve(entry.reader.cancel(reason)).catch(() => {});}
		catch (error) {}
		return finish(token);
	}

	function abortAll(reason = "cancelled") {
		const tokens = [...active.values()].map(entry => entry.token);
		for (const token of tokens) abort(token, reason);
		generation++;
		resolveDrains();
		return tokens.length;
	}

	function drain() {
		const ids = new Set(active.keys());
		if (!ids.size) return Promise.resolve();
		return new Promise(resolve => drainWaiters.push({ids, resolve}));
	}

	function getSnapshot() {
		let readerCount = 0, decoderCount = 0, timerCount = 0, logicalSignalCount = 0, bufferBytes = 0;
		for (const entry of active.values()) {
			if (entry.reader) readerCount++;
			if (entry.decoder) decoderCount++;
			if (entry.timer != null) timerCount++;
			if (entry.externalSignal) logicalSignalCount++;
			bufferBytes += entry.bufferBytes;
		}
		return Object.freeze({generation, active: active.size, highWater, controllerCount: active.size, readerCount, decoderCount, timerCount, logicalSignalCount, bufferBytes});
	}

	return Object.freeze({begin, owns, getSignal, attachReader, attachDecoder, attachTimer, setBufferBytes, finish, abort, abortAll, drain, getSnapshot});
}

module.exports = {PROVIDER_COMPATIBILITY_RETRY_MAX, createProviderCompatibilityBudget, createProviderAttemptOwner};
