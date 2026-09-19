const HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION = 1;
const HISTORICAL_PRIMARY_SAMPLE_CAPACITY = 256;
const HISTORICAL_PRIMARY_SAMPLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORICAL_PRIMARY_SAMPLE_MAX_BYTES = 1024 * 1024;
const HISTORICAL_VALIDATION_REASONS = Object.freeze(["missing_id", "empty", "placeholder_missing", "wrong_language", "same_as_source", "too_similar", "policy_rejected", "unknown"]);
const VALIDATION_REASON_SET = new Set(HISTORICAL_VALIDATION_REASONS);
const HISTORICAL_VALIDATION_REASON_SUGGESTIONS = Object.freeze({missing_id: "retryable_candidate", empty: "retryable_candidate", placeholder_missing: "retryable_candidate", wrong_language: "retryable_candidate", same_as_source: "terminal_candidate", too_similar: "terminal_candidate", policy_rejected: "terminal_candidate", unknown: "retryable_candidate"});

function finiteOrNull(value) {
	if (value == null || !Number.isFinite(Number(value))) return null;
	return Math.max(0, Number(value));
}

function whole(value, fallback = 0) {
	const number = finiteOrNull(value);
	return number == null ? fallback : Math.floor(number);
}

function boundedEnum(value, fallback = null) {
	if (value == null || value === "") return fallback;
	const text = String(value).toLowerCase();
	return /^[a-z0-9_.:-]{1,40}$/.test(text) ? text : fallback;
}

function anonymousKey(value, prefix) {
	const text = String(value || "");
	return text.startsWith(prefix) && /^[a-z0-9:-]{4,80}$/i.test(text) ? text : null;
}

function emptyReasons() {
	return Object.fromEntries(HISTORICAL_VALIDATION_REASONS.map(reason => [reason, 0]));
}

function emptyCounters() {
	return {
		cache: {hit: 0, miss: 0, invalidated: 0},
		repairs: {batchRequests: 0, batchMessages: 0, itemRequests: 0, itemMessages: 0},
		finalOutcomes: {translated: 0, skipped: 0, failed: 0},
		validationReasons: emptyReasons(),
		cancelledPrimary: 0,
		pressurePrimary: 0,
		liveOverlapPrimary: 0
	};
}

function normalizeReason(value) {
	// Typed validation uses hyphens; persisted historical counters retain their S8 names.
	const label = String(value || "unknown").replace(/-/g, "_");
	const reason = label === "placeholder_mismatch" ? "placeholder_missing" : label;
	return VALIDATION_REASON_SET.has(reason) ? reason : "unknown";
}

function normalizeUsage(value) {
	return {
		promptTokens: finiteOrNull(value && value.promptTokens),
		completionTokens: finiteOrNull(value && value.completionTokens),
		reasoningTokens: finiteOrNull(value && value.reasoningTokens)
	};
}

function normalizeReasons(value) {
	const reasons = emptyReasons();
	for (const reason of HISTORICAL_VALIDATION_REASONS) reasons[reason] = whole(value && value[reason]);
	return reasons;
}

function normalizeFinal(value) {
	return {translated: whole(value && value.translated), skipped: whole(value && value.skipped), failed: whole(value && value.failed)};
}

// Only observed settle events contribute. This is a transport-duration sum, not
// elapsed chunk/job wall time; old samples have no reconstructable attempt total.
function normalizeTransportAttempts(value) {
	if (!value || typeof value !== "object") return null;
	const requestCount = whole(value.requestCount), measuredDurationCount = Math.min(requestCount, whole(value.measuredDurationCount));
	return {requestCount, measuredDurationCount, unknownDurationCount: requestCount - measuredDurationCount, durationMs: finiteOrNull(value.durationMs) || 0};
}

