/**
 * @name DiscordAITranslator Reliable F0.5 Field Exporter
 * @author DiscordAITranslator
 * @version 0.1.0
 * @description Read-only aggregate F0.5 exporter for the already-running DiscordAITranslator instance.
 */
"use strict";

// BetterDiscord exposes a deliberately small CommonJS allowlist to plugins.
// Use its canonical module names rather than Node's `node:` aliases, and get
// the temporary directory from the exposed process environment (the `os`
// module is not part of that allowlist).
const fs = require("fs");
const path = require("path");
const runtimeProcess = require("process");

const PLUGIN_NAME = "DiscordAITranslator";
const DEFAULT_OUTPUT_PATH = path.join(runtimeProcess.env.TEMP || runtimeProcess.env.TMP || ".", "DiscordAITranslator-f05-field-sample.json");
const TRACE_NUMBER_FIELDS = ["generation", "enqueuedCount", "dispatchedSingleCount", "dispatchedBurstMessageCount", "burstRequestCount", "cachedServeCount", "guardDropCount", "requeuedCount", "queueDepthHighWater", "traceLength"];
const LATENCY_NUMBER_FIELDS = ["generation", "p50Ms", "p95Ms", "sampleCount", "queueP50Ms", "queueP95Ms", "queueSampleCount", "liveP50Ms", "liveP95Ms", "liveSampleCount", "attemptTotalCount", "batchRequestCount", "batchMessageCount", "failoverCount", "timeoutCount", "rateLimitCount", "queueWaitMs", "attemptsCount"];
const LATENCY_BOOLEAN_FIELDS = ["sufficient", "queueSufficient", "liveSufficient"];
const DIAGNOSTIC_NUMBER_FIELDS = ["fullRepaints", "scheduled", "flushes", "renderBatches", "confirmed", "deferred", "retries", "exhausted"];
const DIAGNOSTIC_BOOLEAN_FIELDS = [];
const RESOURCE_NUMBER_FIELDS = ["queuedChannels", "queuedMessages", "activeChannels", "activeMessages"];
const RESOURCE_BOOLEAN_FIELDS = ["coalesceTimerArmed", "fullRepaintTimerArmed", "settingsRetryTimerArmed", "textAreaRetryTimerArmed", "deferredFullRepaintPending"];

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function aggregateFields(source, numbers, booleans) {
	const result = {};
	for (const field of numbers) result[field] = finiteNumber(source && source[field]);
	for (const field of booleans) result[field] = !!(source && source[field]);
	return result;
}

function aggregateStats(source) {
	return aggregateFields(source, ["count", "p50Ms", "p95Ms"], ["sufficient"]);
}

function createAggregateSnapshot(snapshot) {
	const trace = snapshot && snapshot.trace || {};
	const latency = snapshot && snapshot.latency || {};
	const diagnostics = snapshot && snapshot.diagnostics || {};
	return {
		effectiveEngineClass: classifyEngine(latency.engineKey),
		trace: Object.assign(aggregateFields(trace, TRACE_NUMBER_FIELDS, []), {
			queueWait: aggregateStats(trace.queueWait),
			enqueueToDom: aggregateStats(trace.enqueueToDom)
		}),
		latency: aggregateFields(latency, LATENCY_NUMBER_FIELDS, LATENCY_BOOLEAN_FIELDS),
		diagnostics: Object.assign(aggregateFields(diagnostics, DIAGNOSTIC_NUMBER_FIELDS, DIAGNOSTIC_BOOLEAN_FIELDS), {
			resources: aggregateFields(diagnostics.resources, RESOURCE_NUMBER_FIELDS, RESOURCE_BOOLEAN_FIELDS)
		})
	};
}

function aggregateActivity(value, field = null) {
	if (field === "generation") return 0;
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (!value || typeof value !== "object") return 0;
	return Object.entries(value).reduce((score, [key, child]) => score + aggregateActivity(child, key), 0);
}

