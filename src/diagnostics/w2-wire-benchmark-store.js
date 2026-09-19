// Run-local owner for the explicitly triggered W2 provider benchmark. It accepts
// numbers, finite enums and opaque short fixture/version labels only. Source text,
// prompts, provider configuration, credentials and raw responses have no fields in
// this contract and are discarded by destructuring at the boundary.

const W2_SCHEMA_VERSION = "w2-wire-benchmark-1";
const W2_ARMS = Object.freeze(["typed-json", "compact-order", "compact-marker"]);
// W2b adds the whole-marker arm (D). The frozen three-arm plan and gate stay as they are;
// D is selectable, aggregated and exported, but never enters the W2 comparisons.
const W2_ALL_ARMS = Object.freeze([...W2_ARMS, "whole-marker"]);
const W2_ARM_SET = new Set(W2_ALL_ARMS);
const MAX_W2_TRIALS = 180;
const MAX_W2_PHYSICAL_REQUESTS = 180;
const MAX_TOKEN_COUNT = 1000000000;
const MAX_DURATION_MS = 3600000;
const MAX_BYTES = 2 * 1024 * 1024;
const P50_MIN_SAMPLES = 20;
const P95_MIN_SAMPLES = 50;
const ALLOWED_STATUSES = new Set(["ok", "failed", "timeout", "cancelled"]);
const ALLOWED_ERROR_CLASSES = new Set(["auth", "not_found", "rate_limit", "server", "network", "timeout", "abort", "invalid", "invalid_request", "schema", "malformed", "stale", "unknown"]);
const ALLOWED_REASONS = new Set([
	"malformed", "unknown-id", "duplicate-id", "missing-id", "empty",
	"placeholder-mismatch", "wrong-language", "too-similar", "response-budget",
	"provider-failed", "timeout", "cancelled", "stale", "unknown",
	"network", "provider", "body-budget", "attempt-budget", "configuration",
	"request-build", "consecutive-failures", "fixture-oracle", "marker-schema",
	"duplicate-marker", "unknown-marker", "missing-terminal-marker", "missing-marker",
	"item-count", "unexpected-root", "markdown-fence", "unsafe-structure", "marker-order"
]);
// Segment-level judgements reuse the trial reason enum plus the two outcomes that
// only exist per item: a clean item and a non-string array element.
const W2_SEGMENT_REASONS = Object.freeze([...ALLOWED_REASONS, "ok", "non-string-item"]);
const SEGMENT_REASON_SET = new Set(W2_SEGMENT_REASONS);
const MAX_SEGMENT_DIAGNOSTICS = 128;
const MAX_SEGMENT_CHARS = 1048576;
const MAX_SEGMENT_LINES = 4096;
const MAX_SEGMENT_WORDS = 65536;
const MAX_STRUCTURE_ITEMS = 4096;
const MAX_STRUCTURE_INDEX_LIST = 128;

function whole(value, maximum, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.floor(number))) : fallback;
}

function nullableWhole(value, maximum) {
	return value == null || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : whole(value, maximum);
}

function shortLabel(value) {
	const text = String(value || "");
	return /^[A-Za-z0-9._:-]{1,32}$/.test(text) ? text : null;
}

function frozenRecord(value) {return Object.freeze(Object.assign({}, value));}

function nearestRank(values, percentile) {
	if (!values.length) return null;
	const sorted = values.slice().sort((left, right) => left - right);
	const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1));
	return sorted[index];
}

function percentage(numerator, denominator) {
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
	return Math.round(numerator / denominator * 100000) / 1000;
}

function normalizeUsage(value) {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return Object.freeze({
		promptTokens: nullableWhole(source.promptTokens, MAX_TOKEN_COUNT),
		completionTokens: nullableWhole(source.completionTokens, MAX_TOKEN_COUNT),
		reasoningTokens: nullableWhole(source.reasoningTokens, MAX_TOKEN_COUNT)
	});
}