function normalizeSample(raw, fallbackId, now) {
	if (!raw || typeof raw !== "object") return null;
	const transportKey = anonymousKey(raw.transportKey, "tk1:");
	const workloadKey = anonymousKey(raw.workloadKey, "wk1:");
	if (!transportKey || !workloadKey) return null;
	const usage = normalizeUsage(raw.usage || raw.actualTokens);
	const recordedAt = finiteOrNull(raw.recordedAt) == null ? now : finiteOrNull(raw.recordedAt);
	return {
		sampleId: Math.max(1, whole(raw.sampleId, fallbackId) || fallbackId),
		recordedAt,
		transportKey,
		workloadKey,
		itemCount: Math.max(1, whole(raw.itemCount, 1)),
		protectedChars: whole(raw.protectedChars != null ? raw.protectedChars : raw.inputChars),
		inputChars: whole(raw.inputChars),
		promptChars: whole(raw.promptChars),
		outputChars: finiteOrNull(raw.outputChars),
		bodyBytes: whole(raw.bodyBytes),
		estimatedTokens: whole(raw.estimatedTokens != null ? raw.estimatedTokens : Math.ceil(whole(raw.bodyBytes) / 4)),
		usage,
		durationMs: finiteOrNull(raw.durationMs),
		transportAttempts: normalizeTransportAttempts(raw.transportAttempts),
		effectiveCap: Math.max(1, Math.min(4, whole(raw.effectiveCap, 1) || 1)),
		wave: whole(raw.wave),
		httpStatus: finiteOrNull(raw.httpStatus),
		finishReason: boundedEnum(raw.finishReason),
		status: boundedEnum(raw.status, "unknown"),
		outcome: boundedEnum(raw.outcome, "unknown"),
		repair: !!raw.repair,
		cancelled: !!raw.cancelled,
		liveOverlap: !!raw.liveOverlap,
		cache: !!raw.cache,
		contaminated: !!raw.contaminated,
		trainingEligible: raw.trainingEligible === true,
		validationReasons: normalizeReasons(raw.validationReasons),
		final: normalizeFinal(raw.final)
	};
}

function normalizeCounters(value) {
	const counters = emptyCounters();
	for (const key of Object.keys(counters.cache)) counters.cache[key] = whole(value && value.cache && value.cache[key]);
	for (const key of Object.keys(counters.repairs)) counters.repairs[key] = whole(value && value.repairs && value.repairs[key]);
	for (const key of Object.keys(counters.finalOutcomes)) counters.finalOutcomes[key] = whole(value && value.finalOutcomes && value.finalOutcomes[key]);
	counters.validationReasons = normalizeReasons(value && value.validationReasons);
	counters.cancelledPrimary = whole(value && value.cancelledPrimary);
	counters.pressurePrimary = whole(value && value.pressurePrimary);
	counters.liveOverlapPrimary = whole(value && value.liveOverlapPrimary);
	return counters;
}

function rank(values) {
	const indexed = values.map((value, index) => ({value, index})).sort((a, b) => a.value - b.value);
	const ranks = new Array(values.length);
	for (let start = 0; start < indexed.length;) {
		let end = start + 1;
		while (end < indexed.length && indexed[end].value === indexed[start].value) end++;
		const average = (start + end - 1) / 2 + 1;
		for (let index = start; index < end; index++) ranks[indexed[index].index] = average;
		start = end;
	}
	return ranks;
}

function correlation(left, right) {
	if (left.length < 2 || left.length !== right.length) return null;
	const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
	const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
	let numerator = 0, leftSquare = 0, rightSquare = 0;
	for (let index = 0; index < left.length; index++) {
		const a = left[index] - leftMean, b = right[index] - rightMean;
		numerator += a * b;
		leftSquare += a * a;
		rightSquare += b * b;
	}
	const denominator = Math.sqrt(leftSquare * rightSquare);
	return denominator ? numerator / denominator : null;
}