function classifyEngine(engineKey) {
	const value = typeof engineKey === "string" ? engineKey.toLowerCase() : "";
	if (/^custom(?:[-_:]|$)/.test(value)) return "custom";
	if (/(?:deepl|microsoft|googletranslate|machine)/.test(value)) return "machine";
	if (/(?:builtin|openai|gemini|claude|anthropic|ai)/.test(value)) return "builtin_ai";
	return "unknown";
}

function isActiveInstance(candidate) {
	return !!candidate && typeof candidate === "object" && [
		"ensureLiveTranslationQueue",
		"ensureProviderClient",
		"ensureReceivedDisplayRepaintScheduler"
	].every(method => typeof candidate[method] === "function");
}

function getCandidates(globals) {
	const candidates = [];
	const add = value => {
		if (!value) return;
		if (value && typeof value === "object" && value.instance) candidates.push(value.instance);
		candidates.push(value);
	};
	try {
		const bdfdb = globals && globals.BDFDB;
		if (bdfdb && bdfdb.BDUtils && typeof bdfdb.BDUtils.getPlugin === "function") add(bdfdb.BDUtils.getPlugin(PLUGIN_NAME));
	} catch (_) {}
	try {
		const plugins = globals && globals.BdApi && globals.BdApi.Plugins;
		if (plugins && typeof plugins.get === "function") add(plugins.get(PLUGIN_NAME));
	} catch (_) {}
	return candidates.filter(isActiveInstance);
}

function candidateActivity(candidate) {
	try {
		const trace = candidate.ensureLiveTranslationQueue().performanceTrace.getSnapshot();
		const latency = candidate.ensureProviderClient().getLatencySnapshot();
		const diagnostics = candidate.ensureReceivedDisplayRepaintScheduler().getDiagnostics();
		return aggregateActivity(createAggregateSnapshot({trace, latency, diagnostics}));
	} catch (_) {
		return -1;
	}
}

function resolveActiveInstance(globals = globalThis) {
	const candidates = getCandidates(globals);
	if (!candidates.length) return null;
	return candidates.reduce((best, candidate) => candidateActivity(candidate) > candidateActivity(best) ? candidate : best);
}

class ReliableFieldExporter {
	constructor(options = {}) {
		this.globals = options.globals || globalThis;
		this.outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
		this.setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
		this.clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
		this.pollDelayMs = Math.max(1, Number(options.pollDelayMs) || 1000);
		this.maxPolls = Math.max(1, Number(options.maxPolls) || 120);
		this.timer = null;
		this.polls = 0;
		this.finished = false;
		this.finalizing = false;
		this.failed = false;
		this.baseline = null;
		this.fs = options.fileSystem || fs;
	}

	toast(message, type) {
		try {
			if (this.globals && typeof this.globals.showToast === "function") this.globals.showToast(message, type);
			else if (this.globals && this.globals.BdApi && typeof this.globals.BdApi.showToast === "function") this.globals.BdApi.showToast(message, {type});
		} catch (_) {}
	}

	readSnapshot(instance) {
		const trace = instance.ensureLiveTranslationQueue().performanceTrace.getSnapshot();
		const latency = instance.ensureProviderClient().getLatencySnapshot();
		const diagnostics = instance.ensureReceivedDisplayRepaintScheduler().getDiagnostics();
		return {trace: trace || {}, latency: latency || {}, diagnostics: diagnostics || {}};
	}

	buildRecord(ok, reason, mode, snapshot) {
		return Object.assign({
			ok: !!ok,
			reason: reason || null,
			mode: mode || null
		}, createAggregateSnapshot(snapshot));
	}

	writeAtomically(record) {
		const temporaryPath = `${this.outputPath}.${runtimeProcess.pid}.${Date.now()}.tmp`;
		try {
			this.fs.mkdirSync(path.dirname(this.outputPath), {recursive: true});
			this.fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
			this.fs.renameSync(temporaryPath, this.outputPath);
		} catch (error) {
			try { this.fs.unlinkSync(temporaryPath); } catch (_) {}
			throw error;
		}
	}