function nullableBoolean(value) {return value === true ? true : value === false ? false : null;}
// Diagnostics fields accept real numbers only: numeric strings are dropped rather than
// coerced, so a text-bearing value can never survive as a count.
function strictWhole(value, maximum) {return typeof value === "number" ? whole(value, maximum) : 0;}
function strictNullableWhole(value, maximum) {return typeof value === "number" ? nullableWhole(value, maximum) : null;}

function boundedIndexList(value) {
	if (!Array.isArray(value)) return Object.freeze([]);
	const output = [];
	for (const item of value) {
		if (output.length >= MAX_STRUCTURE_INDEX_LIST) break;
		if (typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= MAX_STRUCTURE_ITEMS) output.push(item);
	}
	return Object.freeze(output);
}

// Every field is rebuilt from an explicit whitelist; text-bearing keys on the input
// have no destination and are dropped by construction.
function sanitizeSegmentDiagnostics(value) {
	if (!Array.isArray(value)) return Object.freeze([]);
	return Object.freeze(value.slice(0, MAX_SEGMENT_DIAGNOSTICS).map(row => {
		const source = row && typeof row === "object" && !Array.isArray(row) ? row : {};
		return Object.freeze({
			index: strictWhole(source.index, MAX_STRUCTURE_ITEMS),
			reason: SEGMENT_REASON_SET.has(String(source.reason)) ? String(source.reason) : "unknown",
			sourceChars: strictWhole(source.sourceChars, MAX_SEGMENT_CHARS),
			targetChars: strictNullableWhole(source.targetChars, MAX_SEGMENT_CHARS),
			sourceHasCjk: source.sourceHasCjk === true,
			targetHasCjk: nullableBoolean(source.targetHasCjk),
			sourceLineCount: strictWhole(source.sourceLineCount, MAX_SEGMENT_LINES),
			sourceWordCount: strictWhole(source.sourceWordCount, MAX_SEGMENT_WORDS),
			isListItem: source.isListItem === true,
			isHeading: source.isHeading === true
		});
	}));
}

function sanitizeStructureDiagnostics(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return Object.freeze({
		expectedItemCount: strictWhole(value.expectedItemCount, MAX_STRUCTURE_ITEMS),
		receivedItemCount: strictWhole(value.receivedItemCount, MAX_STRUCTURE_ITEMS),
		missingMarkerIndices: boundedIndexList(value.missingMarkerIndices),
		duplicateMarkerIndices: boundedIndexList(value.duplicateMarkerIndices),
		unknownMarkerCount: strictWhole(value.unknownMarkerCount, MAX_STRUCTURE_ITEMS),
		wrappedInCodeFence: value.wrappedInCodeFence === true,
		leadingChars: strictWhole(value.leadingChars, MAX_SEGMENT_CHARS),
		trailingChars: strictWhole(value.trailingChars, MAX_SEGMENT_CHARS),
		orderPreserved: value.orderPreserved === true,
		terminalMarkerPresent: nullableBoolean(value.terminalMarkerPresent),
		terminalMarkerLast: nullableBoolean(value.terminalMarkerLast),
		outsideMarkerChars: strictNullableWhole(value.outsideMarkerChars, MAX_SEGMENT_CHARS),
		closeMarkerEchoes: strictNullableWhole(value.closeMarkerEchoes, MAX_STRUCTURE_ITEMS),
		// W2c: stray marker characters, context windowing and the one-repair outcome. All
		// numeric or boolean; the repair reason is bounded to the trial reason enum.
		strayMarkerChars: strictNullableWhole(value.strayMarkerChars, MAX_SEGMENT_CHARS),
		windowed: nullableBoolean(value.windowed),
		contextChars: strictNullableWhole(value.contextChars, MAX_SEGMENT_CHARS),
		contextCoveragePermille: strictNullableWhole(value.contextCoveragePermille, 1000),
		firstPassValid: nullableBoolean(value.firstPassValid),
		repairRequested: value.repairRequested === true,
		repairValid: nullableBoolean(value.repairValid),
		repairReason: value.repairReason == null ? null : ALLOWED_REASONS.has(String(value.repairReason)) ? String(value.repairReason) : "unknown",
		repairProviderMs: strictNullableWhole(value.repairProviderMs, MAX_DURATION_MS),
		repairPromptTokens: strictNullableWhole(value.repairPromptTokens, MAX_TOKEN_COUNT),
		repairCompletionTokens: strictNullableWhole(value.repairCompletionTokens, MAX_TOKEN_COUNT),
		responseChars: strictWhole(value.responseChars, MAX_SEGMENT_CHARS),
		responseHasCjk: value.responseHasCjk === true
	});
}

