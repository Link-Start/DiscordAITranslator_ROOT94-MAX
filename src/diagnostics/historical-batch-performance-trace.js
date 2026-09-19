// Bounded, content-free measurements for one loaded-message translation job.
// The trace accepts counts, durations and coarse outcome classes only. Message/channel
// identities, text, prompts, endpoints, models, credentials and raw responses have no
// input seam here, so a future caller cannot accidentally widen the privacy footprint.

const DEFAULT_RUN_LIMIT = 12;
const DEFAULT_CHUNK_SAMPLE_LIMIT = 16;
const DEFAULT_CHUNK_CHAR_LIMIT = 12000;
const DEFAULT_PROJECTION_SAMPLE_LIMIT = 128;
const DEFAULT_H1_SAMPLE_LIMIT = 32;
const FAILURE_KINDS = new Set(["auth", "configuration", "schema", "semantic_schema", "permanent", "request_budget", "attempt_budget", "rate_limit", "server", "timeout", "transient", "malformed", "thrown", "unknown"]);
const RUN_STATUSES = new Set(["committed", "cancelled", "failed", "unknown"]);
const H1_ROLES = new Set(["primary", "repair", "backup"]);
const H1_LOGICAL_STATUSES = new Set(["settled", "cancelled", "failed"]);
const COMMIT_PREPARATION_COUNTS = ["attemptCount", "partialAttemptCount", "staleJobCount", "staleBlockCount", "alreadyCommittedCount", "displayOwnedCount", "sourceChangedCount", "missingTranslationCount", "submittedCount"];

