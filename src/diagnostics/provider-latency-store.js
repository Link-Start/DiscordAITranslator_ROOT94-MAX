const {BATCH_ANSWER_SHAPES} = require("../planner/semantic-batch-answer");
const {MAX_RECENT_BATCH_ANSWERS, sanitizeBatchAnswerObservation} = require("./batch-answer-observation");
// Owns in-memory latency measurements, sliding-window quantiles and error counters
// for AI translation and detection requests. Keeps only bounded anonymous metrics;
// never accepts or records text, endpoints, keys or prompt contents.
// Factory function only: no module-level shared mutable state.

const {createW2WireBenchmarkStore} = require("./w2-wire-benchmark-store");

const MAX_ATTEMPTS_CAPACITY = 20;
const MAX_QUANTILE_SAMPLES = 10;
const MIN_QUANTILE_SAMPLES = 5;
const MAX_TOKEN_COUNT = 10000000;
const MAX_DURATION_MS = 3600000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVATION_COUNT = 4096;
const MAX_WIRE_AMPLIFICATION = 1024;
const WIRE_OBSERVATION_SCHEMA_VERSION = "w0-1";
// W3 compile shadow: bounded windows of anonymous per-message and per-batch D compile records.
const SHADOW_SCHEMA_VERSION = "w3-shadow-1";
const SHADOW_CAPACITY = 64;
const SHADOW_BATCH_CAPACITY = 32;
const MAX_SHADOW_MICROS = 3600000000;
const MAX_PERMILLE = 1000000;
const ALLOWED_SHADOW_STATUSES = new Set(["ok", "identity-mismatch", "budget", "compile-failed"]);
const ALLOWED_SHADOW_REASONS = new Set(["body-budget", "item-budget", "system-prompt-budget", "no-segments", "invalid-plan", "protected-leak", "marker-collision", "lookalike-marker", "planner-error", "unknown"]);
const SHADOW_LABEL_RE = /^[a-z0-9_.:-]{1,48}$/;
const SHADOW_NUMERIC_FIELDS = Object.freeze({
	typedBytes: MAX_REQUEST_BODY_BYTES,
	typedPromptBytes: MAX_SOURCE_BYTES,
	typedEstimatedTokens: MAX_TOKEN_COUNT,
	typedSegmentCount: MAX_OBSERVATION_COUNT,
	dBytes: MAX_REQUEST_BODY_BYTES,
	dPromptBytes: MAX_SOURCE_BYTES,
	dEstimatedTokens: MAX_TOKEN_COUNT,
	dRangeCount: MAX_OBSERVATION_COUNT,
	bodyRatioPermille: MAX_PERMILLE,
	inputRatioPermille: MAX_PERMILLE,
	contextCoveragePermille: 1000,
	translateCoveragePermille: 1000,
	insertedBreaks: MAX_OBSERVATION_COUNT,
	prohibitedFieldCount: MAX_OBSERVATION_COUNT,
	compileMicros: MAX_SHADOW_MICROS
});
const SHADOW_BATCH_NUMERIC_FIELDS = Object.freeze({
	itemCount: MAX_OBSERVATION_COUNT,
	shadowedCount: MAX_OBSERVATION_COUNT,
	okCount: MAX_OBSERVATION_COUNT,
	identityMismatchCount: MAX_OBSERVATION_COUNT,
	windowedCount: MAX_OBSERVATION_COUNT,
	typedBatchBytes: MAX_REQUEST_BODY_BYTES,
	typedPromptBytes: MAX_SOURCE_BYTES,
	dBytesSum: MAX_REQUEST_BODY_BYTES,
	dPromptBytes: MAX_SOURCE_BYTES,
	bodyRatioPermille: MAX_PERMILLE,
	inputRatioPermille: MAX_PERMILLE
});

const ALLOWED_KINDS = new Set(["manual", "live", "historical", "detect"]);
const TRANSLATION_KINDS = new Set(["manual", "live", "historical"]);
const ALLOWED_ROLES = new Set(["primary", "backup", "repair", "fallback"]);
const ALLOWED_ERROR_CLASSES = new Set(["auth", "not_found", "rate_limit", "server", "network", "timeout", "abort", "invalid", "invalid_request", "unsupported_field", "unsupported_value", "sampling_conflict", "schema", "unknown"]);
const ALLOWED_LANES = new Set(["manual", "auto-single", "history-primary", "batch-repair", "item-repair", "live-burst", "reply", "embed-forward", "sent", "cache-hit", "unknown"]);
const ALLOWED_ENGINE_FAMILIES = new Set(["custom", "ai", "native", "classic", "unknown"]);
const ALLOWED_OUTCOMES = new Set(["translated", "skipped", "failed", "cancelled", "stale"]);
const ALLOWED_STAGES = new Set(["precheck", "protection", "cache", "provider", "parse", "placeholder", "target-language", "similarity", "repair", "display-currentness"]);
const ALLOWED_REASONS = new Set(["malformed", "unknown-id", "duplicate-id", "missing-id", "empty", "placeholder-mismatch", "wrong-language", "too-similar", "attempt-budget", "body-budget", "token-budget", "capability-unverified", "unknown"]);
const ALLOWED_FALLBACK_REASONS = new Set(["root-malformed", "root-schema-incompatible", "unknown"]);
const ALLOWED_BATCH_SHAPES = new Set(BATCH_ANSWER_SHAPES);
const ALLOWED_WIRE_FAMILIES = new Set(["typed", "typed-json", "native", "native-multi", "classic", "classic-marked", "classic-tagged", "legacy", "legacy-single", "legacy-batch", "compact-order", "compact-marker", "whole-marker", "whole", "unknown"]);
const ALLOWED_PROTECTED_INTEGRITIES = new Set(["pass", "fail", "unknown"]);