function normalizePlannedArms(value) {
	const requested = Array.isArray(value) ? value.map(String) : W2_ARMS.slice();
	if (!requested.length || requested.some(arm => !W2_ARM_SET.has(arm))) return null;
	return Object.freeze(W2_ALL_ARMS.filter(arm => requested.includes(arm)));
}

function blankArm(arm) {
	return Object.freeze({
		arm,
		warmupCount: 0,
		sampleCount: 0,
		successCount: 0,
		failureCount: 0,
		timeoutCount: 0,
		cancelledCount: 0,
		invalidCount: 0,
		protectedFailureCount: 0,
		providerSampleCount: 0,
		providerP50Ms: null,
		providerP95Ms: null,
		p50Ready: false,
		p95Ready: false,
		promptTokenSampleCount: 0,
		completionTokenSampleCount: 0,
		reasoningTokenSampleCount: 0,
		promptTokens: null,
		completionTokens: null,
		reasoningTokens: null,
		wireByteSampleCount: 0,
		wireBytes: null,
		requestCount: 0,
		nonSingleRequestCount: 0,
		orderDetectable: arm !== "compact-order",
		reasonCounts: Object.freeze({})
	});
}

function aggregateArm(arm, trials) {
	const warmups = trials.filter(trial => trial.arm === arm && trial.warmup);
	const samples = trials.filter(trial => trial.arm === arm && !trial.warmup);
	if (!samples.length && !warmups.length) return blankArm(arm);
	const providerValues = samples.map(trial => trial.providerMs).filter(value => value != null);
	const sumComplete = (field, maximum = MAX_TOKEN_COUNT) => {
		const values = samples.map(trial => trial[field]).filter(value => value != null);
		return {
			count: values.length,
			total: samples.length > 0 && values.length === samples.length
				? whole(values.reduce((total, value) => total + value, 0), maximum)
				: null
		};
	};
	const prompt = sumComplete("promptTokens"), completion = sumComplete("completionTokens"), reasoning = sumComplete("reasoningTokens"), wire = sumComplete("wireBytes", Number.MAX_SAFE_INTEGER);
	const reasonCounts = {};
	for (const sample of samples) if (sample.reason) reasonCounts[sample.reason] = whole((reasonCounts[sample.reason] || 0) + 1, MAX_W2_TRIALS);
	const successCount = samples.filter(trial => trial.status === "ok" && trial.valid && trial.protectedIntegrity !== "fail").length;
	return Object.freeze({
		arm,
		warmupCount: warmups.length,
		sampleCount: samples.length,
		successCount,
		failureCount: samples.filter(trial => trial.status === "failed").length,
		timeoutCount: samples.filter(trial => trial.status === "timeout").length,
		cancelledCount: samples.filter(trial => trial.status === "cancelled").length,
		invalidCount: samples.filter(trial => trial.status === "ok" && !trial.valid).length,
		protectedFailureCount: samples.filter(trial => trial.protectedIntegrity === "fail").length,
		providerSampleCount: providerValues.length,
		providerP50Ms: nearestRank(providerValues, 0.50),
		providerP95Ms: nearestRank(providerValues, 0.95),
		p50Ready: providerValues.length >= P50_MIN_SAMPLES,
		p95Ready: providerValues.length >= P95_MIN_SAMPLES,
		promptTokenSampleCount: prompt.count,
		completionTokenSampleCount: completion.count,
		reasoningTokenSampleCount: reasoning.count,
		promptTokens: prompt.total,
		completionTokens: completion.total,
		reasoningTokens: reasoning.total,
		wireByteSampleCount: wire.count,
		wireBytes: wire.total,
		requestCount: samples.reduce((total, trial) => total + trial.requestCount, 0),
		nonSingleRequestCount: samples.filter(trial => trial.requestCount !== 1).length,
		orderDetectable: arm === "compact-order" ? false : !samples.some(trial => trial.orderDetectable === false),
		reasonCounts: Object.freeze(reasonCounts)
	});
}