function predictionMetrics(samples) {
	if (samples.length < 2) return {mapePercent: null, spearman: null};
	const work = sample => Math.max(1, sample.bodyBytes + (sample.outputChars || 0) * 2 + (sample.usage.promptTokens || 0) + (sample.usage.completionTokens || 0) + (sample.usage.reasoningTokens || 0));
	const predicted = samples.map((sample, index) => {
		let rateSum = 0, rateCount = 0;
		for (let other = 0; other < samples.length; other++) {
			if (other === index || !samples[other].durationMs) continue;
			rateSum += samples[other].durationMs / work(samples[other]);
			rateCount++;
		}
		return rateCount ? work(sample) * rateSum / rateCount : sample.durationMs;
	});
	const actual = samples.map(sample => Math.max(0.001, sample.durationMs || 0.001));
	const mapePercent = predicted.reduce((sum, value, index) => sum + Math.abs(value - actual[index]) / actual[index], 0) / actual.length * 100;
	return {mapePercent, spearman: correlation(rank(predicted), rank(actual))};
}

function createHistoricalPrimarySampleReservoir({
	load = () => null,
	save = () => {},
	now = Date.now,
	capacity = HISTORICAL_PRIMARY_SAMPLE_CAPACITY,
	ttlMs = HISTORICAL_PRIMARY_SAMPLE_TTL_MS,
	maxBytes = HISTORICAL_PRIMARY_SAMPLE_MAX_BYTES,
	setTimer = (callback, delay) => setTimeout(callback, delay),
	clearTimer = timer => clearTimeout(timer)
} = {}) {
	const sampleCapacity = Math.max(1, Math.min(HISTORICAL_PRIMARY_SAMPLE_CAPACITY, whole(capacity, HISTORICAL_PRIMARY_SAMPLE_CAPACITY) || HISTORICAL_PRIMARY_SAMPLE_CAPACITY));
	const sampleTtl = Math.max(1, whole(ttlMs, HISTORICAL_PRIMARY_SAMPLE_TTL_MS) || HISTORICAL_PRIMARY_SAMPLE_TTL_MS);
	const byteLimit = Math.max(1024, whole(maxBytes, HISTORICAL_PRIMARY_SAMPLE_MAX_BYTES) || HISTORICAL_PRIMARY_SAMPLE_MAX_BYTES);
	let started = false;
	let samples = [];
	let counters = emptyCounters();
	let evictedCount = 0;
	let expiredCount = 0;
	let migratedCount = 0;
	let corruptedResetCount = 0;
	let sampleSequence = 0;
	let tokenSequence = 0;
	let openSamples = new Map();
	let samplesById = new Map();
	let messageLinks = new Map();
	let linksByJob = new Map();
	let saveTimer = null;
	let dirty = false;

	function timestamp() {
		try {const value = Number(now()); return Number.isFinite(value) ? Math.max(0, value) : 0;}
		catch (error) {return 0;}
	}

	function persistedState() {
		return {schemaVersion: HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION, savedAt: timestamp(), samples: samples.map(sample => normalizeSample(sample, sample.sampleId, timestamp())).filter(Boolean), counters: normalizeCounters(counters), evictedCount, expiredCount, migratedCount, corruptedResetCount};
	}

	function removeSample(sample, reason = "capacity") {
		if (!sample) return;
		samplesById.delete(sample.sampleId);
		for (const [key, sampleId] of messageLinks) if (sampleId === sample.sampleId) messageLinks.delete(key);
		if (reason === "expired") expiredCount++;
		else evictedCount++;
	}

	function prune() {
		const cutoff = timestamp() - sampleTtl;
		const retained = [];
		for (const sample of samples) {
			if (sample.recordedAt < cutoff) removeSample(sample, "expired");
			else retained.push(sample);
		}
		samples = retained;
		while (samples.length > sampleCapacity) removeSample(samples.shift(), "capacity");
		return samples.length;
	}

	function scheduleSave() {
		dirty = true;
		if (saveTimer) return;
		saveTimer = setTimer(() => {saveTimer = null; flush();}, 1000);
		if (saveTimer && typeof saveTimer.unref === "function") saveTimer.unref();
	}

	function flush() {
		if (saveTimer) {clearTimer(saveTimer); saveTimer = null;}
		if (!dirty) return false;
		prune();
		let state = persistedState();
		while (samples.length && Buffer.byteLength(JSON.stringify(state), "utf8") >= byteLimit) {removeSample(samples.shift(), "capacity"); state = persistedState();}
		try {save(state); dirty = false; return true;}
		catch (error) {return false;}
	}

	function restore(raw) {
		samples = [];
		counters = emptyCounters();
		evictedCount = 0;
		expiredCount = 0;
		migratedCount = 0;
		corruptedResetCount = 0;
		if (!raw || typeof raw !== "object") return;
		const legacy = raw.schemaVersion !== HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION;
		if (raw.schemaVersion != null && raw.schemaVersion > HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION) {corruptedResetCount++; return;}
		for (const [index, rawSample] of [].concat(raw.samples || []).entries()) {
			const sample = normalizeSample(rawSample, index + 1, timestamp());
			if (sample) samples.push(sample);
		}
		counters = normalizeCounters(raw.counters);
		evictedCount = whole(raw.evictedCount);
		expiredCount = whole(raw.expiredCount);
		migratedCount = whole(raw.migratedCount) + (legacy && samples.length ? 1 : 0);
		corruptedResetCount += whole(raw.corruptedResetCount);
		sampleSequence = samples.reduce((max, sample) => Math.max(max, sample.sampleId), 0);
		prune();
	}

	function start() {
		if (saveTimer) {clearTimer(saveTimer); saveTimer = null;}
		openSamples = new Map();
		messageLinks = new Map();
		linksByJob = new Map();
		samplesById = new Map();
		try {restore(load());}
		catch (error) {restore(null); corruptedResetCount++;}
		for (const sample of samples) samplesById.set(sample.sampleId, sample);
		started = true;
		dirty = false;
		return true;
	}

	function beginPrimary({jobKey = null, blockIndex = 0, messageIds = [], itemCount = 1, protectedChars = 0, effectiveCap = 1, wave = 0} = {}) {
		if (!started) start();
		const token = Object.freeze({tokenId: ++tokenSequence});
		const sample = normalizeSample({sampleId: ++sampleSequence, recordedAt: timestamp(), transportKey: "tk1:pending", workloadKey: "wk1:pending", itemCount, protectedChars, inputChars: protectedChars, effectiveCap, wave, status: "pending", outcome: "pending", transportAttempts: {requestCount: 0, measuredDurationCount: 0, durationMs: 0}, validationReasons: {}, final: {}}, sampleSequence, timestamp());
		Object.assign(sample, {jobKey: jobKey == null ? null : String(jobKey), blockIndex: whole(blockIndex), messageIds: [].concat(messageIds || []).map(String)});
		Object.assign(sample, {_contractRecorded: false, _settledKeys: new Set(), _settledEvents: new WeakSet()});
		openSamples.set(token.tokenId, sample);
		return token;
	}

	function getOpen(token) {return token && openSamples.get(token.tokenId) || null;}

	function recordContract(token, metrics = {}) {
		const sample = getOpen(token);
		if (!sample) return false;
		const transportKey = anonymousKey(metrics.transportKey, "tk1:"), workloadKey = anonymousKey(metrics.workloadKey, "wk1:");
		if (!transportKey || !workloadKey) return false;
		// Fallback reuses the observer; keep the initial request/cohort identity.
		if (sample._contractRecorded) return true;
		sample._contractRecorded = true;
		sample.transportKey = transportKey;
		sample.workloadKey = workloadKey;
		sample.bodyBytes = whole(metrics.bodyBytes);
		sample.promptChars = whole(metrics.promptChars);
		sample.inputChars = whole(metrics.inputChars, sample.protectedChars);
		sample.estimatedTokens = Math.ceil(sample.bodyBytes / 4);
		return true;
	}

	function recordSettle(token, event = {}) {
		const sample = getOpen(token);
		if (!sample || !event || typeof event !== "object") return false;
		const requestId = event.providerRequestId, attempt = event.providerAttempt;
		const identified = (typeof requestId === "number" || typeof requestId === "string") && String(requestId) !== "" && attempt != null && Number.isSafeInteger(Number(attempt)) && Number(attempt) > 0;
		const key = identified ? JSON.stringify([String(requestId), Number(attempt)]) : null;
		// A null-ID event is a separate observed request, not the shared "null:null"
		// key. Re-delivery of the identical event object is still idempotent.
		if (sample._settledEvents.has(event) || key != null && sample._settledKeys.has(key)) return false;
		sample._settledEvents.add(event);
		if (key != null) sample._settledKeys.add(key);
		const totals = sample.transportAttempts, durationMs = finiteOrNull(event.durationMs);
		totals.requestCount++;
		if (durationMs == null) totals.unknownDurationCount++;
		else {totals.measuredDurationCount++; totals.durationMs += durationMs;}
		if (totals.requestCount > 1) return true;
		// The primary status/usage must not become a successful fallback's result.
		sample.durationMs = durationMs;
		sample.outputChars = finiteOrNull(event.outputChars);
		sample.usage = normalizeUsage(event.usage);
		sample.httpStatus = finiteOrNull(event.httpStatus);
		sample.finishReason = boundedEnum(event.finishReason);
		sample.status = boundedEnum(event.status, "unknown");
		return true;
	}

	function linkSample(sample) {
		if (!sample.jobKey) return;
		let jobLinks = linksByJob.get(sample.jobKey);
		if (!jobLinks) {jobLinks = new Set(); linksByJob.set(sample.jobKey, jobLinks);}
		for (const messageId of sample.messageIds) {
			const key = `${sample.jobKey}\u0000${messageId}`;
			messageLinks.set(key, sample.sampleId);
			jobLinks.add(key);
		}
	}

	function recordOutcome(token, {failureKind = null, liveOverlap = false, cancelled = false} = {}) {
		const sample = getOpen(token);
		if (!sample) return false;
		openSamples.delete(token.tokenId);
		sample.outcome = boundedEnum(failureKind, failureKind ? "unknown" : "clean");
		const alreadyLiveOverlap = sample.liveOverlap;
		sample.liveOverlap = alreadyLiveOverlap || !!liveOverlap;
		sample.cancelled = !!cancelled;
		sample.contaminated = !!(failureKind || liveOverlap || cancelled || sample.status !== "ok" || sample.httpStatus !== 200 || sample.durationMs == null || sample.transportAttempts.requestCount > 1);
		sample.trainingEligible = !sample.contaminated && !sample.cache && !sample.repair;
		if (sample.cancelled) counters.cancelledPrimary++;
		if (failureKind) counters.pressurePrimary++;
		if (sample.liveOverlap && !alreadyLiveOverlap) counters.liveOverlapPrimary++;
		if (!anonymousKey(sample.transportKey, "tk1:") || !anonymousKey(sample.workloadKey, "wk1:")) {scheduleSave(); return true;}
		const jobKey = sample.jobKey, messageIds = sample.messageIds;
		delete sample.jobKey;
		delete sample.blockIndex;
		delete sample.messageIds;
		return appendFinalized(sample, jobKey, messageIds);
	}

	function appendFinalized(sample, jobKey = null, messageIds = []) {
		// jobKey/messageIds are non-persistent fields captured before sanitization.
		const persisted = normalizeSample(sample, sample.sampleId, timestamp());
		if (!persisted) return false;
		samples.push(persisted);
		samplesById.set(persisted.sampleId, persisted);
		if (jobKey) {
			Object.defineProperty(persisted, "_jobKey", {value: jobKey, writable: true, configurable: true, enumerable: false});
			Object.defineProperty(persisted, "_messageIds", {value: messageIds, writable: true, configurable: true, enumerable: false});
			linkSample({_jobKey: jobKey, jobKey, messageIds, sampleId: persisted.sampleId});
		}
		prune();
		scheduleSave();
		return true;
	}

	function sampleFor(jobKey, messageId) {
		const sampleId = messageLinks.get(`${String(jobKey)}\u0000${String(messageId)}`);
		return sampleId == null ? null : samplesById.get(sampleId) || null;
	}

	function contaminate(sample) {
		if (!sample) return;
		sample.contaminated = true;
		sample.trainingEligible = false;
	}

	function recordValidation({jobKey, messageId, reason = "unknown", repairEligible = false} = {}) {
		const normalized = normalizeReason(reason);
		counters.validationReasons[normalized]++;
		const sample = sampleFor(jobKey, messageId);
		if (sample) {
			sample.validationReasons[normalized]++;
			if (repairEligible) sample.repair = true;
			contaminate(sample);
		}
		scheduleSave();
		return normalized;
	}

	function samplesForJob(jobKey) {
		const ids = new Set();
		for (const link of linksByJob.get(String(jobKey)) || []) {
			const sampleId = messageLinks.get(link);
			if (sampleId != null) ids.add(sampleId);
		}
		return [...ids].map(id => samplesById.get(id)).filter(Boolean);
	}

	function recordRepair({jobKey, mode = "item", messageCount = 1} = {}) {
		mode = mode === "batch" ? "batch" : "item";
		counters.repairs[`${mode}Requests`]++;
		counters.repairs[`${mode}Messages`] += Math.max(1, whole(messageCount, 1));
		for (const sample of samplesForJob(jobKey)) {sample.repair = true; contaminate(sample);}
		scheduleSave();
		return true;
	}

	function recordFinal(jobKey, {translatedIds = [], skippedIds = [], failedIds = []} = {}) {
		for (const [field, ids] of [["translated", translatedIds], ["skipped", skippedIds], ["failed", failedIds]]) {
			for (const messageId of ids || []) {
				counters.finalOutcomes[field]++;
				const sample = sampleFor(jobKey, messageId);
				if (sample) sample.final[field]++;
			}
		}
		scheduleSave();
		return true;
	}

	function finishJob(jobKey) {
		const key = String(jobKey);
		for (const link of linksByJob.get(key) || []) messageLinks.delete(link);
		linksByJob.delete(key);
		for (const sample of samples) if (sample._jobKey === key) {delete sample._jobKey; delete sample._messageIds;}
		return true;
	}

	function recordCache(metrics = {}) {
		for (const key of Object.keys(counters.cache)) counters.cache[key] += whole(metrics[key]);
		scheduleSave();
		return true;
	}

	function recordLiveOverlap(jobKey = null) {
		const key = jobKey == null ? null : String(jobKey);
		for (const sample of openSamples.values()) {
			if (key != null && sample.jobKey !== key || sample.liveOverlap) continue;
			sample.liveOverlap = true;
			contaminate(sample);
			counters.liveOverlapPrimary++;
		}
		if (key != null) for (const sample of samplesForJob(key)) {
			if (sample.liveOverlap) continue;
			sample.liveOverlap = true;
			contaminate(sample);
			counters.liveOverlapPrimary++;
		}
		scheduleSave();
		return true;
	}

	function cohortSnapshots() {
		const groups = new Map();
		for (const sample of samples) {
			const cohortKey = `${sample.transportKey}|${sample.workloadKey}`;
			let group = groups.get(cohortKey);
			if (!group) {group = {transportKey: sample.transportKey, workloadKey: sample.workloadKey, samples: []}; groups.set(cohortKey, group);}
			group.samples.push(sample);
		}
		return [...groups.values()].map(group => {
			const clean = group.samples.filter(sample => sample.trainingEligible && !sample.contaminated && !sample.cache && !sample.repair && !sample.cancelled && !sample.liveOverlap && sample.outcome === "clean");
			const contaminated = group.samples.length - clean.length;
			const metrics = predictionMetrics(clean);
			return {transportKey: group.transportKey, workloadKey: group.workloadKey, sampleCount: clean.length, totalCount: group.samples.length, contaminatedCount: contaminated, mapePercent: metrics.mapePercent, spearman: metrics.spearman};
		}).sort((a, b) => b.sampleCount - a.sampleCount || b.totalCount - a.totalCount);
	}

	function getSnapshot() {
		prune();
		const cohorts = cohortSnapshots();
		const selected = cohorts[0] || {sampleCount: 0, totalCount: 0, contaminatedCount: 0, mapePercent: null, spearman: null};
		const readyByCount = selected.sampleCount >= 100;
		const readyByAccuracy = selected.mapePercent != null && selected.mapePercent <= 30 || selected.spearman != null && selected.spearman >= 0.6;
		const s8Gate = Object.freeze({
			cohortCount: cohorts.length,
			sampleCount: selected.sampleCount,
			requiredSampleCount: 100,
			contaminatedCount: selected.contaminatedCount,
			mapePercent: selected.mapePercent,
			spearman: selected.spearman,
			ready: readyByCount && readyByAccuracy,
			blockedReason: !readyByCount ? "insufficient_clean_samples" : !readyByAccuracy ? "prediction_accuracy" : null,
			cohorts: Object.freeze(cohorts.map(cohort => Object.freeze(Object.assign({}, cohort))))
		});
		const trainingSampleCount = samples.filter(sample => sample.trainingEligible && !sample.contaminated).length;
		return Object.freeze({
			schemaVersion: HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION,
			capacity: sampleCapacity,
			ttlMs: sampleTtl,
			sampleCount: samples.length,
			trainingSampleCount,
			cleanPrimaryCount: trainingSampleCount,
			contaminatedPrimaryCount: samples.length - trainingSampleCount,
			cancelledPrimaryCount: counters.cancelledPrimary,
			pressurePrimaryCount: counters.pressurePrimary,
			liveOverlapPrimaryCount: counters.liveOverlapPrimary,
			evictedCount,
			expiredCount,
			migratedCount,
			corruptedResetCount,
			cache: Object.freeze(Object.assign({}, counters.cache)),
			repairs: Object.freeze(Object.assign({}, counters.repairs)),
			validationReasons: Object.freeze(Object.assign({}, counters.validationReasons)),
			validationReasonSuggestions: HISTORICAL_VALIDATION_REASON_SUGGESTIONS,
			finalOutcomes: Object.freeze(Object.assign({}, counters.finalOutcomes)),
			s8Gate,
			persistedBytes: Buffer.byteLength(JSON.stringify(persistedState()), "utf8"),
			resources: Object.freeze({openSamples: openSamples.size, messageLinks: messageLinks.size, pendingSave: !!saveTimer})
		});
	}

	function reset() {
		if (saveTimer) {clearTimer(saveTimer); saveTimer = null;}
		samples = [];
		counters = emptyCounters();
		evictedCount = 0;
		expiredCount = 0;
		migratedCount = 0;
		corruptedResetCount = 0;
		openSamples.clear();
		samplesById.clear();
		messageLinks.clear();
		linksByJob.clear();
		dirty = true;
		flush();
		return true;
	}

	function stop() {
		flush();
		if (saveTimer) {clearTimer(saveTimer); saveTimer = null;}
		openSamples.clear();
		messageLinks.clear();
		linksByJob.clear();
		started = false;
		return true;
	}

	return Object.freeze({start, stop, reset, flush, beginPrimary, recordContract, recordSettle, recordOutcome, recordValidation, recordRepair, recordFinal, finishJob, recordCache, recordLiveOverlap, getSnapshot});
}

module.exports = {
	HISTORICAL_PRIMARY_SAMPLE_SCHEMA_VERSION,
	HISTORICAL_PRIMARY_SAMPLE_CAPACITY,
	HISTORICAL_PRIMARY_SAMPLE_TTL_MS,
	HISTORICAL_PRIMARY_SAMPLE_MAX_BYTES,
	HISTORICAL_VALIDATION_REASONS,
	HISTORICAL_VALIDATION_REASON_SUGGESTIONS,
	createHistoricalPrimarySampleReservoir
};
