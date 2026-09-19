/**
 * @name DiscordAITranslator F1H0 Field Exporter
 * @author DiscordAITranslator
 * @version 0.1.1
 * @description Real-workload read-only exporter for loaded-history batch measurements.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const runtimeProcess = require("process");

const PLUGIN_NAME = "DiscordAITranslator";
const DEFAULT_OUTPUT_PATH = path.join(runtimeProcess.env.TEMP || runtimeProcess.env.TMP || ".", "DiscordAITranslator-f1h0-field-sample.json");
const TARGET_VALID_RUNS = 4;
const LOW_PROVIDER_DECISION_RUNS = 8;
const MIN_PRIMARY_CHUNKS = 16;
const MAX_OBSERVED_RUNS = 20;
const MAX_VALID_RUNS = 20;
const MAX_INVALID_RUNS = 20;
const RUN_STATUSES = new Set(["committed", "cancelled", "failed", "unknown"]);
const FAILURE_KINDS = new Set(["auth", "configuration", "permanent", "transient", "malformed", "thrown", "unknown"]);
const RUN_NUMBER_FIELDS = [
	"generation", "collectedMessageCount", "concurrency", "chunkSize", "requestedChunks", "settledChunks",
	"providerMessageCount", "providerInputChars", "settledMessageCount", "maxActiveChunks", "globalMaxActiveChunks", "activeChunksAtFinish",
	"liveOverlapDispatches", "liveTurnsDuringRun", "liveOverlapDuringChunks", "duplicateChunkEventCount", "orphanChunkSettleCount", "failureCount", "repairBatchRequests", "repairBatchMessages", "repairItemRequests",
	"atomicCommitCount", "commitResultCount", "confirmedCount", "deferredCount", "rejectedCount", "staleCount",
	"commitErrorCount", "translatedCount", "skippedCount", "failedCount", "totalMs", "waitBeforeJobStartMs", "sealToFirstDispatchMs",
	"primarySpanMs", "sealToAtomicCommitMs", "sequentialChunkMs", "projectedConcurrency2ChunkMs",
	"projectedConcurrency2TotalMs", "projectedConcurrency2ImprovementPercent"
];
const CHUNK_NUMBER_FIELDS = ["index", "messageCount", "inputChars", "dispatchOffsetMs", "durationMs", "statusCode", "liveActiveAtDispatch"];
const SNAPSHOT_NUMBER_FIELDS = [
	"generation", "startedRunCount", "completedRunCount", "cancelledRunCount", "failedRunCount", "primaryChunkRequestCount",
	"primaryChunkMessageCount", "primaryInputChars", "repairBatchRequestCount", "repairBatchMessageCount", "repairItemRequestCount",
	"atomicCommitCount", "liveTurnDuringRunCount", "liveOverlapDuringChunkCount", "maxActiveChunkCount", "activeRunCount", "activeChunkCount", "recentRunCount"
];
const LATENCY_NUMBER_FIELDS = ["attemptTotalCount", "batchRequestCount", "batchMessageCount", "failoverCount", "timeoutCount", "rateLimitCount", "historicalAttemptCount", "historicalBatchRequestCount", "historicalBatchMessageCount", "historicalFailoverCount", "historicalTimeoutCount", "historicalRateLimitCount"];
const DISPLAY_NUMBER_FIELDS = ["fullRepaints", "scheduled", "flushes", "renderBatches", "confirmed", "deferred", "retries", "exhausted"];
const DISPLAY_RESOURCE_NUMBER_FIELDS = ["queuedChannels", "queuedMessages", "activeChannels", "activeMessages"];
const DISPLAY_RESOURCE_BOOLEAN_FIELDS = ["coalesceTimerArmed", "fullRepaintTimerArmed", "settingsRetryTimerArmed", "textAreaRetryTimerArmed", "deferredFullRepaintPending"];
const CONTROLLER_NUMBER_FIELDS = ["deferredFlushErrorCount"];
const CONTROLLER_RESOURCE_NUMBER_FIELDS = ["pendingChannelCount", "pendingMessageCount", "pendingHostMessageCount", "pendingHostViewCount", "activeDeferredFlushCount", "activeDeferredMessageCount", "activeDeferredHostMessageCount", "activeDeferredHostViewCount"];
const CONTROLLER_RESOURCE_BOOLEAN_FIELDS = ["deferredFlushTimerArmed"];

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickNumbers(source, fields) {
	const output = {};
	for (const field of fields) output[field] = finiteNumber(source && source[field]);
	return output;
}

function pickBooleans(source, fields) {
	const output = {};
	for (const field of fields) output[field] = typeof (source && source[field]) === "boolean" ? source[field] : null;
	return output;
}

function subtractNumbers(current, baseline, fields) {
	const output = {};
	for (const field of fields) {
		const currentValue = finiteNumber(current && current[field]);
		const baselineValue = finiteNumber(baseline && baseline[field]);
		output[field] = currentValue == null || baselineValue == null ? null : Math.max(0, currentValue - baselineValue);
	}
	return output;
}

function sanitizeResources(source, numberFields, booleanFields) {
	return Object.assign(pickNumbers(source, numberFields), pickBooleans(source, booleanFields));
}

function resourcesAreIdle(resources, numberFields, booleanFields) {
	return numberFields.every(field => resources && resources[field] === 0) && booleanFields.every(field => resources && resources[field] === false);
}

function sanitizeChunk(sample) {
	const failureKind = typeof (sample && sample.failureKind) === "string" && FAILURE_KINDS.has(sample.failureKind) ? sample.failureKind : sample && sample.failureKind ? "unknown" : null;
	return Object.assign(pickNumbers(sample, CHUNK_NUMBER_FIELDS), {
		failureKind
	});
}

function sanitizeRun(run) {
	const status = typeof (run && run.status) === "string" && RUN_STATUSES.has(run.status) ? run.status : "unknown";
	const output = pickNumbers(run, RUN_NUMBER_FIELDS);
	output.nonProviderMessageCount = output.collectedMessageCount == null || output.providerMessageCount == null ? null : Math.max(0, output.collectedMessageCount - output.providerMessageCount);
	return Object.assign(output, {
		status,
		chunkSamples: Array.isArray(run && run.chunkSamples) ? run.chunkSamples.map(sanitizeChunk) : []
	});
}

function getInvalidReasons(run) {
	const reasons = [];
	const chunks = Array.isArray(run && run.chunkSamples) ? run.chunkSamples.slice().sort((left, right) => left.index - right.index) : [];
	const expectedChunks = run && run.providerMessageCount > 0 ? Math.ceil(run.providerMessageCount / 10) : 0;
	const chunksHaveExpectedShape = !!run && run.chunkSize === 10 && run.requestedChunks === expectedChunks && chunks.length === run.requestedChunks && chunks.every((chunk, index) => {
		const expectedSize = index === chunks.length - 1 ? run.providerMessageCount - 10 * index : 10;
		return chunk.index === index && chunk.messageCount === expectedSize && chunk.inputChars > 0 && chunk.failureKind == null;
	}) && chunks.reduce((total, chunk) => total + chunk.messageCount, 0) === run.providerMessageCount && chunks.reduce((total, chunk) => total + chunk.inputChars, 0) === run.providerInputChars && chunks.reduce((total, chunk) => total + chunk.durationMs, 0) === run.sequentialChunkMs;
	const terminalCount = run ? run.translatedCount + run.skippedCount + run.failedCount : 0;
	if (!run || run.status !== "committed") reasons.push("not_committed");
	const providerActiveShape = !!run && (run.providerMessageCount > 0 ? run.maxActiveChunks === 1 && run.globalMaxActiveChunks === 1 : run.maxActiveChunks === 0 && run.globalMaxActiveChunks === 0);
	if (!run || run.concurrency !== 1 || !providerActiveShape) reasons.push("not_cap1");
	if (!run || run.providerMessageCount < 0 || run.providerMessageCount > run.collectedMessageCount) reasons.push("invalid_provider_count");
	if (!run || run.providerMessageCount > 0 && run.providerInputChars <= 0) reasons.push("missing_input_size");
	if (!run || run.requestedChunks !== run.settledChunks || run.providerMessageCount !== run.settledMessageCount || run.activeChunksAtFinish !== 0 || run.duplicateChunkEventCount || run.orphanChunkSettleCount || !chunksHaveExpectedShape) reasons.push("incomplete_resources");
	if (!run || run.failureCount || run.repairBatchRequests || run.repairItemRequests || run.failedCount) reasons.push("failure_or_repair");
	if (!run || terminalCount !== run.collectedMessageCount || run.commitResultCount !== terminalCount || run.confirmedCount + run.deferredCount !== run.commitResultCount || run.atomicCommitCount !== 1 || run.commitErrorCount || run.rejectedCount || run.staleCount) reasons.push("commit_not_clean");
	if (!run || run.liveOverlapDispatches || run.liveTurnsDuringRun || run.liveOverlapDuringChunks) reasons.push("live_overlap");
	return reasons;
}

function nearestRank(values, percentile) {
	const sorted = values.filter(value => typeof value === "number" && Number.isFinite(value)).slice().sort((left, right) => left - right);
	if (!sorted.length) return null;
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))];
}

function summarizeRuns(runs) {
	const providerShares = runs.map(run => run.totalMs > 0 && run.sequentialChunkMs != null ? run.sequentialChunkMs / run.totalMs * 100 : null);
	return {
		validRunCount: runs.length,
		totalPrimaryChunks: runs.reduce((total, run) => total + (run.requestedChunks || 0), 0),
		totalProviderMessages: runs.reduce((total, run) => total + (run.providerMessageCount || 0), 0),
		totalNonProviderMessages: runs.reduce((total, run) => total + (run.nonProviderMessageCount || 0), 0),
		nonProviderAffectedRunCount: runs.filter(run => run.nonProviderMessageCount > 0).length,
		totalP50Ms: nearestRank(runs.map(run => run.totalMs), 0.50),
		totalP95Ms: nearestRank(runs.map(run => run.totalMs), 0.95),
		providerShareP50Percent: nearestRank(providerShares, 0.50),
		projectedConcurrency2ImprovementP50Percent: nearestRank(runs.map(run => run.projectedConcurrency2ImprovementPercent), 0.50),
		inputCharsMin: runs.length ? Math.min(...runs.map(run => run.providerInputChars)) : null,
		inputCharsMax: runs.length ? Math.max(...runs.map(run => run.providerInputChars)) : null
	};
}

function isActiveInstance(candidate) {
	return !!candidate && typeof candidate === "object" && typeof candidate.getHistoricalBatchPerformanceSnapshot === "function";
}

function unwrapActiveInstance(value) {
	if (value && typeof value === "object" && isActiveInstance(value.instance)) return value.instance;
	return isActiveInstance(value) ? value : null;
}

function resolveActiveInstance(globals = globalThis) {
	// BdApi owns the currently loaded plugin record. Prefer it over BDFDB's legacy
	// registry so a hot reload cannot leave the exporter polling a stale instance.
	try {
		const plugins = globals && globals.BdApi && globals.BdApi.Plugins;
		if (plugins && typeof plugins.get === "function") {
			const current = unwrapActiveInstance(plugins.get(PLUGIN_NAME));
			if (current) return current;
		}
	} catch (_) {}
	try {
		const bdfdb = globals && globals.BDFDB;
		if (bdfdb && bdfdb.BDUtils && typeof bdfdb.BDUtils.getPlugin === "function") return unwrapActiveInstance(bdfdb.BDUtils.getPlugin(PLUGIN_NAME));
	} catch (_) {}
	return null;
}

class HistoricalBatchFieldExporter {
	constructor(options = {}) {
		this.globals = options.globals || globalThis;
		this.outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
		this.setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
		this.clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
		this.pollDelayMs = Math.max(1, Number(options.pollDelayMs) || 1000);
		this.maxPolls = Math.max(1, Number(options.maxPolls) || 1800);
		this.targetValidRuns = Math.max(1, Number(options.targetValidRuns) || TARGET_VALID_RUNS);
		this.fs = options.fileSystem || fs;
		this.timer = null;
		this.polls = 0;
		this.finished = false;
		this.instance = null;
		this.generation = null;
		this.lastCompletedRunCount = 0;
		this.validRuns = [];
		this.invalidRuns = [];
		this.missedRunCount = 0;
		this.excessHistoryRuns = false;
		this.observedRunCount = 0;
		this.baseline = null;
		this.latest = null;
		this.idleStablePolls = 0;
	}

	toast(message, type = "info") {
		try {
			if (this.globals && typeof this.globals.showToast === "function") this.globals.showToast(message, type);
			else if (this.globals && this.globals.BdApi && typeof this.globals.BdApi.showToast === "function") this.globals.BdApi.showToast(message, {type});
		} catch (_) {}
	}

	readSnapshot() {
		const history = this.instance.getHistoricalBatchPerformanceSnapshot() || {};
		let latency = {};
		let display = {};
		let controller = {};
		try {latency = this.instance.ensureProviderClient().getLatencySnapshot() || {};} catch (_) {}
		try {display = this.instance.ensureReceivedDisplayRepaintScheduler().getDiagnostics() || {};} catch (_) {}
		try {controller = this.instance.ensureReceivedDisplayRuntime().getControllerDiagnostics() || {};} catch (_) {}
		return {history, latency, display, controller};
	}

	createRecord(ok, state, reason = null) {
		const latest = this.latest || {history: {}, latency: {}, display: {}, controller: {}};
		const baseline = this.baseline || {history: {}, latency: {}, display: {}, controller: {}};
		const summary = summarizeRuns(this.validRuns);
		const evidenceClass = this.getEvidenceClass();
		const cap2GatePassed = evidenceClass === "provider_evidence_ready" && summary.providerShareP50Percent >= 60 && summary.projectedConcurrency2ImprovementP50Percent >= 20;
		const decision = evidenceClass === "low_provider_demand" ? "keep_cap1_low_provider_demand"
			: evidenceClass === "provider_evidence_ready" ? cap2GatePassed ? "eligible_for_f1h1_review" : "keep_cap1_insufficient_projected_benefit"
			: "collecting";
		return {
			ok: !!ok,
			state,
			reason,
			targetValidRuns: this.targetValidRuns,
			validRuns: this.validRuns.slice(),
			invalidRuns: this.invalidRuns.slice(),
			missedRunCount: this.missedRunCount,
			excessHistoryRuns: this.excessHistoryRuns,
			observedRunCount: this.observedRunCount,
			evidenceClass,
			cap2GatePassed,
			decision,
			idleStablePolls: this.idleStablePolls,
			summary,
			history: pickNumbers(latest.history, SNAPSHOT_NUMBER_FIELDS),
			latencyBaseline: pickNumbers(baseline.latency, LATENCY_NUMBER_FIELDS),
			latency: pickNumbers(latest.latency, LATENCY_NUMBER_FIELDS),
			latencyDelta: subtractNumbers(latest.latency, baseline.latency, LATENCY_NUMBER_FIELDS),
			displayBaseline: pickNumbers(baseline.display, DISPLAY_NUMBER_FIELDS),
			display: pickNumbers(latest.display, DISPLAY_NUMBER_FIELDS),
			displayDelta: subtractNumbers(latest.display, baseline.display, DISPLAY_NUMBER_FIELDS),
			displayResources: sanitizeResources(latest.display && latest.display.resources, DISPLAY_RESOURCE_NUMBER_FIELDS, DISPLAY_RESOURCE_BOOLEAN_FIELDS),
			controllerResources: sanitizeResources(latest.controller && latest.controller.resources, CONTROLLER_RESOURCE_NUMBER_FIELDS, CONTROLLER_RESOURCE_BOOLEAN_FIELDS),
			controllerBaseline: pickNumbers(baseline.controller, CONTROLLER_NUMBER_FIELDS),
			controller: pickNumbers(latest.controller, CONTROLLER_NUMBER_FIELDS),
			controllerDelta: subtractNumbers(latest.controller, baseline.controller, CONTROLLER_NUMBER_FIELDS)
		};
	}

	resourcesAreIdle(snapshot) {
		const displayResources = sanitizeResources(snapshot && snapshot.display && snapshot.display.resources, DISPLAY_RESOURCE_NUMBER_FIELDS, DISPLAY_RESOURCE_BOOLEAN_FIELDS);
		const controllerResources = sanitizeResources(snapshot && snapshot.controller && snapshot.controller.resources, CONTROLLER_RESOURCE_NUMBER_FIELDS, CONTROLLER_RESOURCE_BOOLEAN_FIELDS);
		return (Number(snapshot && snapshot.history && snapshot.history.activeRunCount) || 0) === 0 &&
			(Number(snapshot && snapshot.history && snapshot.history.activeChunkCount) || 0) === 0 &&
			resourcesAreIdle(displayResources, DISPLAY_RESOURCE_NUMBER_FIELDS, DISPLAY_RESOURCE_BOOLEAN_FIELDS) &&
			resourcesAreIdle(controllerResources, CONTROLLER_RESOURCE_NUMBER_FIELDS, CONTROLLER_RESOURCE_BOOLEAN_FIELDS);
	}

	getEvidenceClass() {
		const primaryChunks = this.validRuns.reduce((total, run) => total + (run.requestedChunks || 0), 0);
		if (this.validRuns.length >= this.targetValidRuns && primaryChunks >= MIN_PRIMARY_CHUNKS) return "provider_evidence_ready";
		if (this.validRuns.length >= LOW_PROVIDER_DECISION_RUNS && primaryChunks < MIN_PRIMARY_CHUNKS) return "low_provider_demand";
		return null;
	}

	sessionEvidenceIsClean(snapshot) {
		if (!this.getEvidenceClass() || this.missedRunCount) return false;
		const displayDelta = subtractNumbers(snapshot.display, this.baseline && this.baseline.display, DISPLAY_NUMBER_FIELDS);
		const controllerDelta = subtractNumbers(snapshot.controller, this.baseline && this.baseline.controller, CONTROLLER_NUMBER_FIELDS);
		return displayDelta.fullRepaints === 0 && displayDelta.exhausted === 0 && controllerDelta.deferredFlushErrorCount === 0;
	}

	writeAtomically(record) {
		const temporaryPath = `${this.outputPath}.${runtimeProcess.pid}.${Date.now()}.tmp`;
		try {
			this.fs.mkdirSync(path.dirname(this.outputPath), {recursive: true});
			this.fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
			this.fs.renameSync(temporaryPath, this.outputPath);
		} catch (error) {
			try {this.fs.unlinkSync(temporaryPath);} catch (_) {}
			throw error;
		}
	}

	persist(state, ok = false, reason = null) {
		this.writeAtomically(this.createRecord(ok, state, reason));
	}

	persistOrStop(state, ok = false, reason = null) {
		try {this.persist(state, ok, reason); return true;}
		catch (_) {
			if (this.timer !== null) this.clearTimeout(this.timer);
			this.timer = null;
			this.finished = true;
			this.toast("DiscordAITranslator 历史样本写入失败", "error");
			return false;
		}
	}

	consumeCompletedRuns(snapshot) {
		const history = snapshot.history || {};
		const currentGeneration = finiteNumber(history.generation);
		const currentCompleted = finiteNumber(history.completedRunCount) || 0;
		if (this.generation !== currentGeneration || currentCompleted < this.lastCompletedRunCount) {
			this.generation = currentGeneration;
			this.lastCompletedRunCount = currentCompleted;
			this.validRuns = [];
			this.invalidRuns = [];
			this.missedRunCount = 0;
			this.excessHistoryRuns = false;
			this.observedRunCount = 0;
			this.idleStablePolls = 0;
			this.polls = 0;
			return -1;
		}
		const delta = Math.max(0, currentCompleted - this.lastCompletedRunCount);
		if (!delta) return 0;
		const recentRuns = Array.isArray(history.recentRuns) ? history.recentRuns : [];
		const available = Math.min(delta, recentRuns.length);
		this.missedRunCount += Math.max(0, delta - available);
		this.observedRunCount += available;
		for (const rawRun of recentRuns.slice(recentRuns.length - available)) {
			const run = sanitizeRun(rawRun);
			const reasons = getInvalidReasons(run);
			if (!reasons.length) {
				if (this.validRuns.length < MAX_VALID_RUNS) this.validRuns.push(run);
				else this.excessHistoryRuns = true;
			}
			else {
				this.invalidRuns.push({reasons, run});
				if (this.invalidRuns.length > MAX_INVALID_RUNS) this.invalidRuns.shift();
			}
		}
		this.lastCompletedRunCount = currentCompleted;
		return available;
	}

	poll() {
		if (this.finished) return;
		const currentInstance = resolveActiveInstance(this.globals);
		if (!currentInstance) {
			this.finish(false, "active_instance_not_found");
			return;
		}
		if (currentInstance !== this.instance) {
			this.instance = currentInstance;
			try {this.baseline = this.latest = this.readSnapshot();}
			catch (_) {
				this.finish(false, "snapshot_read_failed");
				return;
			}
			this.generation = finiteNumber(this.baseline.history && this.baseline.history.generation);
			this.lastCompletedRunCount = finiteNumber(this.baseline.history && this.baseline.history.completedRunCount) || 0;
			this.validRuns = [];
			this.invalidRuns = [];
			this.missedRunCount = 0;
			this.excessHistoryRuns = false;
			this.observedRunCount = 0;
			this.idleStablePolls = 0;
			this.polls = 0;
			if (!this.persistOrStop("waiting")) return;
			this.toast(`DiscordAITranslator 历史样本已随插件重载重置 0/${this.targetValidRuns}`, "info");
		}
		try {this.latest = this.readSnapshot();}
		catch (_) {
			this.finish(false, "snapshot_read_failed");
			return;
		}
		const consumed = this.consumeCompletedRuns(this.latest);
		if (consumed < 0) {
			this.baseline = this.latest;
			if (!this.persistOrStop("waiting")) return;
			this.toast(`DiscordAITranslator 历史样本已随代际重置 0/${this.targetValidRuns}`, "info");
		}
		else if (consumed) {
			if (!this.persistOrStop("collecting")) return;
			const chunks = this.validRuns.reduce((total, run) => total + (run.requestedChunks || 0), 0);
			this.toast(`DiscordAITranslator 历史样本 ${this.validRuns.length}/${this.targetValidRuns} · AI 分块 ${chunks}/${MIN_PRIMARY_CHUNKS}`, "info");
		}
		if (this.missedRunCount) {
			this.finish(false, "missed_history_runs");
			return;
		}
		if (this.excessHistoryRuns) {
			this.finish(false, "excess_history_runs");
			return;
		}
		if (this.observedRunCount >= MAX_OBSERVED_RUNS && !this.getEvidenceClass()) {
			this.finish(false, "observation_limit_reached");
			return;
		}
		if (this.sessionEvidenceIsClean(this.latest) && this.resourcesAreIdle(this.latest)) this.idleStablePolls++;
		else this.idleStablePolls = 0;
		if (this.idleStablePolls >= 2) {
			this.finish(true, null);
			return;
		}
		this.polls++;
		if (this.polls >= this.maxPolls) {
			this.finish(false, "insufficient_clean_history_runs");
			return;
		}
		this.timer = this.setTimeout(() => {
			this.timer = null;
			this.poll();
		}, this.pollDelayMs);
	}

	finish(ok, reason) {
		if (this.finished) return;
		if (this.timer !== null) this.clearTimeout(this.timer);
		this.timer = null;
		if (!this.persistOrStop(ok ? "complete" : "failed", ok, reason)) return;
		this.finished = true;
		this.toast(ok ? "DiscordAITranslator 历史样本已完成" : "DiscordAITranslator 历史样本未完成", ok ? "success" : "error");
	}

	start() {
		if (this.finished || this.instance) return;
		this.instance = resolveActiveInstance(this.globals);
		if (!this.instance) {
			this.latest = {history: {}, latency: {}, display: {}, controller: {}};
			this.finish(false, "active_instance_not_found");
			return;
		}
		try {this.baseline = this.latest = this.readSnapshot();}
		catch (_) {
			this.finish(false, "snapshot_read_failed");
			return;
		}
		this.generation = finiteNumber(this.baseline.history && this.baseline.history.generation);
		this.lastCompletedRunCount = finiteNumber(this.baseline.history && this.baseline.history.completedRunCount) || 0;
		if (!this.persistOrStop("waiting")) return;
		this.toast(`DiscordAITranslator 历史样本 0/${this.targetValidRuns}`, "info");
		this.timer = this.setTimeout(() => {
			this.timer = null;
			this.poll();
		}, this.pollDelayMs);
	}

	stop() {
		if (this.timer !== null) this.clearTimeout(this.timer);
		this.timer = null;
		if (!this.finished && this.latest) {
			try {this.persist("stopped", false, "exporter_stopped");} catch (_) {}
		}
		this.finished = true;
	}
}

module.exports = HistoricalBatchFieldExporter;
module.exports.HistoricalBatchFieldExporter = HistoricalBatchFieldExporter;
module.exports.resolveActiveInstance = resolveActiveInstance;
module.exports.sanitizeRun = sanitizeRun;
module.exports.getInvalidReasons = getInvalidReasons;
module.exports.summarizeRuns = summarizeRuns;
module.exports.DEFAULT_OUTPUT_PATH = DEFAULT_OUTPUT_PATH;
module.exports.TARGET_VALID_RUNS = TARGET_VALID_RUNS;