function compareArm(baseline, candidate, sessionComplete) {
	const sampleReady = baseline.sampleCount >= P95_MIN_SAMPLES
		&& candidate.sampleCount >= P95_MIN_SAMPLES
		&& baseline.sampleCount === candidate.sampleCount;
	const latencyReady = sampleReady
		&& baseline.providerSampleCount === baseline.sampleCount
		&& candidate.providerSampleCount === candidate.sampleCount
		&& baseline.p50Ready && baseline.p95Ready && candidate.p50Ready && candidate.p95Ready;
	const usageReady = sampleReady
		&& baseline.promptTokens != null && baseline.completionTokens != null
		&& candidate.promptTokens != null && candidate.completionTokens != null;
	const promptReductionPercent = usageReady ? percentage(baseline.promptTokens - candidate.promptTokens, baseline.promptTokens) : null;
	const completionReductionPercent = usageReady ? percentage(baseline.completionTokens - candidate.completionTokens, baseline.completionTokens) : null;
	const providerP50ImprovementPercent = latencyReady ? percentage(baseline.providerP50Ms - candidate.providerP50Ms, baseline.providerP50Ms) : null;
	const providerP95ChangePercent = latencyReady ? percentage(candidate.providerP95Ms - baseline.providerP95Ms, baseline.providerP95Ms) : null;
	const clean = arm => arm.failureCount === 0 && arm.timeoutCount === 0 && arm.cancelledCount === 0 && arm.invalidCount === 0 && arm.protectedFailureCount === 0 && arm.nonSingleRequestCount === 0 && arm.successCount === arm.sampleCount;
	const correctnessPassed = sampleReady && clean(baseline) && clean(candidate);
	const checks = Object.freeze({
		prompt: promptReductionPercent == null ? null : promptReductionPercent >= 70,
		completion: completionReductionPercent == null ? null : completionReductionPercent >= 50,
		providerP50: providerP50ImprovementPercent == null ? null : providerP50ImprovementPercent >= 40,
		providerP95: providerP95ChangePercent == null ? null : providerP95ChangePercent <= 10,
		correctness: correctnessPassed,
		order: candidate.orderDetectable === true
	});
	const performancePassed = !!(sessionComplete && sampleReady && latencyReady && usageReady
		&& checks.prompt && checks.completion && checks.providerP50 && checks.providerP95 && checks.correctness);
	return Object.freeze({
		arm: candidate.arm,
		sampleReady,
		latencyReady,
		usageReady,
		promptReductionPercent,
		completionReductionPercent,
		providerP50ImprovementPercent,
		providerP95ChangePercent,
		correctnessPassed,
		orderDetectable: candidate.orderDetectable,
		checks,
		performancePassed,
		productionPassed: performancePassed && checks.order
	});
}

