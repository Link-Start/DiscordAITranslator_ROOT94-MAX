#!/usr/bin/env node
// Offline survey: how much of the user's real traffic the single-range W5 class
// would cover, and what the typed history path costs per message today.
//
// Reads the installed plugin config (translationCache sources and
// historicalPrimarySamples), runs the production protection logic, planner,
// whole-marker compiler and typed serializer locally, and prints aggregates
// only. No message text, ids or credentials are printed.
//
//   node scripts/survey-w5-applicability.cjs [path/to/DiscordAITranslator.config.json]
const path = require("path");
const fs = require("fs");

const {createProtectionLogic, MESSAGE_PLACES} = require("../src/protection/protection-logic");
const {planReceivedMarkdown} = require("../src/planner/received-markdown-lossless-planner");
const {buildWholeMarkerRequest} = require("../src/planner/translation-whole-marker-wire");
const {compileTypedPlan} = require("../src/planner/translation-plan-serializer");

const configPath = process.argv[2] || path.join(process.env.APPDATA || "", "BetterDiscord/plugins/DiscordAITranslator.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8")).all || {};

const exceptions = config.exceptions || {};
const settings = {
	wordStart: [...(exceptions.wordStart || [])],
	protectedTerms: [...(exceptions.protectedTerms || [])],
	wrapperPairs: [...(exceptions.wrapperPairs || [])],
	protectedTermsForReceived: exceptions.protectedTermsForReceived !== false,
	wrapperPairsForReceived: exceptions.wrapperPairsForReceived !== false
};
const plugin = {
	settings: {exceptions: settings},
	getProtectedWrapperRules() {
		return settings.wrapperPairs.map(value => {const [left, right] = String(value).split("|"); return {left, right};}).filter(row => row.left && row.right);
	}
};
const logic = createProtectionLogic();

function classify(source) {
	const prepared = logic.prepareSemanticSource(plugin, source, MESSAGE_PLACES.RECEIVED);
	const plan = planReceivedMarkdown(prepared.source, {direction: "received", fieldPath: "body", targetLanguageId: "zh-CN"});
	const typed = compileTypedPlan(plan);
	const request = buildWholeMarkerRequest(plan, prepared.protectedSegments || {}, {targetLanguageId: "zh-CN", allowSourceSpoilerEcho: true});
	return {
		typedBytes: typed.bodyBytes || 0,
		w5Bytes: request.ok ? request.bodyBytes || 0 : null,
		ranges: request.ok ? request.totalRangeCount : null,
		single: !!(request.ok && request.totalRangeCount === 1 && request.ranges.length === 1),
		reason: request.ok ? null : request.reason
	};
}

const percentile = (values, p) => {const sorted = values.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;};
const share = (part, whole) => +(part / Math.max(1, whole) * 100).toFixed(1);

// Message-level survey over the translation cache (cache key = message id).
const byChannel = new Map();
const histogram = {};
const notOk = {};
let typedBytes = 0, w5Bytes = 0, typedBytesSingle = 0, w5BytesSingle = 0, compiled = 0, single = 0;
const lengths = [];
for (const [messageId, entry] of Object.entries(config.translationCache || {})) {
	const translation = entry && entry.translation;
	const source = translation && typeof translation.originalContent === "string" ? translation.originalContent : "";
	if (!source.trim()) continue;
	const result = classify(source);
	lengths.push(source.length);
	typedBytes += result.typedBytes;
	if (result.reason) {notOk[result.reason] = (notOk[result.reason] || 0) + 1; continue;}
	compiled++;
	w5Bytes += result.w5Bytes;
	const bucket = result.ranges > 5 ? "6+" : String(result.ranges);
	histogram[bucket] = (histogram[bucket] || 0) + 1;
	if (result.single) {single++; typedBytesSingle += result.typedBytes; w5BytesSingle += result.w5Bytes;}
	const list = byChannel.get(translation.channelId) || [];
	list.push({id: BigInt(messageId), single: result.single});
	byChannel.set(translation.channelId, list);
}
const surveyed = lengths.length;