function finiteNonNegative(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function wholeNonNegative(value) {
	return Math.floor(finiteNonNegative(value));
}

function nullableWholeNonNegative(value) {
	if (value == null || value === "" || typeof value == "boolean" || !Number.isFinite(Number(value))) return null;
	return Math.floor(Math.max(0, Number(value)));
}

function boundedAnonymousKey(value, prefix) {
	const text = String(value == null ? "" : value);
	return text.startsWith(prefix) && /^[a-z0-9:-]+$/i.test(text) && text.length <= 80 ? text : null;
}

function normalizeTransportDescriptor(value) {
	if (!value || typeof value != "object") return null;
	const endpointDigest = boundedAnonymousKey(value.endpointDigest, "ep1:");
	const credentialRevision = boundedAnonymousKey(value.credentialRevision, "cr1:");
	const modelDigest = boundedAnonymousKey(value.modelDigest, "md1:");
	const reasoningWireDigest = boundedAnonymousKey(value.reasoningWireDigest, "rw1:");
	if (!endpointDigest || !credentialRevision || !modelDigest || !reasoningWireDigest) return null;
	return Object.freeze({
		engine: /^[a-z0-9_-]{1,48}$/i.test(String(value.engine || "")) ? String(value.engine) : "unknown",
		endpointDigest,
		credentialRevision,
		modelDigest,
		protocol: /^[a-z0-9_-]{1,48}$/i.test(String(value.protocol || "")) ? String(value.protocol) : "unknown",
		adapterVersion: wholeNonNegative(value.adapterVersion),
		schemaVersion: Math.max(1, wholeNonNegative(value.schemaVersion) || 1),
		reasoningWireDigest
	});
}

function normalizeWorkloadDescriptor(value) {
	if (!value || typeof value != "object") return null;
	const promptVersionDigest = boundedAnonymousKey(value.promptVersionDigest, "pv1:");
	const languageRulesDigest = boundedAnonymousKey(value.languageRulesDigest, "lr1:");
	const bucket = field => /^[a-z0-9+_-]{1,16}$/i.test(String(value[field] || "")) ? String(value[field]) : null;
	const itemSizeBucket = bucket("itemSizeBucket"), charSizeBucket = bucket("charSizeBucket"), tokenSizeBucket = bucket("tokenSizeBucket");
	if (!promptVersionDigest || !languageRulesDigest || !itemSizeBucket || !charSizeBucket || !tokenSizeBucket) return null;
	return Object.freeze({promptVersionDigest, languageRulesDigest, itemSizeBucket, charSizeBucket, tokenSizeBucket});
}

function normalizedFinishReason(value) {
	if (value == null || value === "") return null;
	const text = String(value).toLowerCase();
	return /^[a-z0-9_.:-]{1,40}$/.test(text) ? text : "other";
}

function normalizeUsage(usage) {
	if (!usage || typeof usage != "object") return null;
	const normalized = {
		promptTokens: nullableWholeNonNegative(usage.promptTokens),
		completionTokens: nullableWholeNonNegative(usage.completionTokens),
		reasoningTokens: nullableWholeNonNegative(usage.reasoningTokens)
	};
	return normalized.promptTokens == null && normalized.completionTokens == null && normalized.reasoningTokens == null ? null : Object.freeze(normalized);
}

function copyChunkSample(sample) {
	return Object.freeze({
		index: sample.index,
		messageCount: sample.messageCount,
		inputChars: sample.inputChars,
		dispatchOffsetMs: sample.dispatchOffsetMs,
		durationMs: sample.durationMs,
		failureKind: sample.failureKind,
		statusCode: sample.statusCode,
		liveActiveAtDispatch: sample.liveActiveAtDispatch
	});
}

function projectTwoSlotDuration(samples) {
	if (!samples.length) return 0;
	const ordered = samples.slice().sort((left, right) => left.index - right.index);
	const probeDuration = finiteNonNegative(ordered[0].durationMs);
	const slots = [0, 0];
	for (const sample of ordered.slice(1)) {
		const slotIndex = slots[0] <= slots[1] ? 0 : 1;
		slots[slotIndex] += finiteNonNegative(sample.durationMs);
	}
	return probeDuration + Math.max(...slots);
}

function createHistoricalBatchPerformanceTrace({
	now = Date.now,
	runLimit = DEFAULT_RUN_LIMIT,
	chunkSampleLimit = DEFAULT_CHUNK_SAMPLE_LIMIT,
	h1SampleLimit = DEFAULT_H1_SAMPLE_LIMIT
} = {}) {
	const boundedRunLimit = Math.max(1, wholeNonNegative(runLimit) || DEFAULT_RUN_LIMIT);
	const boundedChunkLimit = Math.max(1, wholeNonNegative(chunkSampleLimit) || DEFAULT_CHUNK_SAMPLE_LIMIT);
	const boundedH1SampleLimit = Math.max(1, wholeNonNegative(h1SampleLimit) || DEFAULT_H1_SAMPLE_LIMIT);
	let generation = 0;
	let sequence = 0;
	let activeRuns = new Map();
	let recentRuns = [];
	let counters = createCounters();

	function createCounters() {
		return {
			startedRuns: 0,
			completedRuns: 0,
			cancelledRuns: 0,
			failedRuns: 0,
			primaryChunkRequests: 0,
			primaryChunkMessages: 0,
			primaryInputChars: 0,
			repairBatchRequests: 0,
			repairBatchMessages: 0,
			repairItemRequests: 0,
			atomicCommits: 0,
			h1LateEvents: 0,
			h1OrphanEvents: 0,
			h1DuplicateEvents: 0,
			liveTurnsDuringRuns: 0,
			liveOverlapDuringChunks: 0,
			maxActiveChunks: 0
		};
	}

	function timestamp() {
		return finiteNonNegative(now());
	}

	function getRun(token) {
		if (!token || token.generation !== generation) return null;
		return activeRuns.get(token.id) || null;
	}

	function timestampCandidate(value, fallback) {
		const number = value == null || value === "" || typeof value == "boolean" ? NaN : Number(value);
		return Number.isFinite(number) && number >= 0 ? number : fallback;
	}

	function createH1State({batchKey = null, sourceMetrics = null, sealedAt, startedAt}) {
		const metrics = sourceMetrics && typeof sourceMetrics == "object" ? sourceMetrics : {};
		const sourceLoadAt = Math.min(startedAt, timestampCandidate(metrics.sourceLoadAt, sealedAt));
		const scanPrefetchAt = Math.max(sourceLoadAt, Math.min(startedAt, timestampCandidate(metrics.scanPrefetchAt, sealedAt)));
		return {
			batchKey: batchKey == null ? null : String(batchKey),
			originAt: sourceLoadAt,
			timeline: {sourceLoadAt, scanPrefetchAt, sealAt: sealedAt, firstLeaseAt: null, firstDispatchAt: null, firstSettleAt: null, parseValidateAt: null, atomicCommitAt: null, domConfirmAt: null},
			sourceLoadCount: Math.max(0, wholeNonNegative(metrics.sourceLoadCount || metrics.total || 0)),
			prefetchedCount: wholeNonNegative(metrics.prefetchedCount),
			cache: {hit: 0, miss: 0, invalidated: 0, evicted: 0},
			logicalSequence: 0,
			attemptSequence: 0,
			logicalCount: 0,
			terminalLogicalCount: 0,
			attemptCount: 0,
			dispatchCount: 0,
			settleCount: 0,
			providerBoundIdCount: 0,
			providerBoundIds: new Set(),
			duplicateEventCount: 0,
			orphanEventCount: 0,
			lateEventCount: 0,
			evictedCount: 0,
			probeBarrierCount: 0,
			probeBarrierSettledCount: 0,
			primaryLogicalCount: 0,
			primaryWaveMax: 0,
			slotUtilizationSum: 0,
			slotUtilizationSamples: 0,
			maxSlotUtilization: 0,
			backoffWaitMs: 0,
			leaseWaitMs: 0,
			bodyBytes: 0,
			promptChars: 0,
			inputChars: 0,
			outputChars: 0,
			usageSampleCount: 0,
			promptTokenSampleCount: 0,
			completionTokenSampleCount: 0,
			reasoningTokenSampleCount: 0,
			promptTokens: 0,
			completionTokens: 0,
			reasoningTokens: 0,
			finishReasons: new Map(),
			parseCount: 0,
			validCount: 0,
			invalidCount: 0,
			domConfirmedCount: 0,
			domDeferredCount: 0,
			logicals: new Map(),
			attempts: new Map(),
			transportKeys: new Set(),
			workloadKeys: new Set()
		};
	}

	function beginRun({collectedMessageCount = 0, concurrency = 1, chunkSize = 10, chunkCharLimit = DEFAULT_CHUNK_CHAR_LIMIT, sealedAt = null, batchKey = null, sourceMetrics = null} = {}) {
		const token = Object.freeze({id: ++sequence, generation});
		const startedAt = timestamp();
		const candidateSealedAt = sealedAt == null || sealedAt === "" || typeof sealedAt == "boolean" ? NaN : Number(sealedAt);
		const normalizedSealedAt = Number.isFinite(candidateSealedAt) && candidateSealedAt >= 0 && candidateSealedAt <= startedAt ? candidateSealedAt : startedAt;
		activeRuns.set(token.id, {
			id: token.id,
			generation,
			startedAt,
			sealedAt: normalizedSealedAt,
			collectedMessageCount: wholeNonNegative(collectedMessageCount),
			concurrency: Math.max(1, wholeNonNegative(concurrency) || 1),
			chunkSize: Math.max(1, wholeNonNegative(chunkSize) || 10),
			chunkCharLimit: Math.max(1, wholeNonNegative(chunkCharLimit) || DEFAULT_CHUNK_CHAR_LIMIT),
			requestedChunks: 0,
			settledChunks: 0,
			providerMessageCount: 0,
			providerInputChars: 0,
			settledMessageCount: 0,
			activeChunks: 0,
			maxActiveChunks: 0,
			globalMaxActiveChunks: 0,
			liveOverlapDispatches: 0,
			liveTurnsDuringRun: 0,
			liveOverlapDuringChunks: 0,
			duplicateChunkEventCount: 0,
			orphanChunkSettleCount: 0,
			chunkConstraintViolationCount: 0,
			failureCount: 0,
			repairBatchRequests: 0,
			repairBatchMessages: 0,
			repairItemRequests: 0,
			atomicCommitCount: 0,
			commitPreparation: Object.fromEntries(COMMIT_PREPARATION_COUNTS.map(key => [key, 0])),
			commitResultCount: 0,
			committedCount: 0,
			confirmedCount: 0,
			deferredCount: 0,
			rejectedCount: 0,
			missingCount: 0,
			retryCount: 0,
			staleCount: 0,
			commitErrorCount: 0,
			firstDispatchAt: null,
			lastPrimarySettledAt: null,
			commitAt: null,
			sequentialChunkMs: 0,
			projectionDurationSamples: [],
			projectionSampleOverflowCount: 0,
			chunkStarts: new Map(),
			seenChunkIndexes: new Set(),
			chunkSamples: [],
			h1: createH1State({batchKey, sourceMetrics, sealedAt: normalizedSealedAt, startedAt})
		});
		counters.startedRuns++;
		return token;
	}

	function getH1RunForChild(token) {
		if (!token || token.generation !== generation) {
			counters.h1LateEvents++;
			return null;
		}
		const run = activeRuns.get(token.runId);
		if (!run) {
			counters.h1LateEvents++;
			return null;
		}
		return run;
	}

	function noteH1Orphan(run) {
		run.h1.orphanEventCount++;
		counters.h1OrphanEvents++;
		return false;
	}

	function noteH1Duplicate(run) {
		run.h1.duplicateEventCount++;
		counters.h1DuplicateEvents++;
		return false;
	}

	function recordStage(token, stage, {at = null, count = 0, prefetchedCount = 0} = {}) {
		const run = getRun(token);
		if (!run) return false;
		const recordedAt = timestampCandidate(at, timestamp());
		if (stage === "source_load") {
			run.h1.timeline.sourceLoadAt = Math.min(run.h1.timeline.sourceLoadAt, recordedAt);
			run.h1.originAt = run.h1.timeline.sourceLoadAt;
			run.h1.sourceLoadCount += wholeNonNegative(count);
		}
		else if (stage === "scan_prefetch") {
			run.h1.timeline.scanPrefetchAt = recordedAt;
			run.h1.prefetchedCount += wholeNonNegative(prefetchedCount);
		}
		else if (stage === "seal") run.h1.timeline.sealAt = recordedAt;
		else if (stage === "parse_validate") run.h1.timeline.parseValidateAt = recordedAt;
		else if (stage === "dom_confirm") run.h1.timeline.domConfirmAt = recordedAt;
		else return false;
		return true;
	}

	function recordCache(token, {hit = 0, miss = 0, invalidated = 0, evicted = 0} = {}) {
		const run = getRun(token);
		if (!run) return false;
		run.h1.cache.hit += wholeNonNegative(hit);
		run.h1.cache.miss += wholeNonNegative(miss);
		run.h1.cache.invalidated += wholeNonNegative(invalidated);
		run.h1.cache.evicted += wholeNonNegative(evicted);
		return true;
	}

	function beginLogical(token, {role = "primary", itemCount = 0, probeBarrier = false, primaryWave = 0} = {}) {
		const run = getRun(token);
		if (!run) return null;
		const logicalId = ++run.h1.logicalSequence;
		const normalizedRole = H1_ROLES.has(String(role)) ? String(role) : "primary";
		const logical = {
			logicalId,
			role: normalizedRole,
			itemCount: wholeNonNegative(itemCount),
			probeBarrier: !!probeBarrier,
			primaryWave: wholeNonNegative(primaryWave),
			startedAt: timestamp(),
			terminalAt: null,
			status: null,
			attemptIds: []
		};
		run.h1.logicals.set(logicalId, logical);
		run.h1.logicalCount++;
		if (logical.probeBarrier) run.h1.probeBarrierCount++;
		if (logical.role === "primary") {
			run.h1.primaryLogicalCount++;
			run.h1.primaryWaveMax = Math.max(run.h1.primaryWaveMax, logical.primaryWave);
		}
		return Object.freeze({generation, runId: run.id, logicalId});
	}

	function recordLease(logicalToken, {backoffWaitMs = 0, leaseWaitMs = 0, slotActive = 0, slotCapacity = 0} = {}) {
		const run = getH1RunForChild(logicalToken);
		if (!run) return false;
		const logical = run.h1.logicals.get(logicalToken.logicalId);
		if (!logical) return noteH1Orphan(run);
		const recordedAt = timestamp();
		if (run.h1.timeline.firstLeaseAt == null) run.h1.timeline.firstLeaseAt = recordedAt;
		run.h1.backoffWaitMs += finiteNonNegative(backoffWaitMs);
		run.h1.leaseWaitMs += finiteNonNegative(leaseWaitMs);
		const capacity = wholeNonNegative(slotCapacity);
		const active = wholeNonNegative(slotActive);
		if (capacity > 0) {
			const utilization = Math.max(0, Math.min(1, active / capacity));
			run.h1.slotUtilizationSum += utilization;
			run.h1.slotUtilizationSamples++;
			run.h1.maxSlotUtilization = Math.max(run.h1.maxSlotUtilization, utilization);
		}
		return true;
	}

	function beginAttempt(logicalToken, {role = null, engineKey = null} = {}) {
		const run = getH1RunForChild(logicalToken);
		if (!run) return null;
		const logical = run.h1.logicals.get(logicalToken.logicalId);
		if (!logical) {noteH1Orphan(run); return null;}
		const attemptId = ++run.h1.attemptSequence;
		const normalizedRole = H1_ROLES.has(String(role)) ? String(role) : logical.role;
		run.h1.attempts.set(attemptId, {
			attemptId,
			logicalId: logical.logicalId,
			role: normalizedRole,
			engineKey: /^[a-z0-9_-]{1,48}$/i.test(String(engineKey || "")) ? String(engineKey) : null,
			startedAt: timestamp(),
			dispatchedAt: null,
			settledAt: null,
			transportKey: null,
			workloadKey: null,
			transport: null,
			workload: null,
			bodyBytes: 0,
			promptChars: 0,
			inputChars: 0,
			outputChars: null,
			providerRequestId: null,
			providerAttempt: null,
			status: null,
			httpStatus: null,
			usage: null,
			finishReason: null,
			headers: null,
			ttftMs: null,
			physicalAbort: null
		});
		logical.attemptIds.push(attemptId);
		run.h1.attemptCount++;
		return Object.freeze({generation, runId: run.id, logicalId: logical.logicalId, attemptId});
	}

	function recordAttemptDispatched(attemptToken, {
		transportKey = null,
		workloadKey = null,
		transport = null,
		workload = null,
		bodyBytes = 0,
		promptChars = 0,
		inputChars = 0,
		slotActive = 0,
		slotCapacity = 0
	} = {}) {
		const run = getH1RunForChild(attemptToken);
		if (!run) return false;
		const attempt = run.h1.attempts.get(attemptToken.attemptId);
		if (!attempt || attempt.logicalId !== attemptToken.logicalId) return noteH1Orphan(run);
		if (attempt.dispatchedAt != null) return noteH1Duplicate(run);
		attempt.dispatchedAt = timestamp();
		if (run.h1.timeline.firstDispatchAt == null) run.h1.timeline.firstDispatchAt = attempt.dispatchedAt;
		attempt.transportKey = boundedAnonymousKey(transportKey, "tk1:");
		attempt.workloadKey = boundedAnonymousKey(workloadKey, "wk1:");
		attempt.transport = normalizeTransportDescriptor(transport);
		attempt.workload = normalizeWorkloadDescriptor(workload);
		attempt.bodyBytes = wholeNonNegative(bodyBytes);
		attempt.promptChars = wholeNonNegative(promptChars);
		attempt.inputChars = wholeNonNegative(inputChars);
		run.h1.bodyBytes += attempt.bodyBytes;
		run.h1.promptChars += attempt.promptChars;
		run.h1.inputChars += attempt.inputChars;
		if (attempt.transportKey) run.h1.transportKeys.add(attempt.transportKey);
		if (attempt.workloadKey) run.h1.workloadKeys.add(attempt.workloadKey);
		run.h1.dispatchCount++;
		const capacity = wholeNonNegative(slotCapacity);
		if (capacity > 0) {
			const utilization = Math.max(0, Math.min(1, wholeNonNegative(slotActive) / capacity));
			run.h1.slotUtilizationSum += utilization;
			run.h1.slotUtilizationSamples++;
			run.h1.maxSlotUtilization = Math.max(run.h1.maxSlotUtilization, utilization);
		}
		return true;
	}

	function recordAttemptSettled(attemptToken, {
		providerRequestId = null,
		providerAttempt = null,
		status = "unknown",
		httpStatus = null,
		outputChars = null,
		usage = null,
		finishReason = null,
		physicalAbort = null
	} = {}) {
		const run = getH1RunForChild(attemptToken);
		if (!run) return false;
		const attempt = run.h1.attempts.get(attemptToken.attemptId);
		if (!attempt || attempt.logicalId !== attemptToken.logicalId || attempt.dispatchedAt == null) return noteH1Orphan(run);
		if (attempt.settledAt != null) return noteH1Duplicate(run);
		attempt.settledAt = timestamp();
		if (run.h1.timeline.firstSettleAt == null) run.h1.timeline.firstSettleAt = attempt.settledAt;
		attempt.providerRequestId = nullableWholeNonNegative(providerRequestId);
		attempt.providerAttempt = nullableWholeNonNegative(providerAttempt);
		attempt.status = /^[a-z0-9_:-]{1,40}$/i.test(String(status || "")) ? String(status).toLowerCase() : "unknown";
		attempt.httpStatus = nullableWholeNonNegative(httpStatus);
		attempt.outputChars = nullableWholeNonNegative(outputChars);
		attempt.usage = normalizeUsage(usage);
		attempt.finishReason = normalizedFinishReason(finishReason);
		attempt.physicalAbort = typeof physicalAbort == "boolean" ? physicalAbort : null;
		run.h1.settleCount++;
		if (attempt.outputChars != null) run.h1.outputChars += attempt.outputChars;
		if (attempt.providerRequestId != null && attempt.providerAttempt != null) {
			run.h1.providerBoundIdCount++;
			run.h1.providerBoundIds.add(`${attempt.providerRequestId}:${attempt.providerAttempt}`);
		}
		if (attempt.usage) {
			run.h1.usageSampleCount++;
			if (attempt.usage.promptTokens != null) {run.h1.promptTokens += attempt.usage.promptTokens; run.h1.promptTokenSampleCount++;}
			if (attempt.usage.completionTokens != null) {run.h1.completionTokens += attempt.usage.completionTokens; run.h1.completionTokenSampleCount++;}
			if (attempt.usage.reasoningTokens != null) {run.h1.reasoningTokens += attempt.usage.reasoningTokens; run.h1.reasoningTokenSampleCount++;}
		}
		if (attempt.finishReason) run.h1.finishReasons.set(attempt.finishReason, (run.h1.finishReasons.get(attempt.finishReason) || 0) + 1);
		return true;
	}

	function finishLogical(logicalToken, {status = "settled"} = {}) {
		const run = getH1RunForChild(logicalToken);
		if (!run) return false;
		const logical = run.h1.logicals.get(logicalToken.logicalId);
		if (!logical) return noteH1Orphan(run);
		if (logical.terminalAt != null) return noteH1Duplicate(run);
		logical.terminalAt = timestamp();
		logical.status = H1_LOGICAL_STATUSES.has(String(status)) ? String(status) : "failed";
		run.h1.terminalLogicalCount++;
		if (logical.probeBarrier) run.h1.probeBarrierSettledCount++;
		return true;
	}

	function recordParseValidate(token, {parsed = 0, valid = 0, invalid = 0} = {}) {
		const run = getRun(token);
		if (!run) return false;
		run.h1.parseCount += wholeNonNegative(parsed);
		run.h1.validCount += wholeNonNegative(valid);
		run.h1.invalidCount += wholeNonNegative(invalid);
		run.h1.timeline.parseValidateAt = timestamp();
		return true;
	}

	function recordDomConfirm(token, {confirmedCount = 0, deferredCount = 0} = {}) {
		const run = getRun(token);
		if (!run) return false;
		run.h1.domConfirmedCount += wholeNonNegative(confirmedCount);
		run.h1.domDeferredCount += wholeNonNegative(deferredCount);
		run.h1.timeline.domConfirmAt = timestamp();
		return true;
	}

	function recordDomConfirmByBatchKey(batchKey, {confirmedCount = 0, deferredCount = 0} = {}) {
		const normalizedKey = batchKey == null ? null : String(batchKey);
		if (!normalizedKey) return false;
		for (const run of activeRuns.values()) if (run.h1.batchKey === normalizedKey) return recordDomConfirm({id: run.id, generation}, {confirmedCount, deferredCount});
		for (let index = recentRuns.length - 1; index >= 0; index--) {
			const completed = recentRuns[index];
			if (!completed || completed._h1BatchKey !== normalizedKey || !completed.h1) continue;
			const timelineMs = Object.freeze(Object.assign({}, completed.h1.timelineMs, {domConfirm: Math.max(0, timestamp() - completed._h1OriginAt)}));
			const h1 = Object.freeze(Object.assign({}, completed.h1, {
				timelineMs,
				domConfirmedCount: completed.h1.domConfirmedCount + wholeNonNegative(confirmedCount),
				domDeferredCount: completed.h1.domDeferredCount + wholeNonNegative(deferredCount)
			}));
			const replacementValue = Object.assign({}, completed, {h1});
			Object.defineProperty(replacementValue, "_h1BatchKey", {value: completed._h1BatchKey, enumerable: false});
			Object.defineProperty(replacementValue, "_h1OriginAt", {value: completed._h1OriginAt, enumerable: false});
			recentRuns[index] = Object.freeze(replacementValue);
			return true;
		}
		counters.h1OrphanEvents++;
		return false;
	}

	function recordChunkStarted(token, {index = 0, messageCount = 0, inputChars = 0, liveActive = 0} = {}) {
		const run = getRun(token);
		if (!run) return false;
		const startedAt = timestamp();
		const chunkIndex = wholeNonNegative(index);
		const size = wholeNonNegative(messageCount);
		const characters = wholeNonNegative(inputChars);
		const liveCount = wholeNonNegative(liveActive);
		if (run.seenChunkIndexes.has(chunkIndex)) {
			run.duplicateChunkEventCount++;
			return false;
		}
		run.seenChunkIndexes.add(chunkIndex);
		if (!size || size > run.chunkSize || size > 1 && characters > run.chunkCharLimit) run.chunkConstraintViolationCount++;
		run.requestedChunks++;
		run.providerMessageCount += size;
		run.providerInputChars += characters;
		run.activeChunks++;
		run.maxActiveChunks = Math.max(run.maxActiveChunks, run.activeChunks);
		const globalActiveChunks = [...activeRuns.values()].reduce((total, activeRun) => total + activeRun.activeChunks, 0);
		for (const activeRun of activeRuns.values()) activeRun.globalMaxActiveChunks = Math.max(activeRun.globalMaxActiveChunks, globalActiveChunks);
		counters.maxActiveChunks = Math.max(counters.maxActiveChunks, globalActiveChunks);
		counters.primaryChunkRequests++;
		counters.primaryChunkMessages += size;
		counters.primaryInputChars += characters;
		if (liveCount > 0) run.liveOverlapDispatches++;
		if (run.firstDispatchAt == null) run.firstDispatchAt = startedAt;
		run.chunkStarts.set(chunkIndex, {startedAt, messageCount: size, inputChars: characters, liveActive: liveCount});
		return true;
	}

	function recordChunkSettled(token, {index = 0, messageCount = 0, failureKind = null, statusCode = null} = {}) {
		const run = getRun(token);
		if (!run) return false;
		const settledAt = timestamp();
		const chunkIndex = wholeNonNegative(index);
		const start = run.chunkStarts.get(chunkIndex);
		if (!start) {
			run.orphanChunkSettleCount++;
			return false;
		}
		run.chunkStarts.delete(chunkIndex);
		run.activeChunks = Math.max(0, run.activeChunks - 1);
		run.settledChunks++;
		run.settledMessageCount += wholeNonNegative(messageCount || start.messageCount);
		run.lastPrimarySettledAt = settledAt;
		const normalizedFailure = failureKind ? FAILURE_KINDS.has(String(failureKind)) ? String(failureKind) : "unknown" : null;
		if (normalizedFailure) run.failureCount++;
		const durationMs = Math.max(0, settledAt - start.startedAt);
		run.sequentialChunkMs += durationMs;
		if (run.projectionDurationSamples.length < DEFAULT_PROJECTION_SAMPLE_LIMIT) run.projectionDurationSamples.push({index: chunkIndex, durationMs});
		else run.projectionSampleOverflowCount++;
		if (run.chunkSamples.length < boundedChunkLimit) run.chunkSamples.push({
			index: chunkIndex,
			messageCount: start.messageCount,
			inputChars: start.inputChars,
			dispatchOffsetMs: Math.max(0, start.startedAt - run.sealedAt),
			durationMs,
			failureKind: normalizedFailure,
			statusCode: statusCode == null || !Number.isFinite(Number(statusCode)) ? null : Number(statusCode),
			liveActiveAtDispatch: start.liveActive
		});
		return true;
	}

	function recordLiveTurnStarted() {
		let overlappedRuns = 0;
		for (const run of activeRuns.values()) {
			run.liveTurnsDuringRun++;
			counters.liveTurnsDuringRuns++;
			if (!run.activeChunks) continue;
			run.liveOverlapDuringChunks++;
			overlappedRuns++;
		}
		counters.liveOverlapDuringChunks += overlappedRuns;
		return overlappedRuns;
	}

	function recordRepairRequest(token, {mode = "item", messageCount = 1} = {}) {
		const run = getRun(token);
		if (!run) return false;
		const size = Math.max(1, wholeNonNegative(messageCount) || 1);
		if (mode === "batch") {
			run.repairBatchRequests++;
			run.repairBatchMessages += size;
			counters.repairBatchRequests++;
			counters.repairBatchMessages += size;
		}
		else {
			run.repairItemRequests++;
			counters.repairItemRequests++;
		}
		return true;
	}

	function recordCommitPreparation(token, counts = {}) {
		const run = getRun(token);
		if (!run) return false;
		for (const key of COMMIT_PREPARATION_COUNTS) run.commitPreparation[key] += wholeNonNegative(counts[key]);
		return true;
	}

	function recordAtomicCommit(token, {
		resultCount = 0,
		committedCount = 0,
		confirmedCount = 0,
		deferredCount = 0,
		rejectedCount = 0,
		missingCount = 0,
		retryCount = 0,
		staleCount = 0,
		error = false
	} = {}) {
		const run = getRun(token);
		if (!run) return false;
		run.atomicCommitCount++;
		run.commitResultCount += wholeNonNegative(resultCount);
		run.committedCount += wholeNonNegative(committedCount);
		run.confirmedCount += wholeNonNegative(confirmedCount);
		run.deferredCount += wholeNonNegative(deferredCount);
		run.rejectedCount += wholeNonNegative(rejectedCount);
		run.missingCount += wholeNonNegative(missingCount);
		run.retryCount += wholeNonNegative(retryCount);
		run.staleCount += wholeNonNegative(staleCount);
		if (error) run.commitErrorCount++;
		run.commitAt = timestamp();
		run.h1.timeline.atomicCommitAt = run.commitAt;
		counters.atomicCommits++;
		return true;
	}

	function h1TimelineOffsets(h1) {
		const offset = value => value == null ? null : Math.max(0, value - h1.originAt);
		return Object.freeze({
			sourceLoad: offset(h1.timeline.sourceLoadAt),
			scanPrefetch: offset(h1.timeline.scanPrefetchAt),
			seal: offset(h1.timeline.sealAt),
			lease: offset(h1.timeline.firstLeaseAt),
			dispatch: offset(h1.timeline.firstDispatchAt),
			settle: offset(h1.timeline.firstSettleAt),
			parseValidate: offset(h1.timeline.parseValidateAt),
			atomicCommit: offset(h1.timeline.atomicCommitAt),
			domConfirm: offset(h1.timeline.domConfirmAt)
		});
	}

	function createH1Completed(run) {
		const h1 = run.h1;
		const logicals = [...h1.logicals.values()].slice(0, boundedH1SampleLimit).map(logical => Object.freeze({
			logicalId: logical.logicalId,
			role: logical.role,
			itemCount: logical.itemCount,
			probeBarrier: logical.probeBarrier,
			primaryWave: logical.primaryWave,
			status: logical.status,
			attemptCount: logical.attemptIds.length,
			durationMs: logical.terminalAt == null ? null : Math.max(0, logical.terminalAt - logical.startedAt)
		}));
		const attempts = [...h1.attempts.values()].slice(0, boundedH1SampleLimit).map(attempt => Object.freeze({
			logicalId: attempt.logicalId,
			attemptId: attempt.attemptId,
			role: attempt.role,
			engineKey: attempt.engineKey,
			transportKey: attempt.transportKey,
			workloadKey: attempt.workloadKey,
			transport: attempt.transport,
			workload: attempt.workload,
			bodyBytes: attempt.bodyBytes,
			promptChars: attempt.promptChars,
			inputChars: attempt.inputChars,
			outputChars: attempt.outputChars,
			providerRequestId: attempt.providerRequestId,
			providerAttempt: attempt.providerAttempt,
			status: attempt.status,
			httpStatus: attempt.httpStatus,
			usage: attempt.usage,
			finishReason: attempt.finishReason,
			headers: null,
			ttftMs: null,
			physicalAbort: attempt.physicalAbort,
			dispatchOffsetMs: attempt.dispatchedAt == null ? null : Math.max(0, attempt.dispatchedAt - h1.originAt),
			durationMs: attempt.dispatchedAt == null || attempt.settledAt == null ? null : Math.max(0, attempt.settledAt - attempt.dispatchedAt)
		}));
		h1.evictedCount += Math.max(0, h1.logicals.size - logicals.length) + Math.max(0, h1.attempts.size - attempts.length);
		// Validated-block progress may use multiple atomic commits; physical identity conservation is unchanged.
		const conservation = Object.freeze({
			logicalCount: h1.logicalCount,
			terminalLogicalCount: h1.terminalLogicalCount,
			attemptCount: h1.attemptCount,
			dispatchCount: h1.dispatchCount,
			settleCount: h1.settleCount,
			providerBoundIdCount: h1.providerBoundIdCount,
			uniqueProviderBoundIdCount: h1.providerBoundIds.size,
			atomicCommitCount: run.atomicCommitCount,
			passed: h1.logicalCount === h1.terminalLogicalCount && h1.attemptCount === h1.dispatchCount && h1.dispatchCount === h1.settleCount
				&& h1.providerBoundIdCount === h1.settleCount && h1.providerBoundIds.size === h1.providerBoundIdCount && run.atomicCommitCount >= 1
		});
		return Object.freeze({
			schemaVersion: 1,
			timelineMs: h1TimelineOffsets(h1),
			sourceLoadCount: h1.sourceLoadCount,
			prefetchedCount: h1.prefetchedCount,
			cache: Object.freeze(Object.assign({}, h1.cache)),
			conservation,
			duplicateEventCount: h1.duplicateEventCount,
			orphanEventCount: h1.orphanEventCount,
			lateEventCount: h1.lateEventCount,
			evictedCount: h1.evictedCount,
			probeBarrierCount: h1.probeBarrierCount,
			probeBarrierSettledCount: h1.probeBarrierSettledCount,
			primaryWaveCount: h1.primaryLogicalCount ? h1.primaryWaveMax + 1 : 0,
			maxSlotUtilization: h1.maxSlotUtilization,
			averageSlotUtilization: h1.slotUtilizationSamples ? h1.slotUtilizationSum / h1.slotUtilizationSamples : null,
			backoffWaitMs: h1.backoffWaitMs,
			leaseWaitMs: h1.leaseWaitMs,
			bodyBytes: h1.bodyBytes,
			promptChars: h1.promptChars,
			inputChars: h1.inputChars,
			outputChars: h1.outputChars,
			usageSampleCount: h1.usageSampleCount,
			usage: h1.usageSampleCount ? Object.freeze({
				promptTokens: h1.promptTokenSampleCount ? h1.promptTokens : null,
				completionTokens: h1.completionTokenSampleCount ? h1.completionTokens : null,
				reasoningTokens: h1.reasoningTokenSampleCount ? h1.reasoningTokens : null
			}) : null,
			finishReasons: Object.freeze(Object.fromEntries([...h1.finishReasons.entries()].sort(([left], [right]) => left.localeCompare(right)))),
			parseCount: h1.parseCount,
			validCount: h1.validCount,
			invalidCount: h1.invalidCount,
			domConfirmedCount: h1.domConfirmedCount,
			domDeferredCount: h1.domDeferredCount,
			transportKeys: Object.freeze([...h1.transportKeys].slice(0, 8)),
			workloadKeys: Object.freeze([...h1.workloadKeys].slice(0, 8)),
			logicals: Object.freeze(logicals),
			attempts: Object.freeze(attempts)
		});
	}

	function finishRun(token, {
		status = "unknown",
		translatedCount = 0,
		skippedCount = 0,
		failedCount = 0
	} = {}) {
		const run = getRun(token);
		if (!run) return false;
		const finishedAt = timestamp();
		const normalizedStatus = RUN_STATUSES.has(String(status)) ? String(status) : "unknown";
		const samples = run.chunkSamples.slice().sort((left, right) => left.index - right.index);
		const sequentialChunkMs = run.sequentialChunkMs;
		const totalMs = Math.max(0, finishedAt - run.sealedAt);
		const primarySpanMs = run.firstDispatchAt == null || run.lastPrimarySettledAt == null ? null : Math.max(0, run.lastPrimarySettledAt - run.firstDispatchAt);
		const projectionEligible = run.concurrency === 1 && run.maxActiveChunks <= 1 && !run.projectionSampleOverflowCount;
		const projectedTwoSlotChunkMs = projectionEligible ? projectTwoSlotDuration(run.projectionDurationSamples) : null;
		const projectedTotalMs = projectionEligible ? Math.max(0, totalMs - sequentialChunkMs + projectedTwoSlotChunkMs) : null;
		const actualPrimaryConcurrencyImprovementPercent = sequentialChunkMs > 0 && primarySpanMs != null ? Math.max(0, (sequentialChunkMs - primarySpanMs) / sequentialChunkMs * 100) : 0;
		const actualPrimaryConcurrencySpeedup = primarySpanMs > 0 && sequentialChunkMs > 0 ? sequentialChunkMs / primarySpanMs : null;
		const completedValue = {
			generation: run.generation,
			collectedMessageCount: run.collectedMessageCount,
			concurrency: run.concurrency,
			chunkSize: run.chunkSize,
			chunkCharLimit: run.chunkCharLimit,
			requestedChunks: run.requestedChunks,
			settledChunks: run.settledChunks,
			providerMessageCount: run.providerMessageCount,
			providerInputChars: run.providerInputChars,
			settledMessageCount: run.settledMessageCount,
			maxActiveChunks: run.maxActiveChunks,
			globalMaxActiveChunks: run.globalMaxActiveChunks,
			activeChunksAtFinish: run.activeChunks,
			liveOverlapDispatches: run.liveOverlapDispatches,
			liveTurnsDuringRun: run.liveTurnsDuringRun,
			liveOverlapDuringChunks: run.liveOverlapDuringChunks,
			duplicateChunkEventCount: run.duplicateChunkEventCount,
			orphanChunkSettleCount: run.orphanChunkSettleCount,
			chunkConstraintViolationCount: run.chunkConstraintViolationCount,
			projectionSampleOverflowCount: run.projectionSampleOverflowCount,
			failureCount: run.failureCount,
			repairBatchRequests: run.repairBatchRequests,
			repairBatchMessages: run.repairBatchMessages,
			repairItemRequests: run.repairItemRequests,
			atomicCommitCount: run.atomicCommitCount,
			commitResultCount: run.commitResultCount,
			commitPreparation: Object.freeze(Object.assign({}, run.commitPreparation)),
			committedCount: run.committedCount,
			confirmedCount: run.confirmedCount,
			deferredCount: run.deferredCount,
			rejectedCount: run.rejectedCount,
			missingCount: run.missingCount,
			retryCount: run.retryCount,
			staleCount: run.staleCount,
			commitErrorCount: run.commitErrorCount,
			translatedCount: wholeNonNegative(translatedCount),
			skippedCount: wholeNonNegative(skippedCount),
			failedCount: wholeNonNegative(failedCount),
			status: normalizedStatus,
			totalMs,
			waitBeforeJobStartMs: Math.max(0, run.startedAt - run.sealedAt),
			sealToFirstDispatchMs: run.firstDispatchAt == null ? null : Math.max(0, run.firstDispatchAt - run.sealedAt),
			primarySpanMs,
			sealToAtomicCommitMs: run.commitAt == null ? null : Math.max(0, run.commitAt - run.sealedAt),
			sequentialChunkMs,
			projectedConcurrency2ChunkMs: projectedTwoSlotChunkMs,
			projectedConcurrency2TotalMs: projectedTotalMs,
			projectedConcurrency2ImprovementPercent: projectionEligible && totalMs > 0 ? Math.max(0, (totalMs - projectedTotalMs) / totalMs * 100) : null,
			actualPrimaryConcurrencyImprovementPercent,
			actualPrimaryConcurrencySpeedup,
			chunkSamples: Object.freeze(samples.map(copyChunkSample)),
			h1: createH1Completed(run)
		};
		Object.defineProperty(completedValue, "_h1BatchKey", {value: run.h1.batchKey, enumerable: false});
		Object.defineProperty(completedValue, "_h1OriginAt", {value: run.h1.originAt, enumerable: false});
		const completed = Object.freeze(completedValue);
		activeRuns.delete(token.id);
		recentRuns.push(completed);
		if (recentRuns.length > boundedRunLimit) recentRuns.shift();
		counters.completedRuns++;
		if (normalizedStatus === "cancelled") counters.cancelledRuns++;
		else if (normalizedStatus !== "committed") counters.failedRuns++;
		return completed;
	}

	function getSnapshot() {
		const activeChunkCount = [...activeRuns.values()].reduce((total, run) => total + run.activeChunks, 0);
		return Object.freeze({
			generation,
			startedRunCount: counters.startedRuns,
			completedRunCount: counters.completedRuns,
			cancelledRunCount: counters.cancelledRuns,
			failedRunCount: counters.failedRuns,
			primaryChunkRequestCount: counters.primaryChunkRequests,
			primaryChunkMessageCount: counters.primaryChunkMessages,
			primaryInputChars: counters.primaryInputChars,
			repairBatchRequestCount: counters.repairBatchRequests,
			repairBatchMessageCount: counters.repairBatchMessages,
			repairItemRequestCount: counters.repairItemRequests,
			atomicCommitCount: counters.atomicCommits,
			h1LateEventCount: counters.h1LateEvents,
			h1OrphanEventCount: counters.h1OrphanEvents,
			h1DuplicateEventCount: counters.h1DuplicateEvents,
			liveTurnDuringRunCount: counters.liveTurnsDuringRuns,
			liveOverlapDuringChunkCount: counters.liveOverlapDuringChunks,
			maxActiveChunkCount: counters.maxActiveChunks,
			activeRunCount: activeRuns.size,
			activeChunkCount,
			recentRunCount: recentRuns.length,
			latestRun: recentRuns.length ? recentRuns[recentRuns.length - 1] : null,
			recentRuns: Object.freeze(recentRuns.slice())
		});
	}

	function reset() {
		generation++;
		activeRuns = new Map();
		recentRuns = [];
		counters = createCounters();
	}

	return Object.freeze({
		beginRun,
		recordStage,
		recordCache,
		beginLogical,
		recordLease,
		beginAttempt,
		recordAttemptDispatched,
		recordAttemptSettled,
		finishLogical,
		recordParseValidate,
		recordDomConfirm,
		recordDomConfirmByBatchKey,
		recordChunkStarted,
		recordChunkSettled,
		recordLiveTurnStarted,
		recordRepairRequest,
		recordCommitPreparation,
		recordAtomicCommit,
		finishRun,
		getSnapshot,
		reset
	});
}

module.exports = {
	DEFAULT_RUN_LIMIT,
	DEFAULT_CHUNK_SAMPLE_LIMIT,
	DEFAULT_H1_SAMPLE_LIMIT,
	createHistoricalBatchPerformanceTrace
};