function createW2WireBenchmarkStore({now = Date.now, maxTrials = MAX_W2_TRIALS} = {}) {
	const boundedMaxTrials = Math.max(1, Math.min(MAX_W2_TRIALS, whole(maxTrials, MAX_W2_TRIALS, MAX_W2_TRIALS)));
	let generation = 0;
	let sequence = 0;
	let session = null;
	let trials = [];
	let seenTrialIds = new Set();
	let rejectedTrialCount = 0;

	function idleSnapshot() {
		const arms = Object.freeze(Object.fromEntries(W2_ALL_ARMS.map(arm => [arm, blankArm(arm)])));
		return Object.freeze({
			schemaVersion: W2_SCHEMA_VERSION,
			generation,
			status: "idle",
			active: false,
			sessionId: null,
			fixtureSetVersion: null,
			plannedArms: W2_ARMS,
			fixtureCount: 0,
			plannedSamplesPerArm: 0,
			plannedWarmupCount: 0,
			plannedLogicalRequests: 0,
			plannedPhysicalRequests: 0,
			estimatedPromptTokenCap: null,
			completionTokenCap: null,
			estimatedCostMicrounits: null,
			maxTrials: boundedMaxTrials,
			trialCount: 0,
			measuredTrialCount: 0,
			warmupTrialCount: 0,
			rejectedTrialCount: 0,
			cancelled: false,
			reason: null,
			startedAt: null,
			finishedAt: null,
			arms,
			comparisons: Object.freeze({"compact-order": compareArm(arms["typed-json"], arms["compact-order"], false), "compact-marker": compareArm(arms["typed-json"], arms["compact-marker"], false)}),
			gate: Object.freeze({ready: false, passed: false, reason: "not-started"}),
			resources: Object.freeze({activeSessionCount: 0, trialCount: 0, timerCount: 0, controllerCount: 0, listenerCount: 0})
		});
	}

	function beginW2Session({
		fixtureSetVersion = null,
		fixtureCount = 0,
		plannedArms = null,
		plannedSamplesPerArm = 0,
		plannedWarmupCount = 0,
		plannedLogicalRequests = null,
		plannedPhysicalRequests = null,
		estimatedPromptTokenCap = null,
		completionTokenCap = null,
		estimatedCostMicrounits = null
	} = {}) {
		if (session && session.status === "running") return null;
		const arms = normalizePlannedArms(plannedArms);
		if (!arms) return null;
		const samplesPerArm = whole(plannedSamplesPerArm, Math.floor(boundedMaxTrials / arms.length));
		const warmupCount = whole(plannedWarmupCount, boundedMaxTrials);
		const logicalDefault = samplesPerArm * arms.length + warmupCount;
		const logicalRequests = whole(plannedLogicalRequests == null ? logicalDefault : plannedLogicalRequests, boundedMaxTrials);
		const physicalRequests = whole(plannedPhysicalRequests == null ? logicalRequests : plannedPhysicalRequests, MAX_W2_PHYSICAL_REQUESTS);
		if (logicalDefault > boundedMaxTrials || logicalRequests < logicalDefault || physicalRequests !== logicalRequests) return null;
		generation++;
		trials = [];
		seenTrialIds = new Set();
		rejectedTrialCount = 0;
		session = {
			generation,
			sessionId: ++sequence,
			status: "running",
			fixtureSetVersion: shortLabel(fixtureSetVersion),
			plannedArms: arms,
			fixtureCount: whole(fixtureCount, 64),
			plannedSamplesPerArm: samplesPerArm,
			plannedWarmupCount: warmupCount,
			plannedLogicalRequests: logicalRequests,
			plannedPhysicalRequests: physicalRequests,
			estimatedPromptTokenCap: nullableWhole(estimatedPromptTokenCap, MAX_TOKEN_COUNT),
			completionTokenCap: nullableWhole(completionTokenCap, MAX_TOKEN_COUNT),
			estimatedCostMicrounits: nullableWhole(estimatedCostMicrounits, Number.MAX_SAFE_INTEGER),
			startedAt: Math.max(0, Number(now()) || 0),
			finishedAt: null,
			cancelled: false,
			reason: null
		};
		return Object.freeze({generation, sessionId: session.sessionId});
	}

	function tokenCurrent(token) {
		return !!(token && session && session.status === "running"
			&& Number(token.generation) === generation
			&& Number(token.sessionId) === session.sessionId);
	}

	function recordW2Trial(token, {
		trialId = null,
		fixtureId = null,
		orderId = null,
		position = null,
		arm = null,
		warmup = false,
		providerMs = null,
		status = "failed",
		httpStatus = null,
		errorClass = null,
		valid = false,
		protectedIntegrity = "unknown",
		orderDetectable = null,
		requestCount = 1,
		wireBytes = null,
		usage = null,
		reason = null,
		segmentDiagnostics = null,
		structureDiagnostics = null
	} = {}) {
		if (!tokenCurrent(token)) return null;
		const normalizedArm = String(arm || "");
		if (!W2_ARM_SET.has(normalizedArm)) {rejectedTrialCount++; return false;}
		const normalizedTrialId = Number(trialId);
		if (!Number.isInteger(normalizedTrialId) || normalizedTrialId < 0 || normalizedTrialId >= boundedMaxTrials || seenTrialIds.has(normalizedTrialId) || trials.length >= boundedMaxTrials) {
			rejectedTrialCount++;
			return false;
		}
		const normalizedStatus = ALLOWED_STATUSES.has(String(status)) ? String(status) : "failed";
		const normalizedUsage = normalizeUsage(usage);
		const normalizedReason = reason == null || reason === "" ? null : ALLOWED_REASONS.has(String(reason)) ? String(reason) : "unknown";
		const record = Object.freeze({
			trialId: normalizedTrialId,
			fixtureId: shortLabel(fixtureId),
			orderId: warmup === true ? null : whole(orderId, MAX_W2_TRIALS - 1),
			position: warmup === true ? null : whole(position, 2),
			arm: normalizedArm,
			warmup: warmup === true,
			providerMs: nullableWhole(providerMs, MAX_DURATION_MS),
			status: normalizedStatus,
			httpStatus: nullableWhole(httpStatus, 599),
			errorClass: errorClass == null || errorClass === "" ? null : ALLOWED_ERROR_CLASSES.has(String(errorClass)) ? String(errorClass) : "unknown",
			valid: valid === true,
			protectedIntegrity: ["pass", "fail", "unknown"].includes(String(protectedIntegrity)) ? String(protectedIntegrity) : "unknown",
			orderDetectable: normalizedArm === "compact-order" ? false : orderDetectable !== false,
			requestCount: Math.max(1, whole(requestCount, 3, 1)),
			wireBytes: nullableWhole(wireBytes, MAX_BYTES),
			promptTokens: normalizedUsage.promptTokens,
			completionTokens: normalizedUsage.completionTokens,
			reasoningTokens: normalizedUsage.reasoningTokens,
			reason: normalizedReason,
			segmentDiagnostics: sanitizeSegmentDiagnostics(segmentDiagnostics),
			structureDiagnostics: sanitizeStructureDiagnostics(structureDiagnostics)
		});
		seenTrialIds.add(normalizedTrialId);
		trials.push(record);
		return record;
	}

	function finishW2Session(token) {
		if (!tokenCurrent(token)) return null;
		session.status = "complete";
		session.finishedAt = Math.max(session.startedAt, Number(now()) || session.startedAt);
		return getW2Snapshot();
	}

	function cancel(token) {
		if (!tokenCurrent(token)) return null;
		session.status = "cancelled";
		session.cancelled = true;
		session.reason = "cancelled";
		session.finishedAt = Math.max(session.startedAt, Number(now()) || session.startedAt);
		generation++;
		return getW2Snapshot();
	}

	function fail(token, reason = "unknown") {
		if (!tokenCurrent(token)) return null;
		session.status = "failed";
		session.reason = ALLOWED_REASONS.has(String(reason)) ? String(reason) : "unknown";
		session.finishedAt = Math.max(session.startedAt, Number(now()) || session.startedAt);
		return getW2Snapshot();
	}

	function reset() {
		generation++;
		session = null;
		trials = [];
		seenTrialIds.clear();
		rejectedTrialCount = 0;
		return getW2Snapshot();
	}

	function getW2Snapshot() {
		if (!session) return idleSnapshot();
		const arms = Object.freeze(Object.fromEntries(W2_ALL_ARMS.map(arm => [arm, aggregateArm(arm, trials)])));
		const planComplete = session.plannedArms.every(arm => arms[arm].sampleCount === session.plannedSamplesPerArm)
			&& W2_ALL_ARMS.every(arm => session.plannedArms.includes(arm) || arms[arm].sampleCount === 0)
			&& trials.filter(trial => trial.warmup).length === session.plannedWarmupCount
			&& trials.length === session.plannedLogicalRequests;
		const sessionComplete = session.status === "complete" && !session.cancelled && planComplete;
		const comparisons = Object.freeze({
			"compact-order": compareArm(arms["typed-json"], arms["compact-order"], sessionComplete),
			"compact-marker": compareArm(arms["typed-json"], arms["compact-marker"], sessionComplete)
		});
		const ready = sessionComplete && Object.values(comparisons).every(comparison => comparison.sampleReady && comparison.latencyReady && comparison.usageReady);
		const passed = ready && Object.values(comparisons).some(comparison => comparison.productionPassed);
		const gateReason = session.status === "running" ? "running"
			: session.cancelled ? "cancelled"
				: session.status === "failed" ? session.reason || "failed"
				: !ready ? "not-ready"
					: passed ? "passed" : "candidate-failed";
		return Object.freeze({
			schemaVersion: W2_SCHEMA_VERSION,
			generation,
			status: session.status,
			active: session.status === "running",
			sessionId: session.sessionId,
			fixtureSetVersion: session.fixtureSetVersion,
			plannedArms: session.plannedArms,
			fixtureCount: session.fixtureCount,
			plannedSamplesPerArm: session.plannedSamplesPerArm,
			plannedWarmupCount: session.plannedWarmupCount,
			plannedLogicalRequests: session.plannedLogicalRequests,
			plannedPhysicalRequests: session.plannedPhysicalRequests,
			estimatedPromptTokenCap: session.estimatedPromptTokenCap,
			completionTokenCap: session.completionTokenCap,
			estimatedCostMicrounits: session.estimatedCostMicrounits,
			maxTrials: boundedMaxTrials,
			trialCount: trials.length,
			measuredTrialCount: trials.filter(trial => !trial.warmup).length,
			warmupTrialCount: trials.filter(trial => trial.warmup).length,
			planComplete,
			rejectedTrialCount,
			cancelled: session.cancelled,
			reason: session.reason,
			startedAt: session.startedAt,
			finishedAt: session.finishedAt,
			arms,
			comparisons,
			trials: Object.freeze(trials.slice()),
			gate: Object.freeze({ready, passed, reason: gateReason}),
			resources: Object.freeze({activeSessionCount: session.status === "running" ? 1 : 0, trialCount: trials.length, timerCount: 0, controllerCount: 0, listenerCount: 0})
		});
	}

	return Object.freeze({beginW2Session, recordW2Trial, finishW2Session, cancel, fail, reset, getW2Snapshot});
}

module.exports = {
	W2_SCHEMA_VERSION,
	W2_ARMS,
	W2_ALL_ARMS,
	W2_SEGMENT_REASONS,
	MAX_W2_TRIALS,
	MAX_SEGMENT_DIAGNOSTICS,
	nearestRank,
	sanitizeSegmentDiagnostics,
	sanitizeStructureDiagnostics,
	createW2WireBenchmarkStore
};