const WIRE_NUMERIC_FIELDS = Object.freeze({
	sourceBytes: MAX_SOURCE_BYTES,
	translateBytes: MAX_SOURCE_BYTES,
	wireBytes: MAX_REQUEST_BODY_BYTES,
	promptBytes: MAX_SOURCE_BYTES,
	metadataBytes: MAX_SOURCE_BYTES,
	requestBodyBytes: MAX_REQUEST_BODY_BYTES,
	segmentCount: MAX_OBSERVATION_COUNT,
	itemCount: MAX_OBSERVATION_COUNT,
	contextBytes: MAX_SOURCE_BYTES,
	protectedMarkerBytes: MAX_SOURCE_BYTES,
	prohibitedFieldCount: MAX_OBSERVATION_COUNT,
	danglingContextRefCount: MAX_OBSERVATION_COUNT,
	danglingContextRefBytes: MAX_SOURCE_BYTES,
	configuredTermLeakCount: MAX_OBSERVATION_COUNT,
	wrapperContentLeakCount: MAX_OBSERVATION_COUNT,
	emailLeakCount: MAX_OBSERVATION_COUNT,
	bareDomainLeakCount: MAX_OBSERVATION_COUNT,
	ipPortLeakCount: MAX_OBSERVATION_COUNT,
	commandLeakCount: MAX_OBSERVATION_COUNT
});
const BLANK_WIRE_OBSERVATION_FIELDS = Object.freeze(Object.assign({
	schemaVersion: null,
	wireFamily: null,
	wireVersion: null
}, Object.fromEntries(Object.keys(WIRE_NUMERIC_FIELDS).map(field => [field, null])), {
	wireAmplification: null,
	contextIncluded: false,
	protectedIntegrity: "unknown"
}));

function whole(value, maximum, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.floor(number))) : fallback;
}

function nullableWhole(value, maximum) {
	return value == null || !Number.isFinite(Number(value)) ? null : whole(value, maximum);
}

// The historical batch path validates with the S8 vocabulary (missing_id, wrong_language,
// same_as_source, ...); the wire counters use the serializer's hyphenated names. Until this
// mapping every such reason landed in the "unknown" bucket (41 of 58 in the 2026-09-13
// field session).
const SEMANTIC_REASON_ALIASES = Object.freeze({same_as_source: "too-similar", placeholder_missing: "placeholder-mismatch", policy_rejected: "unknown"});
function normalizeSemanticReason(reason) {
	const text = String(reason == null ? "" : reason).trim().toLowerCase();
	return SEMANTIC_REASON_ALIASES[text] || text.replace(/_/g, "-");
}

function safeEnum(value, allowed, fallback) {
	const text = String(value || "").toLowerCase();
	return allowed.has(text) ? text : fallback;
}

function safeStatus(value, errorClass) {
	const status = String(value || (errorClass ? "error" : "ok")).toLowerCase();
	return /^(?:ok|error|network|timeout|cancelled|unknown|http_[1-5][0-9]{2})$/.test(status) ? status : "unknown";
}

function createSessionCounters() {
	return {
		failoverCount: 0,
		timeoutCount: 0,
		rateLimitCount: 0,
		streamAttemptCount: 0,
		streamFallbackCount: 0,
		streamCancelCount: 0,
		streamChunkCount: 0,
		// Every recorded event is one physical HTTP dispatch; a batch hit is a
		// translation dispatch that carried more than one message.
		attemptTotalCount: 0,
		batchRequestCount: 0,
		batchMessageCount: 0,
		historicalAttemptCount: 0,
		historicalBatchRequestCount: 0,
		historicalBatchMessageCount: 0,
		historicalFailoverCount: 0,
		historicalTimeoutCount: 0,
		historicalRateLimitCount: 0
	};
}