// Batch-level view: the History-only policy admits a batch only when every
// message is single-range. Consecutive windows follow message-id order per
// channel, the same order history chunks are formed in.
const batchPolicy = {};
for (const size of [5, 10, 20]) {
	let batches = 0, eligible = 0;
	for (const list of byChannel.values()) {
		list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		for (let i = 0; i + size <= list.length; i += size) {
			batches++;
			if (list.slice(i, i + size).every(message => message.single)) eligible++;
		}
	}
	batchPolicy[`batch${size}`] = {batches, allSingleBatches: eligible, share: share(eligible, batches)};
}
// Alternative chunking that groups single-range messages together first.
let sortedW5Batches = 0, sortedBatches = 0, sortedCovered = 0;
for (const list of byChannel.values()) {
	const singles = list.filter(message => message.single).length, multis = list.length - singles;
	const w5 = Math.floor(singles / 10);
	sortedW5Batches += w5;
	sortedBatches += w5 + Math.ceil(multis / 10) + (singles % 10 ? 1 : 0);
	sortedCovered += w5 * 10;
}

// Typed history batches actually sent (provider usage, not estimates).
const samples = (config.historicalPrimarySamples && config.historicalPrimarySamples.samples || []).filter(sample => sample && sample.usage && sample.usage.promptTokens > 0 && sample.itemCount > 0 && !sample.cache);
const fit = (xs, ys) => {
	const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0, sxx = 0;
	for (let i = 0; i < n; i++) {sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2;}
	const slope = sxx ? sxy / sxx : 0;
	return {slope, intercept: my - slope * mx};
};
const byItems = fit(samples.map(sample => sample.itemCount), samples.map(sample => sample.usage.promptTokens));
const primary = samples.filter(sample => !sample.repair);
const reasons = {};
for (const sample of samples) for (const [key, value] of Object.entries(sample.validationReasons || {})) reasons[key] = (reasons[key] || 0) + (typeof value === "number" ? value : 1);
const counters = config.historicalPrimarySamples && config.historicalPrimarySamples.counters || {};

console.log(JSON.stringify({
	messages: {
		surveyed,
		channels: byChannel.size,
		sourceLengthChars: {p50: percentile(lengths, 0.5), p90: percentile(lengths, 0.9)},
		compiled,
		notOk,
		singleRange: single,
		singleRangeShare: share(single, surveyed),
		rangeHistogram: histogram,
		bodyBytesPerMessage: {typedAll: Math.round(typedBytes / Math.max(1, surveyed)), w5All: Math.round(w5Bytes / Math.max(1, compiled)), typedSingle: Math.round(typedBytesSingle / Math.max(1, single)), w5Single: Math.round(w5BytesSingle / Math.max(1, single))}
	},
	historyOnlyPolicyAllOrNothing: batchPolicy,
	groupedChunkingAlternative: {w5Batches: sortedW5Batches, totalBatches: sortedBatches, messageCoverage: share(sortedCovered, surveyed)},
	typedHistoryBatches: {
		samples: samples.length,
		promptTokens: {fixedPerRequest: Math.round(byItems.intercept), perMessage: Math.round(byItems.slope)},
		perMessageP50: {prompt: Math.round(percentile(samples.map(sample => sample.usage.promptTokens / sample.itemCount), 0.5)), completion: Math.round(percentile(samples.map(sample => sample.usage.completionTokens / sample.itemCount), 0.5))},
		primaryDurationMs: {p50: percentile(primary.map(sample => sample.durationMs), 0.5), p95: percentile(primary.map(sample => sample.durationMs), 0.95)},
		batchesNeedingRepair: share(samples.filter(sample => sample.repair).length, samples.length),
		validationReasons: reasons,
		lifetimeCounters: {cache: counters.cache, repairs: counters.repairs, validationReasons: counters.validationReasons}
	}
}, null, 2));