	isBurst(snapshot) {
		const trace = snapshot.trace || {};
		const latency = snapshot.latency || {};
		return trace.burstRequestCount > 0 && trace.dispatchedBurstMessageCount > 1 && latency.batchRequestCount > 0 && latency.batchMessageCount > 1;
	}

	isCustomBurst(snapshot) {
		return this.isBurst(snapshot) && classifyEngine(snapshot && snapshot.latency && snapshot.latency.engineKey) === "custom";
	}

	increasedSinceBaseline(snapshot) {
		const baselineTrace = this.baseline.trace || {};
		const baselineLatency = this.baseline.latency || {};
		const trace = snapshot.trace || {};
		const latency = snapshot.latency || {};
		return trace.burstRequestCount > baselineTrace.burstRequestCount &&
			trace.dispatchedBurstMessageCount > baselineTrace.dispatchedBurstMessageCount &&
			latency.batchRequestCount > baselineLatency.batchRequestCount &&
			latency.batchMessageCount > baselineLatency.batchMessageCount;
	}

	finalize(ok, reason, mode, snapshot) {
		if (this.finished || this.finalizing) return;
		this.finalizing = true;
		if (this.timer !== null) {
			this.clearTimeout(this.timer);
			this.timer = null;
		}
		try {
			this.writeAtomically(this.buildRecord(ok, reason, mode, snapshot || {trace: {}, latency: {}, diagnostics: {}}));
			this.finished = true;
			this.finalizing = false;
			this.toast(ok ? "DiscordAITranslator field sample exported" : "DiscordAITranslator field sample failed", ok ? "success" : "error");
		} catch (_) {
			this.failed = true;
			this.finished = true;
			this.finalizing = false;
			this.toast("DiscordAITranslator field sample failed", "error");
		}
	}

	poll(instance) {
		if (this.finished) return;
		let current;
		try {
			current = this.readSnapshot(instance);
		} catch (_) {
			this.finalize(false, "snapshot_read_failed", null, {trace: {}, latency: {}, diagnostics: {}});
			return;
		}
		if (this.isCustomBurst(current) && this.increasedSinceBaseline(current)) {
			this.finalize(true, null, "observed_burst", current);
			return;
		}
		this.polls++;
		if (this.polls >= this.maxPolls) {
			this.finalize(false, "insufficient_nonzero_metrics", null, current);
			return;
		}
		this.timer = this.setTimeout(() => {
			this.timer = null;
			this.poll(instance);
		}, this.pollDelayMs);
	}

	start() {
		if (this.finished || this.timer !== null || this.baseline) return;
		const instance = resolveActiveInstance(this.globals);
		if (!instance) {
			this.finalize(false, "active_instance_not_found", null, {trace: {}, latency: {}, diagnostics: {}});
			return;
		}
		let initial;
		try {
			initial = this.readSnapshot(instance);
		} catch (_) {
			this.finalize(false, "snapshot_read_failed", null, {trace: {}, latency: {}, diagnostics: {}});
			return;
		}
		if (this.isCustomBurst(initial)) {
			this.finalize(true, null, "preexisting_burst", initial);
			return;
		}
		this.baseline = initial;
		this.toast("DiscordAITranslator field sample waiting", "info");
		this.timer = this.setTimeout(() => {
			this.timer = null;
			this.poll(instance);
		}, this.pollDelayMs);
	}

	stop() {
		if (this.timer !== null) this.clearTimeout(this.timer);
		this.timer = null;
		this.finished = true;
	}
}

module.exports = ReliableFieldExporter;
module.exports.ReliableFieldExporter = ReliableFieldExporter;
module.exports.resolveActiveInstance = resolveActiveInstance;
module.exports.DEFAULT_OUTPUT_PATH = DEFAULT_OUTPUT_PATH;