function createWireCounters() {
	return {
		attemptCount: 0,
		localSampleCount: 0,
		latestLocal: null,
		repairReasonCounts: {},
		fallbackReasonCounts: {},
		batchShapeCounts: {},
		batchAnswerCount: 0,
		recentBatchAnswers: [],
		budgetCounts: {attempt: 0, body: 0, token: 0, capability: 0},
		leakCounts: {configuredTerm: 0, wrapperContent: 0, email: 0, bareDomain: 0, ipPort: 0, command: 0},
		display: {latestMs: null, confirmedCount: 0, deferredCount: 0, staleCount: 0, failedCount: 0}
	};
}

function normalizeUsage(usage) {
	const source = usage && typeof usage == "object" && !Array.isArray(usage) ? usage : {};
	const tokenCount = value => value == null || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : whole(value, MAX_TOKEN_COUNT);
	return Object.freeze({
		promptTokens: tokenCount(source.promptTokens),
		completionTokens: tokenCount(source.completionTokens),
		reasoningTokens: tokenCount(source.reasoningTokens)
	});
}

function normalizeWireObservation(value) {
	if (!value || typeof value != "object" || Array.isArray(value) || value.schemaVersion !== WIRE_OBSERVATION_SCHEMA_VERSION) return null;
	const output = {
		schemaVersion: WIRE_OBSERVATION_SCHEMA_VERSION,
		wireFamily: safeEnum(value.wireFamily, ALLOWED_WIRE_FAMILIES, "unknown"),
		wireVersion: /^[A-Za-z0-9._:-]{1,32}$/.test(String(value.wireVersion || "")) ? String(value.wireVersion) : null
	};
	for (const [field, maximum] of Object.entries(WIRE_NUMERIC_FIELDS)) output[field] = nullableWhole(value[field], maximum);
	output.wireAmplification = value.wireAmplification == null || !Number.isFinite(Number(value.wireAmplification)) ? null : Math.max(0, Math.min(MAX_WIRE_AMPLIFICATION, Number(value.wireAmplification)));
	output.contextIncluded = value.contextIncluded === true;
	output.protectedIntegrity = safeEnum(value.protectedIntegrity, ALLOWED_PROTECTED_INTEGRITIES, "unknown");
	return Object.freeze(output);
}

function normalizeShadowRecord(value, fields) {
	if (!value || typeof value != "object" || Array.isArray(value) || value.schemaVersion !== SHADOW_SCHEMA_VERSION) return null;
	const output = {schemaVersion: SHADOW_SCHEMA_VERSION, contractRevision: SHADOW_LABEL_RE.test(String(value.contractRevision || "")) ? String(value.contractRevision) : null};
	for (const [field, maximum] of Object.entries(fields)) output[field] = nullableWhole(value[field], maximum);
	return output;
}

function createShadowCounters() {
	return {count: 0, okCount: 0, identityMismatchCount: 0, budgetFailCount: 0, compileFailedCount: 0, prohibitedCount: 0, windowedCount: 0, batchCount: 0, batchItemCount: 0, batchTypedBytes: 0, batchDBytes: 0};
}

function quantiles(values) {
	const sorted = values.filter(value => value != null).sort((left, right) => left - right), count = sorted.length;
	const rank = ratio => sorted[Math.max(0, Math.min(count - 1, Math.ceil(ratio * count) - 1))];
	return count ? {count, p50: rank(0.5), p95: rank(0.95), max: sorted[count - 1]} : {count: 0, p50: null, p95: null, max: null};
}

