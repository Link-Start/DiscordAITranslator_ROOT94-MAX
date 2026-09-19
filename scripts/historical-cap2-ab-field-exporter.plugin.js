/**
 * @name DiscordAITranslator F1H1 AB Exporter
 * @author DiscordAITranslator
 * @version 0.1.4
 * @description Read-only ABBA field recorder for historical chunk concurrency 1 versus 2.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const runtimeProcess = require("process");

const PLUGIN_NAME = "DiscordAITranslator";
const OUTPUT_PATH = path.join(runtimeProcess.env.TEMP || runtimeProcess.env.TMP || ".", "DiscordAITranslator-f1h1-ab-sample.json");
const ARM_PATTERN = Object.freeze([1, 2, 2, 1]);
const MIN_RUNS_PER_ARM = 4;
const MIN_CHUNKS_PER_ARM = 16;
const MAX_VALID_RUNS = 20;
const MAX_INVALID_RUNS = 20;
const MAX_NEUTRAL_RUNS = 20;
const MIN_WORKLOAD_BALANCE_RATIO = 0.90;

const RUN_FIELDS = ["concurrency", "chunkSize", "collectedMessageCount", "providerMessageCount", "providerInputChars", "requestedChunks", "settledChunks", "settledMessageCount", "maxActiveChunks", "globalMaxActiveChunks", "activeChunksAtFinish", "duplicateChunkEventCount", "orphanChunkSettleCount", "failureCount", "rateLimitCount", "repairBatchRequests", "repairBatchMessages", "repairItemRequests", "atomicCommitCount", "commitResultCount", "committedCount", "confirmedCount", "deferredCount", "rejectedCount", "missingCount", "retryCount", "staleCount", "commitErrorCount", "translatedCount", "skippedCount", "failedCount", "liveOverlapDispatches", "liveTurnsDuringRun", "liveOverlapDuringChunks", "totalMs"];
const DISPLAY_FIELDS = ["fullRepaints", "exhausted"];
const CONTROLLER_FIELDS = ["deferredFlushErrorCount"];
const DISPLAY_RESOURCE_NUMBERS = ["queuedChannels", "queuedMessages", "activeChannels", "activeMessages"];
const DISPLAY_RESOURCE_FLAGS = ["coalesceTimerArmed", "fullRepaintTimerArmed", "settingsRetryTimerArmed", "textAreaRetryTimerArmed", "deferredFullRepaintPending"];
const CONTROLLER_RESOURCE_NUMBERS = ["pendingChannelCount", "pendingMessageCount", "pendingHostMessageCount", "pendingHostViewCount", "activeDeferredFlushCount", "activeDeferredMessageCount", "activeDeferredHostMessageCount", "activeDeferredHostViewCount"];
const CONTROLLER_RESOURCE_FLAGS = ["deferredFlushTimerArmed"];

function number(value) {return typeof value == "number" && Number.isFinite(value) ? value : null;}
function pick(source, fields) {return Object.fromEntries(fields.map(field => [field, number(source && source[field])]));}
function delta(current, baseline, fields) {return Object.fromEntries(fields.map(field => {const a = number(current && current[field]), b = number(baseline && baseline[field]); return [field, a == null || b == null ? null : Math.max(0, a - b)];}));}
function nearestRank(values, percentile) {const sorted = values.filter(value => number(value) != null).slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1))] : null;}
function balanceRatio(left, right) {
	if (!(left > 0) || !(right > 0)) return null;
	return Math.min(left, right) / Math.max(left, right);
}

function sanitizeRun(run) {
	const output = pick(run, RUN_FIELDS);
	const chunks = Array.isArray(run && run.chunkSamples) ? run.chunkSamples : [];
	output.rateLimitCount = chunks.filter(chunk => number(chunk && chunk.statusCode) === 429).length;
	output.status = ["committed", "cancelled", "failed", "unknown"].includes(run && run.status) ? run.status : "unknown";
	return output;
}

function invalidReasons(run, arm) {
	const reasons = [];
	if (!run || RUN_FIELDS.some(field => number(run[field]) == null)) reasons.push("missing_metrics");
	if (!run || run.status !== "committed") reasons.push("not_committed");
	if (!run || run.concurrency !== arm) reasons.push("arm_mismatch");
	if (!run || run.chunkSize !== 10 || run.providerMessageCount <= 0 || run.providerMessageCount > run.collectedMessageCount || run.providerInputChars <= 0 || run.requestedChunks !== Math.ceil(run.providerMessageCount / 10) || run.requestedChunks !== run.settledChunks || run.providerMessageCount !== run.settledMessageCount) reasons.push("request_shape");
	if (!run || arm === 1 && run.maxActiveChunks !== 1 || arm === 2 && (run.maxActiveChunks < 1 || run.maxActiveChunks > 2 || run.requestedChunks >= 3 && run.maxActiveChunks !== 2) || run.globalMaxActiveChunks > 2 || run.activeChunksAtFinish !== 0 || run.duplicateChunkEventCount || run.orphanChunkSettleCount) reasons.push("concurrency_shape");
	if (!run || run.failureCount || run.rateLimitCount || run.repairBatchRequests || run.repairBatchMessages || run.repairItemRequests || run.failedCount) reasons.push("failure_or_repair");
	const terminalCount = run ? run.translatedCount + run.skippedCount + run.failedCount : 0;
	const displayGap = run ? run.commitResultCount - run.confirmedCount - run.deferredCount : -1;
	if (!run || terminalCount !== run.collectedMessageCount || run.commitResultCount !== terminalCount || run.committedCount !== run.commitResultCount || displayGap < 0 || run.missingCount !== displayGap || run.retryCount > run.missingCount || run.atomicCommitCount !== 1 || run.commitErrorCount || run.rejectedCount || run.staleCount) reasons.push("commit_not_clean");
	if (!run || run.liveOverlapDispatches || run.liveTurnsDuringRun || run.liveOverlapDuringChunks) reasons.push("live_overlap");
	return reasons;
}

function isNeutralNonProviderRun(run, arm) {
	if (!run || run.status !== "committed" || run.concurrency !== arm || run.chunkSize !== 10) return false;
	if (run.providerMessageCount !== 0 || run.providerInputChars !== 0 || run.requestedChunks !== 0 || run.settledChunks !== 0 || run.settledMessageCount !== 0 || run.maxActiveChunks !== 0 || run.globalMaxActiveChunks !== 0 || run.activeChunksAtFinish !== 0) return false;
	if (run.failureCount || run.rateLimitCount || run.repairBatchRequests || run.repairBatchMessages || run.repairItemRequests || run.failedCount || run.liveOverlapDispatches || run.liveTurnsDuringRun || run.liveOverlapDuringChunks || run.staleCount || run.commitErrorCount || run.duplicateChunkEventCount || run.orphanChunkSettleCount) return false;
	return run.translatedCount + run.skippedCount === run.collectedMessageCount && run.atomicCommitCount === 1;
}

function resolveInstance(globals = globalThis) {
	try {
		const value = globals && globals.BdApi && globals.BdApi.Plugins && globals.BdApi.Plugins.get(PLUGIN_NAME);
		const instance = value && value.instance || value;
		if (instance && typeof instance.setHistoricalBatchExperimentConcurrency == "function" && typeof instance.getHistoricalBatchPerformanceSnapshot == "function") return instance;
	}
	catch (_) {}
	return null;
}

class HistoricalCap2AbFieldExporter {
	constructor(options = {}) {
		this.globals = options.globals || globalThis;
		this.outputPath = options.outputPath || OUTPUT_PATH;
		this.fs = options.fileSystem || fs;
		this.setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
		this.clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
		this.pollDelayMs = Math.max(1, Number(options.pollDelayMs) || 1000);
		this.maxPolls = Math.max(1, Number(options.maxPolls) || 3600);
		this.instance = null;
		this.baseline = null;
		this.latest = null;
		this.generation = null;
		this.lastCompleted = 0;
		this.validRuns = [];
		this.invalidRuns = [];
		this.neutralRuns = [];
		this.missedRuns = 0;
		this.armIndex = 0;
		this.idlePolls = 0;
		this.preexistingIdlePolls = 0;
		this.polls = 0;
		this.timer = null;
		this.finished = false;
		this.finishing = false;
		this.discardingPreexisting = false;
		this.discardedPreexistingRuns = 0;
		this.sessionUnsafeReasons = [];
		this.restoreVerified = null;
	}

	arm() {return ARM_PATTERN[this.armIndex % ARM_PATTERN.length];}
	toast(message, type = "info") {try {if (this.globals.BdApi && this.globals.BdApi.showToast) this.globals.BdApi.showToast(message, {type});} catch (_) {}}
	addUnsafe(reason) {if (reason && !this.sessionUnsafeReasons.includes(reason)) this.sessionUnsafeReasons.push(reason);}
	read() {
		const history = this.instance.getHistoricalBatchPerformanceSnapshot() || {};
		let display = {}, controller = {}, live = {queueLength: null, active: null, busy: null};
		try {display = this.instance.ensureReceivedDisplayRepaintScheduler().getDiagnostics() || {};} catch (_) {}
		try {controller = this.instance.ensureReceivedDisplayRuntime().getControllerDiagnostics() || {};} catch (_) {}
		try {const queue = this.instance.ensureLiveTranslationQueue(); live = {queueLength: number(queue.getQueueLength()), active: number(queue.getLiveSlotActiveCount()), busy: queue.isBusyTranslating() === true};} catch (_) {}
		return {history, display, controller, live};
	}
	verifyConcurrencySnapshot(snapshot, expected) {
		const history = snapshot && snapshot.history || {};
		const physical = history.physical || {};
		return number(history.configuredConcurrency) === expected && number(physical.capacity) === expected;
	}
	applyConcurrency(expected, {restoring = false} = {}) {
		let returned = null;
		let snapshot = null;
		try {
			returned = this.instance.setHistoricalBatchExperimentConcurrency(expected);
			snapshot = this.read();
			this.latest = snapshot;
		}
		catch (_) {}
		const verified = number(returned) === expected && this.verifyConcurrencySnapshot(snapshot, expected);
		if (!verified && !restoring) this.addUnsafe("arm_apply_or_verify_failed");
		return verified;
	}
	setArm() {return this.applyConcurrency(this.arm());}
	restoreCap1() {
		if (!this.instance) {this.restoreVerified = null; return true;}
		this.restoreVerified = this.applyConcurrency(1, {restoring: true});
		return this.restoreVerified;
	}
	armRuns(arm) {return this.validRuns.filter(run => run.arm === arm);}
	ready() {return [1, 2].every(arm => this.armRuns(arm).length >= MIN_RUNS_PER_ARM && this.armRuns(arm).reduce((total, run) => total + run.requestedChunks, 0) >= MIN_CHUNKS_PER_ARM);}
	summary() {
		const arm = value => {
			const runs = this.armRuns(value);
			const perChunk = (run, field) => run.requestedChunks > 0 ? run[field] / run.requestedChunks : null;
			return {
				runs: runs.length,
				chunks: runs.reduce((total, run) => total + run.requestedChunks, 0),
				messages: runs.reduce((total, run) => total + run.providerMessageCount, 0),
				inputChars: runs.reduce((total, run) => total + run.providerInputChars, 0),
				inputCharsMin: runs.length ? Math.min(...runs.map(run => run.providerInputChars)) : null,
				inputCharsMax: runs.length ? Math.max(...runs.map(run => run.providerInputChars)) : null,
				messagesPerChunk: runs.length && runs.reduce((total, run) => total + run.requestedChunks, 0) > 0 ? runs.reduce((total, run) => total + run.providerMessageCount, 0) / runs.reduce((total, run) => total + run.requestedChunks, 0) : null,
				inputCharsPerChunk: runs.length && runs.reduce((total, run) => total + run.requestedChunks, 0) > 0 ? runs.reduce((total, run) => total + run.providerInputChars, 0) / runs.reduce((total, run) => total + run.requestedChunks, 0) : null,
				messagesPerChunkP50: nearestRank(runs.map(run => perChunk(run, "providerMessageCount")), .5),
				inputCharsPerChunkP50: nearestRank(runs.map(run => perChunk(run, "providerInputChars")), .5),
				totalPerChunkP50Ms: nearestRank(runs.map(run => perChunk(run, "totalMs")), .5),
				totalP50Ms: nearestRank(runs.map(run => run.totalMs), .5),
				totalP95Ms: nearestRank(runs.map(run => run.totalMs), .95),
				maxActive: runs.length ? Math.max(...runs.map(run => run.maxActiveChunks)) : 0
			};
		};
		const cap1 = arm(1), cap2 = arm(2);
		const workloadBalance = {
			messagesPerChunk: balanceRatio(cap1.messagesPerChunk, cap2.messagesPerChunk),
			inputCharsPerChunk: balanceRatio(cap1.inputCharsPerChunk, cap2.inputCharsPerChunk)
		};
		const workloadComparable = Object.values(workloadBalance).every(value => value != null && value >= MIN_WORKLOAD_BALANCE_RATIO);
		const improvementPercent = cap1.totalPerChunkP50Ms > 0 && cap2.totalPerChunkP50Ms != null ? (cap1.totalPerChunkP50Ms - cap2.totalPerChunkP50Ms) / cap1.totalPerChunkP50Ms * 100 : null;
		const sessionClean = !this.sessionUnsafeReasons.length && !this.invalidRuns.length && !this.missedRuns;
		const historyGatePassed = this.ready() && sessionClean && workloadComparable && improvementPercent >= 20 && cap2.maxActive <= 2;
		const decision = !sessionClean ? "keep_cap1_session_unsafe"
			: historyGatePassed ? "history_pass_live_check_pending"
				: this.ready() && !workloadComparable ? "keep_cap1_workload_not_comparable"
					: this.ready() ? "keep_cap1_history_gate_failed" : "collecting";
		return {cap1, cap2, workloadBalance, workloadComparable, improvementPercent, historyGatePassed, liveImpactPending: true, decision};
	}
	historicalResourcesIdle(snapshot) {
		const history = snapshot && snapshot.history || {};
		const physical = history.physical || {};
		const live = snapshot && snapshot.live || {};
		return (history.activeRunCount || 0) === 0 && (history.activeChunkCount || 0) === 0 && (physical.active || 0) === 0 && (physical.waiting || 0) === 0 && live.queueLength === 0 && live.active === 0 && live.busy === false;
	}
	resourcesIdle(snapshot) {
		const physical = snapshot.history && snapshot.history.physical || {};
		const display = snapshot.display && snapshot.display.resources || {};
		const controller = snapshot.controller && snapshot.controller.resources || {};
		return (snapshot.history.activeRunCount || 0) === 0 && (snapshot.history.activeChunkCount || 0) === 0 && (physical.active || 0) === 0 && (physical.waiting || 0) === 0
			&& snapshot.live && snapshot.live.queueLength === 0 && snapshot.live.active === 0 && snapshot.live.busy === false
			&& DISPLAY_RESOURCE_NUMBERS.every(field => display[field] === 0) && DISPLAY_RESOURCE_FLAGS.every(field => display[field] === false)
			&& CONTROLLER_RESOURCE_NUMBERS.every(field => controller[field] === 0) && CONTROLLER_RESOURCE_FLAGS.every(field => controller[field] === false);
	}
	getSafetyReasons(snapshot) {
		if (!this.baseline) return [];
		const reasons = [];
		const d = delta(snapshot.display, this.baseline.display, DISPLAY_FIELDS);
		const c = delta(snapshot.controller, this.baseline.controller, CONTROLLER_FIELDS);
		if (d.fullRepaints !== 0) reasons.push("full_repaint");
		if (d.exhausted !== 0) reasons.push("display_exhausted");
		if (c.deferredFlushErrorCount !== 0) reasons.push("display_flush_error");
		return reasons;
	}
	safetyClean(snapshot) {return !this.getSafetyReasons(snapshot).length;}
	record(ok, state, reason = null) {
		return {
			ok,
			state,
			reason,
			expectedArm: this.arm(),
			armIndex: this.armIndex,
			restoredCap1: this.restoreVerified,
			discardingPreexisting: this.discardingPreexisting,
			discardedPreexistingRuns: this.discardedPreexistingRuns,
			sessionUnsafeReasons: this.sessionUnsafeReasons.slice(),
			validRuns: this.validRuns.slice(),
			invalidRuns: this.invalidRuns.slice(),
			neutralRuns: this.neutralRuns.slice(),
			missedRuns: this.missedRuns,
			summary: this.summary(),
			history: pick(this.latest && this.latest.history, ["generation", "completedRunCount", "activeRunCount", "activeChunkCount", "configuredConcurrency"]),
			physical: pick(this.latest && this.latest.history && this.latest.history.physical, ["capacity", "active", "waiting", "highWater", "generation"]),
			live: this.latest && this.latest.live ? {queueLength: this.latest.live.queueLength, active: this.latest.live.active, busy: this.latest.live.busy} : null
		};
	}
	write(record) {
		const temporary = `${this.outputPath}.${runtimeProcess.pid}.${Date.now()}.tmp`;
		try {
			this.fs.mkdirSync(path.dirname(this.outputPath), {recursive: true});
			this.fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
			this.fs.renameSync(temporary, this.outputPath);
		}
		catch (error) {
			try {if (typeof this.fs.unlinkSync == "function") this.fs.unlinkSync(temporary);} catch (_) {}
			throw error;
		}
	}
	persist(ok, state, reason = null) {
		try {this.write(this.record(ok, state, reason)); return true;}
		catch (_) {
			this.toast("F1H1 A/B 写入失败", "error");
			this.finish(false, "write_failed", {skipWrite: true});
			return false;
		}
	}
	consume(snapshot) {
		const history = snapshot.history || {}, completed = number(history.completedRunCount) || 0;
		if (this.generation !== history.generation || completed < this.lastCompleted) return -1;
		const count = completed - this.lastCompleted;
		if (!count) return 0;
		const recent = Array.isArray(history.recentRuns) ? history.recentRuns : [], available = Math.min(count, recent.length);
		this.missedRuns += count - available;
		for (const raw of recent.slice(-available)) {
			const run = sanitizeRun(raw), arm = this.arm();
			const neutralKind = isNeutralNonProviderRun(run, arm) ? "cache_only" : null;
			if (neutralKind) {
				this.neutralRuns.push({arm, kind: neutralKind, run});
				if (this.neutralRuns.length > MAX_NEUTRAL_RUNS) this.neutralRuns.shift();
				continue;
			}
			const reasons = invalidReasons(run, arm);
			if (reasons.length) {
				this.invalidRuns.push({arm, reasons, run});
				if (this.invalidRuns.length > MAX_INVALID_RUNS) this.invalidRuns.shift();
				for (const reason of reasons) this.addUnsafe(`run_${reason}`);
			}
			else {
				this.validRuns.push(Object.freeze({...run, arm}));
				this.armIndex++;
			}
		}
		this.lastCompleted = completed;
		if (this.missedRuns) this.addUnsafe("missed_runs");
		if (!this.sessionUnsafeReasons.length && available && !this.setArm()) this.addUnsafe("arm_apply_or_verify_failed");
		return available;
	}
	schedulePoll() {
		this.timer = this.setTimeout(() => {this.timer = null; this.poll();}, this.pollDelayMs);
	}
	beginSampling() {
		this.discardingPreexisting = false;
		this.preexistingIdlePolls = 0;
		this.generation = this.latest.history.generation;
		this.lastCompleted = number(this.latest.history.completedRunCount) || 0;
		this.baseline = this.latest;
		if (!this.setArm()) return this.finish(false, "arm_apply_or_verify_failed");
		this.baseline = this.latest;
		this.generation = this.latest.history.generation;
		this.lastCompleted = number(this.latest.history.completedRunCount) || 0;
		if (!this.persist(false, "waiting")) return;
		this.toast(`F1H1 A/B：下一轮并发 ${this.arm()}`, "info");
	}
	poll() {
		if (this.finished) return;
		try {this.latest = this.read();} catch (_) {return this.finish(false, "snapshot_read_failed");}
		if (this.discardingPreexisting) {
			const history = this.latest.history || {};
			const completed = number(history.completedRunCount) || 0;
			if (this.generation !== history.generation || completed < this.lastCompleted) return this.finish(false, "plugin_reloaded");
			this.discardedPreexistingRuns += completed - this.lastCompleted;
			this.lastCompleted = completed;
			if (this.historicalResourcesIdle(this.latest)) this.preexistingIdlePolls++; else this.preexistingIdlePolls = 0;
			if (this.preexistingIdlePolls >= 2) this.beginSampling();
			else if (!this.persist(false, "draining_preexisting")) return;
			if (this.finished) return;
			if (++this.polls >= this.maxPolls) return this.finish(false, "timeout");
			return this.schedulePoll();
		}
		const consumed = this.consume(this.latest);
		if (consumed < 0) return this.finish(false, "plugin_reloaded");
		for (const reason of this.getSafetyReasons(this.latest)) this.addUnsafe(reason);
		if (this.sessionUnsafeReasons.length) return this.finish(false, this.sessionUnsafeReasons[0]);
		if (this.validRuns.length > MAX_VALID_RUNS) return this.finish(false, "run_limit");
		if (consumed) {if (!this.persist(false, "collecting")) return; const s = this.summary(); this.toast(`F1H1 A/B：A ${s.cap1.runs}/${MIN_RUNS_PER_ARM} · B ${s.cap2.runs}/${MIN_RUNS_PER_ARM} · 下一轮 ${this.arm()}`, "info");}
		if (this.ready() && this.resourcesIdle(this.latest)) this.idlePolls++; else this.idlePolls = 0;
		if (this.idlePolls >= 2) return this.finish(true, null);
		if (++this.polls >= this.maxPolls) return this.finish(false, "timeout");
		this.schedulePoll();
	}
	finish(ok, reason, {skipWrite = false} = {}) {
		if (this.finished || this.finishing) return;
		this.finishing = true;
		if (this.timer != null) this.clearTimeout(this.timer);
		this.timer = null;
		const restored = this.restoreCap1();
		let finalOk = !!ok && restored && !this.sessionUnsafeReasons.length;
		let finalReason = reason;
		if (!restored) finalReason = finalReason ? `${finalReason};restore_cap1_failed` : "restore_cap1_failed";
		if (ok && this.sessionUnsafeReasons.length) finalReason = finalReason || this.sessionUnsafeReasons[0];
		this.finished = true;
		this.finishing = false;
		if (!skipWrite) {
			try {this.write(this.record(finalOk, finalOk ? "complete" : "failed", finalReason));}
			catch (_) {finalOk = false; this.toast("F1H1 A/B 写入失败", "error");}
		}
		this.toast(finalOk ? "F1H1 历史 A/B 采样完成（已恢复并发1，请提交结果）" : "F1H1 历史 A/B 未完成", finalOk ? "info" : "error");
	}
	start() {
		if (this.finished || this.instance) return;
		this.instance = resolveInstance(this.globals);
		if (!this.instance) return this.finish(false, "active_instance_not_found");
		try {this.latest = this.read();}
		catch (_) {return this.finish(false, "snapshot_read_failed");}
		if (!this.applyConcurrency(1)) return this.finish(false, "arm_apply_or_verify_failed");
		this.baseline = this.latest;
		this.generation = this.latest.history.generation;
		this.lastCompleted = number(this.latest.history.completedRunCount) || 0;
		if (this.historicalResourcesIdle(this.latest)) this.beginSampling();
		else {
			this.discardingPreexisting = true;
			if (!this.persist(false, "draining_preexisting")) return;
			this.toast("F1H1 A/B：等待既有历史任务结束", "info");
		}
		if (!this.finished) this.schedulePoll();
	}
	stop() {
		if (this.finished) {this.restoreCap1(); return;}
		this.finish(false, "exporter_stopped");
	}
}

module.exports = HistoricalCap2AbFieldExporter;
module.exports.HistoricalCap2AbFieldExporter = HistoricalCap2AbFieldExporter;
module.exports.sanitizeRun = sanitizeRun;
module.exports.invalidReasons = invalidReasons;
module.exports.isNeutralNonProviderRun = isNeutralNonProviderRun;
module.exports.OUTPUT_PATH = OUTPUT_PATH;