function createProviderLatencyStore({now = Date.now} = {}) {
	let generation = 0;
	let requestSequence = 0;
	let attempts = [];
	const failovers = new Set();
	const requestAttemptCounters = new Map();
	let sessionCounters = createSessionCounters();
	let wireCounters = createWireCounters();
	let shadowRows = [], shadowBatches = [], shadowCounters = createShadowCounters();
	const w2Store = createW2WireBenchmarkStore({now});

	function beginLatencyRequest({kind = "manual", lane = "unknown", queueWaitMs = null, messageCount = 1, inputChars = null} = {}) {
		const requestId = ++requestSequence;
		return Object.freeze({
			requestId,
			generation,
			kind: ALLOWED_KINDS.has(kind) ? kind : "manual",
			lane: safeEnum(lane, ALLOWED_LANES, "unknown"),
			queueWaitMs: queueWaitMs != null ? Math.max(0, Number(queueWaitMs) || 0) : null,
			messageCount: Math.max(1, Number(messageCount) || 1),
			inputChars: inputChars != null ? Math.max(0, Number(inputChars) || 0) : null
		});
	}

	function incrementReasonCounter(target, reason, amount = 1, allowed = ALLOWED_REASONS) {
		const normalized = safeEnum(reason, allowed, "unknown");
		target[normalized] = whole((target[normalized] || 0) + amount, Number.MAX_SAFE_INTEGER);
	}

	function incrementBudgetCounter(reason, amount = 1) {
		const key = reason === "attempt-budget" ? "attempt" : reason === "body-budget" ? "body" : reason === "token-budget" ? "token" : reason === "capability-unverified" ? "capability" : null;
		if (key) wireCounters.budgetCounts[key] = whole(wireCounters.budgetCounts[key] + amount, Number.MAX_SAFE_INTEGER);
	}

	function applyWireCounters(observation, role, reason, amount = 1) {
		const count = Math.max(1, whole(amount, MAX_OBSERVATION_COUNT, 1));
		if (observation) {
			wireCounters.attemptCount = whole(wireCounters.attemptCount + count, Number.MAX_SAFE_INTEGER);
			for (const [source, target] of [
				["configuredTermLeakCount", "configuredTerm"],
				["wrapperContentLeakCount", "wrapperContent"],
				["emailLeakCount", "email"],
				["bareDomainLeakCount", "bareDomain"],
				["ipPortLeakCount", "ipPort"],
				["commandLeakCount", "command"]
			]) wireCounters.leakCounts[target] = whole(wireCounters.leakCounts[target] + (observation[source] || 0) * count, Number.MAX_SAFE_INTEGER);
		}
		if (reason != null) {
			if (role === "repair" || role === "retry") incrementReasonCounter(wireCounters.repairReasonCounts, reason, count);
			if (role === "fallback") incrementReasonCounter(wireCounters.fallbackReasonCounts, reason, count, ALLOWED_FALLBACK_REASONS);
			incrementBudgetCounter(safeEnum(reason, ALLOWED_REASONS, "unknown"), count);
		}
	}

	function recordLatencyEvent({
		token,
		role = "primary",
		observationRole = null,
		engineKey = "",
		engineFamily = "unknown",
		transportMs = 0,
		leaseWaitMs = null,
		status = "ok",
		httpStatus = null,
		errorClass = null,
		messageCount = null,
		outputChars = null,
		outcome = null,
		stage = "provider",
		reason = null,
		usage = null,
		wireObservation = null,
		streaming = false,
		ttftMs = null,
		streamChunkCount = 0,
		streamFallback = false,
		finishedAt = null
	} = {}) {
		if (!token || token.generation !== generation) return null;

		const reqKey = `${generation}:${token.requestId}`;
		const attemptIndex = (requestAttemptCounters.get(reqKey) || 0) + 1;
		requestAttemptCounters.set(reqKey, attemptIndex);

		const normalizedRole = observationRole == null ? safeEnum(role, ALLOWED_ROLES, "primary") : safeEnum(observationRole, ALLOWED_ROLES, "primary");
		if (normalizedRole === "backup") {
			if (!failovers.has(reqKey)) {
				failovers.add(reqKey);
				sessionCounters.failoverCount++;
				if (token.kind === "historical") sessionCounters.historicalFailoverCount++;
			}
		}

		const normalizedStatus = safeStatus(status, errorClass);
		const normalizedErrorClass = ALLOWED_ERROR_CLASSES.has(errorClass) ? errorClass : errorClass ? "unknown" : null;
		if (normalizedStatus === "timeout" || normalizedErrorClass === "timeout") {
			sessionCounters.timeoutCount++;
			if (token.kind === "historical") sessionCounters.historicalTimeoutCount++;
		}
		if (normalizedStatus === "http_429" || normalizedErrorClass === "rate_limit") {
			sessionCounters.rateLimitCount++;
			if (token.kind === "historical") sessionCounters.historicalRateLimitCount++;
		}

		const normalizedStreaming = !!streaming;
		const normalizedTtftMs = normalizedStreaming && ttftMs != null ? whole(ttftMs, MAX_DURATION_MS) : null;
		const normalizedStreamChunkCount = normalizedStreaming ? whole(streamChunkCount, Number.MAX_SAFE_INTEGER) : 0;
		const normalizedWire = normalizeWireObservation(wireObservation);
		const normalizedUsage = normalizeUsage(usage);
		const normalizedReason = reason == null || reason === "" ? null : safeEnum(reason, ALLOWED_REASONS, "unknown");
		const normalizedOutcome = outcome == null || outcome === ""
			? normalizedStatus === "ok" ? "translated" : normalizedStatus === "cancelled" ? "cancelled" : "failed"
			: safeEnum(outcome, ALLOWED_OUTCOMES, "failed");
		const record = Object.freeze(Object.assign({
			requestId: token.requestId,
			generation: token.generation,
			kind: token.kind,
			lane: token.lane,
			queueWaitMs: token.queueWaitMs,
			role: normalizedRole,
			attempt: attemptIndex,
			engineKey: String(engineKey || ""),
			engineFamily: safeEnum(engineFamily, ALLOWED_ENGINE_FAMILIES, "unknown"),
			transportMs: whole(transportMs, MAX_DURATION_MS),
			providerMs: whole(transportMs, MAX_DURATION_MS),
			leaseWaitMs: nullableWhole(leaseWaitMs, MAX_DURATION_MS),
			enqueueToDomMs: null,
			status: normalizedStatus,
			httpStatus: nullableWhole(httpStatus, 999),
			errorClass: normalizedErrorClass,
			messageCount: messageCount != null ? Math.max(1, whole(messageCount, MAX_OBSERVATION_COUNT, 1)) : token.messageCount,
			inputChars: token.inputChars != null ? token.inputChars : null,
			outputChars: nullableWhole(outputChars, MAX_SOURCE_BYTES),
			promptTokens: normalizedUsage.promptTokens,
			completionTokens: normalizedUsage.completionTokens,
			reasoningTokens: normalizedUsage.reasoningTokens,
			requestCount: 1,
			repairCount: normalizedRole === "repair" || normalizedRole === "retry" ? 1 : 0,
			fallbackCount: normalizedRole === "fallback" ? 1 : 0,
			outcome: normalizedOutcome,
			stage: safeEnum(stage, ALLOWED_STAGES, "provider"),
			reason: normalizedReason,
			streaming: normalizedStreaming,
			ttftMs: normalizedTtftMs,
			streamChunkCount: normalizedStreamChunkCount,
			streamFallback: normalizedStreaming && !!streamFallback,
			finishedAt: finishedAt == null || !Number.isFinite(Number(finishedAt)) ? now() : Math.max(0, Number(finishedAt))
		}, normalizedWire || BLANK_WIRE_OBSERVATION_FIELDS));

		applyWireCounters(normalizedWire, normalizedRole, normalizedReason);
		sessionCounters.attemptTotalCount++;
		if (record.streaming) {
			sessionCounters.streamAttemptCount++;
			sessionCounters.streamChunkCount += record.streamChunkCount;
			if (record.streamFallback) sessionCounters.streamFallbackCount++;
			if (record.status === "cancelled" || record.errorClass === "abort") sessionCounters.streamCancelCount++;
		}
		if (record.kind === "historical") sessionCounters.historicalAttemptCount++;
		if (TRANSLATION_KINDS.has(record.kind) && record.messageCount > 1) {
			sessionCounters.batchRequestCount++;
			sessionCounters.batchMessageCount += record.messageCount;
			if (record.kind === "historical") {
				sessionCounters.historicalBatchRequestCount++;
				sessionCounters.historicalBatchMessageCount += record.messageCount;
			}
		}

		attempts.push(record);
		if (attempts.length > MAX_ATTEMPTS_CAPACITY) {
			const removed = attempts.shift();
			const removedKey = removed && `${removed.generation}:${removed.requestId}`;
			if (removedKey && !attempts.some(attempt => `${attempt.generation}:${attempt.requestId}` === removedKey)) {
				requestAttemptCounters.delete(removedKey);
				failovers.delete(removedKey);
			}
		}
		return record;
	}

	// Records serializer/validator outcomes which have no physical latency attempt.
	// The token guard gives these events the same reset/late-event semantics as settle.
	function recordSemanticObservation({token, reason = null, fallbackKind = null, count = 1, shape = null, shapes = null, batchAnswer = null} = {}) {
		if (!token || token.generation !== generation) return null;
		const answer = batchAnswer && sanitizeBatchAnswerObservation(Object.assign({}, batchAnswer, {requestId: token.requestId}));
		if (answer) {
			wireCounters.batchAnswerCount = whole(wireCounters.batchAnswerCount + 1, Number.MAX_SAFE_INTEGER);
			wireCounters.recentBatchAnswers.push(answer);
			if (wireCounters.recentBatchAnswers.length > MAX_RECENT_BATCH_ANSWERS) {
				// Reserve room for the latest eight problematic answers in the same 20-row
				// buffer. Successful traffic must not erase the evidence for a rare fallback.
				const recent = wireCounters.recentBatchAnswers;
				const problem = row => !!(row.malformed || row.fallbackStarted || row.missingMessageCount || row.unreadableMessageCount || row.missingIdRowCount || row.unknownIdRowCount || row.duplicateMessageRowCount || row.invalidRowCount || row.missingSegmentCount);
				const problemCount = recent.reduce((count, row) => count + Number(problem(row)), 0);
				const removeAt = problemCount > 8 ? 0 : recent.findIndex(row => !problem(row));
				recent.splice(Math.max(0, removeAt), 1);
			}
		}
		const amount = Math.max(1, whole(count, MAX_OBSERVATION_COUNT, 1));
		// Batch answer shapes the tolerant reader recovered or refused; a closed vocabulary.
		for (const item of [].concat(shape || [], shapes || [])) if (item != null && item !== "") incrementReasonCounter(wireCounters.batchShapeCounts, item, amount, ALLOWED_BATCH_SHAPES);
		if (reason != null && reason !== "") {
			const normalizedReason = safeEnum(normalizeSemanticReason(reason), ALLOWED_REASONS, "unknown");
			incrementReasonCounter(wireCounters.repairReasonCounts, normalizedReason, amount);
			incrementBudgetCounter(normalizedReason, amount);
		}
		if (fallbackKind != null && fallbackKind !== "") incrementReasonCounter(wireCounters.fallbackReasonCounts, fallbackKind, amount, ALLOWED_FALLBACK_REASONS);
		return true;
	}

	function recordWireObservationEvent({token, role = "primary", reason = null, wireObservation = null, count = 1} = {}) {
		if (!token || token.generation !== generation) return null;
		const normalizedWire = normalizeWireObservation(wireObservation);
		if (!normalizedWire) return false;
		wireCounters.localSampleCount = whole(wireCounters.localSampleCount + Math.max(1, whole(count, MAX_OBSERVATION_COUNT, 1)), Number.MAX_SAFE_INTEGER);
		wireCounters.latestLocal = normalizedWire;
		return true;
	}

	// W3: one anonymous D compile record per typed request. Unknown fields are dropped, every
	// number is bounded, the status and failure reason are closed enums, no text is accepted.
	function recordCompactWireShadow(record) {
		const normalized = normalizeShadowRecord(record, SHADOW_NUMERIC_FIELDS);
		if (!normalized) return false;
		normalized.status = safeEnum(record.status, ALLOWED_SHADOW_STATUSES, "compile-failed");
		normalized.failureReason = record.failureReason == null ? null : safeEnum(record.failureReason, ALLOWED_SHADOW_REASONS, "unknown");
		normalized.identityMatch = record.identityMatch === true;
		normalized.budgetOk = record.budgetOk == null ? null : record.budgetOk === true;
		normalized.windowed = record.windowed === true;
		normalized.recordedAt = now();
		shadowRows.push(Object.freeze(normalized));
		while (shadowRows.length > SHADOW_CAPACITY) shadowRows.shift();
		shadowCounters.count++;
		if (normalized.status === "ok") shadowCounters.okCount++;
		if (normalized.status === "identity-mismatch") shadowCounters.identityMismatchCount++;
		if (normalized.status === "budget" || normalized.budgetOk === false) shadowCounters.budgetFailCount++;
		if (normalized.status === "compile-failed") shadowCounters.compileFailedCount++;
		if (normalized.prohibitedFieldCount > 0) shadowCounters.prohibitedCount++;
		if (normalized.windowed) shadowCounters.windowedCount++;
		return true;
	}

	function recordCompactWireShadowBatch(record) {
		const normalized = normalizeShadowRecord(record, SHADOW_BATCH_NUMERIC_FIELDS);
		if (!normalized) return false;
		normalized.recordedAt = now();
		shadowBatches.push(Object.freeze(normalized));
		while (shadowBatches.length > SHADOW_BATCH_CAPACITY) shadowBatches.shift();
		shadowCounters.batchCount++;
		shadowCounters.batchItemCount = whole(shadowCounters.batchItemCount + (normalized.itemCount || 0), Number.MAX_SAFE_INTEGER);
		shadowCounters.batchTypedBytes = whole(shadowCounters.batchTypedBytes + (normalized.typedBatchBytes || 0), Number.MAX_SAFE_INTEGER);
		shadowCounters.batchDBytes = whole(shadowCounters.batchDBytes + (normalized.dBytesSum || 0), Number.MAX_SAFE_INTEGER);
		return true;
	}

	function getCompactWireShadowSnapshot() {
		const ok = shadowRows.filter(row => row.status === "ok");
		const latest = shadowRows.length ? shadowRows[shadowRows.length - 1] : null;
		return Object.freeze({
			schemaVersion: SHADOW_SCHEMA_VERSION,
			generation,
			contractRevision: latest ? latest.contractRevision : null,
			capacity: SHADOW_CAPACITY,
			count: shadowCounters.count,
			windowCount: shadowRows.length,
			okCount: shadowCounters.okCount,
			identityMismatchCount: shadowCounters.identityMismatchCount,
			budgetFailCount: shadowCounters.budgetFailCount,
			compileFailedCount: shadowCounters.compileFailedCount,
			prohibitedCount: shadowCounters.prohibitedCount,
			windowedCount: shadowCounters.windowedCount,
			windowedPermille: shadowCounters.okCount ? whole(Math.round(1000 * shadowCounters.windowedCount / shadowCounters.okCount), 1000) : null,
			bodyRatioPermille: Object.freeze(quantiles(ok.map(row => row.bodyRatioPermille))),
			inputRatioPermille: Object.freeze(quantiles(ok.map(row => row.inputRatioPermille))),
			compileMicros: Object.freeze(quantiles(shadowRows.map(row => row.compileMicros))),
			typedBytes: whole(shadowRows.reduce((total, row) => total + (row.typedBytes || 0), 0), Number.MAX_SAFE_INTEGER),
			dBytes: whole(ok.reduce((total, row) => total + (row.dBytes || 0), 0), Number.MAX_SAFE_INTEGER),
			latest,
			batches: Object.freeze({
				count: shadowCounters.batchCount,
				windowCount: shadowBatches.length,
				itemCount: shadowCounters.batchItemCount,
				typedBatchBytes: shadowCounters.batchTypedBytes,
				dBytesSum: shadowCounters.batchDBytes,
				bodyRatioPermille: Object.freeze(quantiles(shadowBatches.map(row => row.bodyRatioPermille))),
				inputRatioPermille: Object.freeze(quantiles(shadowBatches.map(row => row.inputRatioPermille))),
				latest: shadowBatches.length ? shadowBatches[shadowBatches.length - 1] : null
			})
		});
	}

	function resetCompactWireShadow() {
		shadowRows = [];
		shadowBatches = [];
		shadowCounters = createShadowCounters();
		return true;
	}

	function recordDisplayObservation({generation: eventGeneration = null, requestId = null, outcome = "failed", enqueueToDomMs = null} = {}) {
		if (eventGeneration != null && Number(eventGeneration) !== generation) return null;
		const normalized = ["confirmed", "deferred", "stale", "failed"].includes(String(outcome)) ? String(outcome) : "failed";
		const field = normalized === "confirmed" ? "confirmedCount" : normalized === "deferred" ? "deferredCount" : normalized === "stale" ? "staleCount" : "failedCount";
		wireCounters.display[field] = whole(wireCounters.display[field] + 1, Number.MAX_SAFE_INTEGER);
		if (normalized === "confirmed" && enqueueToDomMs != null) {
			wireCounters.display.latestMs = nullableWhole(enqueueToDomMs, MAX_DURATION_MS);
			if (requestId != null) for (let index = attempts.length - 1; index >= 0; index--) if (attempts[index] && attempts[index].kind === "live" && attempts[index].requestId === Number(requestId)) {if (attempts[index].enqueueToDomMs == null) attempts[index] = Object.freeze(Object.assign({}, attempts[index], {enqueueToDomMs: wireCounters.display.latestMs})); break;}
		}
		return true;
	}

	function recordAttemptOutcome({token, outcome = "failed", stage = "provider", reason = null} = {}) {
		if (!token || token.generation !== generation) return null;
		for (let index = attempts.length - 1; index >= 0; index--) {
			const attempt = attempts[index];
			if (!attempt || attempt.requestId !== token.requestId || attempt.generation !== token.generation) continue;
			attempts[index] = Object.freeze(Object.assign({}, attempt, {outcome: safeEnum(outcome, ALLOWED_OUTCOMES, "failed"), stage: safeEnum(stage, ALLOWED_STAGES, "provider"), reason: reason == null || reason === "" ? null : safeEnum(reason, ALLOWED_REASONS, "unknown")}));
			return attempts[index];
		}
		return false;
	}

	function getWireObservationSnapshot() {
		return Object.freeze({
			schemaVersion: WIRE_OBSERVATION_SCHEMA_VERSION,
			generation,
			attemptCount: wireCounters.attemptCount,
			localSampleCount: wireCounters.localSampleCount,
			latestLocal: wireCounters.latestLocal,
			repairReasonCounts: Object.freeze(Object.assign({}, wireCounters.repairReasonCounts)),
			fallbackReasonCounts: Object.freeze(Object.assign({}, wireCounters.fallbackReasonCounts)),
			batchShapeCounts: Object.freeze(Object.assign({}, wireCounters.batchShapeCounts)),
			batchAnswerCount: wireCounters.batchAnswerCount,
			recentBatchAnswers: Object.freeze(wireCounters.recentBatchAnswers.slice()),
			budgetCounts: Object.freeze(Object.assign({}, wireCounters.budgetCounts)),
			leakCounts: Object.freeze(Object.assign({}, wireCounters.leakCounts)),
			display: Object.freeze(Object.assign({}, wireCounters.display))
		});
	}

	function getLatencySnapshot({engineKey = null} = {}) {
		const latestAttempt = attempts.length ? attempts[attempts.length - 1] : null;
		const findLatest = predicate => {
			for (let index = attempts.length - 1; index >= 0; index--) if (predicate(attempts[index])) return attempts[index];
			return null;
		};
		const latestTranslation = findLatest(attempt => attempt && TRANSLATION_KINDS.has(attempt.kind));
		const latestDetect = findLatest(attempt => attempt && attempt.kind === "detect");
		const latestQueuedTranslation = findLatest(attempt => attempt && TRANSLATION_KINDS.has(attempt.kind) && attempt.queueWaitMs != null);
		const targetEngine = engineKey || (latestTranslation && latestTranslation.engineKey) || (latestDetect && latestDetect.engineKey) || null;
		const getNearestRankStats = values => {
			const samples = values.slice(-MAX_QUANTILE_SAMPLES);
			const count = samples.length;
			if (count < MIN_QUANTILE_SAMPLES) return {count, sufficient: false, p50: null, p95: null};
			const sorted = samples.slice().sort((a, b) => a - b);
			return {
				count,
				sufficient: true,
				p50: sorted[Math.max(0, Math.min(count - 1, Math.ceil(0.50 * count) - 1))],
				p95: sorted[Math.max(0, Math.min(count - 1, Math.ceil(0.95 * count) - 1))]
			};
		};

		const candidateAttempts = attempts.filter(attempt =>
			attempt && TRANSLATION_KINDS.has(attempt.kind) && attempt.status === "ok" && (!targetEngine || attempt.engineKey === targetEngine)
		);
		const translationStats = getNearestRankStats(candidateAttempts.map(sample => sample.transportMs));
		const liveStats = getNearestRankStats(candidateAttempts.filter(sample => sample.kind === "live").map(sample => sample.transportMs));
		const liveTtftStats = getNearestRankStats(attempts.filter(attempt =>
			attempt && attempt.kind === "live" && attempt.status === "ok" && attempt.streaming && attempt.ttftMs != null && (!targetEngine || attempt.engineKey === targetEngine)
		).map(attempt => attempt.ttftMs));
		const queueStats = getNearestRankStats(attempts.filter(attempt =>
			attempt && TRANSLATION_KINDS.has(attempt.kind) && attempt.attempt === 1 && attempt.queueWaitMs != null
		).map(attempt => attempt.queueWaitMs));

		return Object.freeze({
			generation,
			latestAttempt,
			latestTranslation,
			latestDetect,
			engineKey: targetEngine,
			p50Ms: translationStats.p50,
			p95Ms: translationStats.p95,
			sampleCount: translationStats.count,
			sufficient: translationStats.sufficient,
			queueP50Ms: queueStats.p50,
			queueP95Ms: queueStats.p95,
			queueSampleCount: queueStats.count,
			queueSufficient: queueStats.sufficient,
			liveP50Ms: liveStats.p50,
			liveP95Ms: liveStats.p95,
			liveSampleCount: liveStats.count,
			liveSufficient: liveStats.sufficient,
			liveTtftP50Ms: liveTtftStats.p50,
			liveTtftP95Ms: liveTtftStats.p95,
			liveTtftSampleCount: liveTtftStats.count,
			liveTtftSufficient: liveTtftStats.sufficient,
			streamAttemptCount: sessionCounters.streamAttemptCount,
			streamFallbackCount: sessionCounters.streamFallbackCount,
			streamCancelCount: sessionCounters.streamCancelCount,
			streamChunkCount: sessionCounters.streamChunkCount,
			attemptTotalCount: sessionCounters.attemptTotalCount,
			batchRequestCount: sessionCounters.batchRequestCount,
			batchMessageCount: sessionCounters.batchMessageCount,
			historicalAttemptCount: sessionCounters.historicalAttemptCount,
			historicalBatchRequestCount: sessionCounters.historicalBatchRequestCount,
			historicalBatchMessageCount: sessionCounters.historicalBatchMessageCount,
			historicalFailoverCount: sessionCounters.historicalFailoverCount,
			historicalTimeoutCount: sessionCounters.historicalTimeoutCount,
			historicalRateLimitCount: sessionCounters.historicalRateLimitCount,
			failoverCount: sessionCounters.failoverCount,
			timeoutCount: sessionCounters.timeoutCount,
			rateLimitCount: sessionCounters.rateLimitCount,
			queueWaitMs: latestQueuedTranslation ? latestQueuedTranslation.queueWaitMs : null,
			attemptsCount: attempts.length,
			wireObservation: getWireObservationSnapshot(),
			compactWireShadow: getCompactWireShadowSnapshot()
		});
	}

	function resetLatency() {
		generation++;
		attempts = [];
		failovers.clear();
		requestAttemptCounters.clear();
		sessionCounters = createSessionCounters();
		wireCounters = createWireCounters();
		resetCompactWireShadow();
		w2Store.reset();
	}

	return Object.freeze({
		beginLatencyRequest,
		recordLatencyEvent,
		recordSemanticObservation,
		recordWireObservationEvent,
		recordDisplayObservation,
		recordAttemptOutcome,
		recordCompactWireShadow,
		recordCompactWireShadowBatch,
		getCompactWireShadowSnapshot,
		resetCompactWireShadow,
		getLatencySnapshot,
		getWireObservationSnapshot,
		beginW2Session: options => w2Store.beginW2Session(options),
		recordW2Trial: (token, event) => w2Store.recordW2Trial(token, event),
		finishW2Session: token => w2Store.finishW2Session(token),
		cancelW2Session: token => w2Store.cancel(token),
		failW2Session: (token, reason) => w2Store.fail(token, reason),
		resetW2Session: () => w2Store.reset(),
		getW2Snapshot: () => w2Store.getW2Snapshot(),
		resetLatency,
		getAttemptsCount: () => attempts.length,
		getGeneration: () => generation
	});
}

module.exports = {normalizeSemanticReason, createProviderLatencyStore};
