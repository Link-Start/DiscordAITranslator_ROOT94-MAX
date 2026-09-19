#!/usr/bin/env node
"use strict";

// W2b-0 analysis: reads one or more W2 harness result files (already anonymous) and
// derives the per-arm x fixture reason distribution, the per-segment failure table and
// the marker structure summary. It never opens config, provider or fixture text.

const fs = require("node:fs");
const path = require("node:path");

const {W2_ALL_FIXTURES} = require("../src/diagnostics/w2-wire-benchmark-fixtures");

const ANALYSIS_SCHEMA_VERSION = "w2b0-analysis-2";
const DECISION_SCHEMA_VERSION = "w2b-decision-1";
const W2C_DECISION_SCHEMA_VERSION = "w2c-decision-1";
const ARMS = Object.freeze(["typed-json", "compact-order", "compact-marker", "whole-marker"]);
const ARM_LABELS = Object.freeze({"typed-json": "A", "compact-order": "Ba", "compact-marker": "Bm", "whole-marker": "D"});
const TOP_FAILING_LIMIT = 20;
// Ruling 3: a fixture is "long/mixed" when its source has >= 300 characters or D marks >= 5 ranges.
const LONG_SOURCE_CHARS = 300;
const LONG_RANGE_COUNT = 5;
const FIXTURE_SOURCE_CHARS = Object.freeze(Object.fromEntries(W2_ALL_FIXTURES.map(fixture => [fixture.id, Array.from(fixture.source).length])));

function label(value, fallback = null) {return /^[A-Za-z0-9._:-]{1,64}$/.test(String(value || "")) ? String(value) : fallback;}
function count(value) {const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;}
function nullableNumber(value) {return value == null || !Number.isFinite(Number(value)) ? null : Number(value);}
function bump(target, key, amount = 1) {target[key] = (target[key] || 0) + amount;}
function sortedObject(source) {return Object.fromEntries(Object.keys(source).sort().map(key => [key, source[key]]));}
function nearestRank(values, percentile) {
	if (!values.length) return null;
	const sorted = values.slice().sort((left, right) => left - right);
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1))];
}
function lengthBucket(chars) {return chars <= 12 ? "1-12" : chars <= 40 ? "13-40" : "41+";}
function trialOk(trial) {return trial.status === "ok" && trial.valid === true && trial.protectedIntegrity !== "fail";}
function trialReason(trial) {return trialOk(trial) ? "ok" : label(trial.reason, "unknown");}

function summarizeTrials(trials) {
	const reasons = {}, providerMs = [];
	let protectedFailures = 0, prompt = 0, completion = 0, promptComplete = true, completionComplete = true;
	for (const trial of trials) {
		bump(reasons, trialReason(trial));
		if (trial.protectedIntegrity === "fail") protectedFailures++;
		if (trial.providerMs != null) providerMs.push(Number(trial.providerMs));
		if (trial.promptTokens == null) promptComplete = false; else prompt += Number(trial.promptTokens);
		if (trial.completionTokens == null) completionComplete = false; else completion += Number(trial.completionTokens);
	}
	return {
		total: trials.length,
		ok: trials.filter(trialOk).length,
		reasons: sortedObject(reasons),
		protectedFailures,
		providerMs: providerMs.length ? {samples: providerMs.length, p50: nearestRank(providerMs, 0.5), min: Math.min(...providerMs), max: Math.max(...providerMs)} : null,
		promptTokens: trials.length && promptComplete ? prompt : null,
		completionTokens: trials.length && completionComplete ? completion : null
	};
}

function collectTrials(inputs) {
	const rows = [];
	for (const input of inputs) {
		const trials = input.result && input.result.store && Array.isArray(input.result.store.trials) ? input.result.store.trials : [];
		for (const trial of trials) if (trial && ARMS.includes(String(trial.arm))) rows.push(Object.assign({}, trial, {arm: String(trial.arm), fixtureId: label(trial.fixtureId, "unknown"), sourceLabel: input.label}));
	}
	return rows;
}

function describeInput(input) {
	const result = input.result || {}, benchmark = result.benchmark || {}, arms = {};
	for (const key of ["A", "Ba", "Bm"]) {
		const arm = benchmark.arms && benchmark.arms[key];
		if (!arm || !count(arm.planned)) continue;
		arms[key] = {planned: count(arm.planned), attempted: count(arm.attempted), succeeded: count(arm.succeeded), failed: count(arm.failed), timeout: count(arm.timeout), cancelled: count(arm.cancelled), p50Ms: nullableNumber(arm.p50Ms), p95Ms: nullableNumber(arm.p95Ms), promptTokens: nullableNumber(arm.promptTokens), completionTokens: nullableNumber(arm.completionTokens), reasoningTokens: nullableNumber(arm.reasoningTokens)};
	}
	return {
		label: input.label,
		mode: label(result.mode),
		status: label(result.status, "unknown"),
		reason: result.reason == null ? null : label(result.reason, "unknown"),
		completedRequests: count(benchmark.completedRequests),
		maxRequests: count(benchmark.maxRequests),
		gateReady: benchmark.gateReady === true,
		plannedArms: Array.isArray(result.store && result.store.plannedArms) ? result.store.plannedArms.filter(arm => ARMS.includes(arm)) : [],
		planComplete: !!(result.store && result.store.planComplete === true),
		storeStatus: label(result.store && result.store.status, "unknown"),
		gate: result.store && result.store.gate ? {ready: result.store.gate.ready === true, passed: result.store.gate.passed === true, reason: label(result.store.gate.reason, "unknown")} : null,
		integrity: result.integrity ? {configUnchanged: result.integrity.configUnchanged === true, installedUnchanged: result.integrity.installedUnchanged === true} : null,
		transport: result.transport ? {physicalRequestCount: count(result.transport.physicalRequestCount), callbackRequestCount: count(result.transport.callbackRequestCount), settingsWriteAttemptCount: count(result.transport.settingsWriteAttemptCount), activeHighWater: count(result.transport.activeHighWater)} : null,
		arms
	};
}

// Arms that segment the same way (A/Ba/Bm share the planner inventory) are merged per
// index; an arm with a different inventory (D ranges) gets its own table per fixture.
function primaryInventory(trials, fixtureId) {
	const candidates = trials.filter(trial => trial.fixtureId === fixtureId && Array.isArray(trial.segmentDiagnostics) && trial.segmentDiagnostics.length);
	const typed = candidates.find(trial => trial.arm === "typed-json");
	return typed ? typed.segmentDiagnostics.length : candidates.length ? candidates[0].segmentDiagnostics.length : 0;
}

function segmentTable(trials) {
	const primaryByFixture = {};
	for (const trial of trials) if (!(trial.fixtureId in primaryByFixture)) primaryByFixture[trial.fixtureId] = primaryInventory(trials, trial.fixtureId);
	const merged = buildSegmentTables(trials.filter(trial => Array.isArray(trial.segmentDiagnostics) && trial.segmentDiagnostics.length === primaryByFixture[trial.fixtureId]));
	const others = trials.filter(trial => Array.isArray(trial.segmentDiagnostics) && trial.segmentDiagnostics.length && trial.segmentDiagnostics.length !== primaryByFixture[trial.fixtureId]);
	for (const arm of ARMS) {
		const armTrials = others.filter(trial => trial.arm === arm);
		if (!armTrials.length) continue;
		const tables = buildSegmentTables(armTrials);
		for (const [fixtureId, table] of Object.entries(tables)) {
			const target = merged[fixtureId] || (merged[fixtureId] = {expectedSegmentCount: 0, segmentsWithFailures: 0, byLengthBucket: {}, listItemFailures: {listItems: 0, nonListItems: 0}, topFailing: [], rows: []});
			target.otherInventories = Object.assign({}, target.otherInventories || {}, {[arm]: table});
		}
	}
	return merged;
}

function buildSegmentTables(trials) {
	const byFixture = {};
	for (const trial of trials) {
		if (!Array.isArray(trial.segmentDiagnostics) || !trial.segmentDiagnostics.length) continue;
		const fixture = byFixture[trial.fixtureId] || (byFixture[trial.fixtureId] = {expectedSegmentCount: 0, rows: new Map()});
		fixture.expectedSegmentCount = Math.max(fixture.expectedSegmentCount, trial.segmentDiagnostics.length);
		for (const segment of trial.segmentDiagnostics) {
			const index = count(segment.index);
			const row = fixture.rows.get(index) || (fixture.rows.set(index, {
				index,
				sourceChars: count(segment.sourceChars),
				lengthBucket: lengthBucket(count(segment.sourceChars)),
				sourceHasCjk: segment.sourceHasCjk === true,
				sourceLineCount: count(segment.sourceLineCount),
				sourceWordCount: count(segment.sourceWordCount),
				isListItem: segment.isListItem === true,
				isHeading: segment.isHeading === true,
				byArm: {},
				totalEvaluated: 0,
				totalFailed: 0
			}), fixture.rows.get(index));
			const arm = row.byArm[trial.arm] || (row.byArm[trial.arm] = {evaluated: 0, failed: 0, reasons: {}, targetMissingCjk: 0});
			const reason = label(segment.reason, "unknown");
			arm.evaluated++;
			row.totalEvaluated++;
			if (reason !== "ok") {arm.failed++; row.totalFailed++; bump(arm.reasons, reason);}
			if (segment.targetHasCjk === false) arm.targetMissingCjk++;
		}
	}
	const output = {};
	for (const [fixtureId, fixture] of Object.entries(byFixture).sort(([left], [right]) => left.localeCompare(right))) {
		const rows = [...fixture.rows.values()].sort((left, right) => left.index - right.index).map(row => Object.assign({}, row, {byArm: sortedObject(Object.fromEntries(Object.entries(row.byArm).map(([arm, value]) => [arm, Object.assign({}, value, {reasons: sortedObject(value.reasons)})])))}));
		const failing = rows.filter(row => row.totalFailed > 0).sort((left, right) => right.totalFailed - left.totalFailed || left.index - right.index);
		const buckets = {};
		for (const row of rows) {
			const bucket = buckets[row.lengthBucket] || (buckets[row.lengthBucket] = {segments: 0, listItems: 0, evaluated: 0, failed: 0});
			bucket.segments++;
			if (row.isListItem) bucket.listItems++;
			bucket.evaluated += row.totalEvaluated;
			bucket.failed += row.totalFailed;
		}
		output[fixtureId] = {
			expectedSegmentCount: fixture.expectedSegmentCount,
			segmentsWithFailures: failing.length,
			byLengthBucket: sortedObject(buckets),
			listItemFailures: {listItems: rows.filter(row => row.isListItem).reduce((total, row) => total + row.totalFailed, 0), nonListItems: rows.filter(row => !row.isListItem).reduce((total, row) => total + row.totalFailed, 0)},
			topFailing: failing.slice(0, TOP_FAILING_LIMIT).map(row => ({index: row.index, totalFailed: row.totalFailed, totalEvaluated: row.totalEvaluated, sourceChars: row.sourceChars, lengthBucket: row.lengthBucket, isListItem: row.isListItem, isHeading: row.isHeading, byArm: row.byArm})),
			rows
		};
	}
	return output;
}

function blankStructure() {
	return {trials: 0, wrappedInCodeFence: 0, terminalMarkerMissing: 0, terminalMarkerApplicable: 0, terminalMarkerNotLast: 0, terminalMarkerLastRecorded: 0, terminalMarkerNotLastDeduced: 0, leadingText: 0, trailingText: 0, trailingCharsTotal: 0, outsideText: 0, outsideMarkerCharsTotal: 0, closeMarkerEchoesTotal: 0, orderNotPreserved: 0, unknownMarkersTotal: 0, trialsWithUnknownMarkers: 0, trialsWithDuplicates: 0, trialsWithMissing: 0, missingIndicesTotal: 0, itemCountDelta: {min: null, max: null, mean: null, samples: 0}, responseWithoutCjk: 0};
}

// Results recorded before terminalMarkerLast existed can still reveal a terminal that was
// present and empty yet rejected by the parser: the only remaining parser condition is that
// another marker followed it, so that case is counted separately as deduced.
function terminalNotLastDeduced(trial, structure) {
	return trial.reason === "missing-terminal-marker"
		&& structure.terminalMarkerLast == null
		&& structure.terminalMarkerPresent === true
		&& count(structure.trailingChars) === 0
		&& !(Array.isArray(structure.missingMarkerIndices) && structure.missingMarkerIndices.length)
		&& !(Array.isArray(structure.duplicateMarkerIndices) && structure.duplicateMarkerIndices.length);
}

function addStructure(target, structure, deltas, trial = {}) {
	target.trials++;
	if (structure.wrappedInCodeFence === true) target.wrappedInCodeFence++;
	if (structure.terminalMarkerPresent != null) {target.terminalMarkerApplicable++; if (structure.terminalMarkerPresent === false) target.terminalMarkerMissing++;}
	if (structure.terminalMarkerLast != null) {target.terminalMarkerLastRecorded++; if (structure.terminalMarkerLast === false) target.terminalMarkerNotLast++;}
	if (terminalNotLastDeduced(trial, structure)) target.terminalMarkerNotLastDeduced++;
	if (count(structure.leadingChars) > 0) target.leadingText++;
	if (count(structure.trailingChars) > 0) target.trailingText++;
	target.trailingCharsTotal += count(structure.trailingChars);
	if (count(structure.outsideMarkerChars) > 0) target.outsideText++;
	target.outsideMarkerCharsTotal += count(structure.outsideMarkerChars);
	target.closeMarkerEchoesTotal += count(structure.closeMarkerEchoes);
	if (structure.orderPreserved === false) target.orderNotPreserved++;
	const unknown = count(structure.unknownMarkerCount);
	target.unknownMarkersTotal += unknown;
	if (unknown > 0) target.trialsWithUnknownMarkers++;
	if (Array.isArray(structure.duplicateMarkerIndices) && structure.duplicateMarkerIndices.length) target.trialsWithDuplicates++;
	if (Array.isArray(structure.missingMarkerIndices) && structure.missingMarkerIndices.length) {target.trialsWithMissing++; target.missingIndicesTotal += structure.missingMarkerIndices.length;}
	if (structure.responseHasCjk === false) target.responseWithoutCjk++;
	deltas.push(count(structure.receivedItemCount) - count(structure.expectedItemCount));
}

function finishStructure(target, deltas) {
	if (deltas.length) target.itemCountDelta = {min: Math.min(...deltas), max: Math.max(...deltas), mean: Math.round(deltas.reduce((total, value) => total + value, 0) / deltas.length * 1000) / 1000, samples: deltas.length};
	return target;
}

function structureSummary(trials) {
	const output = {};
	for (const arm of ARMS) {
		const armTrials = trials.filter(trial => trial.arm === arm && trial.structureDiagnostics && typeof trial.structureDiagnostics === "object");
		if (!armTrials.length) continue;
		const summary = blankStructure(), deltas = [], byFixture = {}, fixtureDeltas = {};
		for (const trial of armTrials) {
			addStructure(summary, trial.structureDiagnostics, deltas, trial);
			const fixture = byFixture[trial.fixtureId] || (byFixture[trial.fixtureId] = blankStructure());
			addStructure(fixture, trial.structureDiagnostics, fixtureDeltas[trial.fixtureId] || (fixtureDeltas[trial.fixtureId] = []), trial);
		}
		for (const fixtureId of Object.keys(byFixture)) finishStructure(byFixture[fixtureId], fixtureDeltas[fixtureId]);
		output[arm] = Object.assign(finishStructure(summary, deltas), {byFixture: sortedObject(byFixture)});
	}
	return output;
}

function fixtureGroups(measured) {
	const groups = {};
	for (const fixtureId of [...new Set(measured.map(trial => trial.fixtureId))].sort()) {
		const dTrials = measured.filter(trial => trial.arm === "whole-marker" && trial.fixtureId === fixtureId && Array.isArray(trial.segmentDiagnostics));
		const rangeCount = dTrials.length ? Math.max(...dTrials.map(trial => trial.segmentDiagnostics.length)) : null;
		const sourceChars = FIXTURE_SOURCE_CHARS[fixtureId] == null ? null : FIXTURE_SOURCE_CHARS[fixtureId];
		const long = (sourceChars != null && sourceChars >= LONG_SOURCE_CHARS) || (rangeCount != null && rangeCount >= LONG_RANGE_COUNT);
		groups[fixtureId] = {group: long ? "long-mixed" : "short", sourceChars, dRangeCount: rangeCount};
	}
	return groups;
}

function latencyStats(trials) {
	const values = trials.map(trial => trial.providerMs).filter(value => value != null).map(Number);
	return {samples: values.length, p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95), complete: values.length === trials.length};
}

function ratio(candidate, baseline) {return baseline == null || candidate == null || baseline <= 0 ? null : Math.round(candidate / baseline * 100000) / 100000;}
function improvement(baseline, candidate) {return baseline == null || candidate == null || baseline <= 0 ? null : Math.round((baseline - candidate) / baseline * 100000) / 1000;}

// Rulings 3 and 4 (2026-09-02) for D against A. Every gate is reported; passed is the AND.
function decideW2b(measured, groups) {
	const A = measured.filter(trial => trial.arm === "typed-json"), D = measured.filter(trial => trial.arm === "whole-marker");
	const fixtures = [...new Set([...A, ...D].map(trial => trial.fixtureId))].sort();
	const sameCoverage = fixtures.length > 0 && fixtures.every(id => A.filter(trial => trial.fixtureId === id).length === D.filter(trial => trial.fixtureId === id).length && D.some(trial => trial.fixtureId === id));
	const usageComplete = rows => rows.length > 0 && rows.every(trial => trial.promptTokens != null && trial.completionTokens != null);
	const sum = (rows, field) => rows.reduce((total, trial) => total + Number(trial[field] || 0), 0);
	const longIds = fixtures.filter(id => groups[id] && groups[id].group === "long-mixed"), shortIds = fixtures.filter(id => groups[id] && groups[id].group === "short");
	const inGroup = (rows, ids) => rows.filter(trial => ids.includes(trial.fixtureId));
	const latency = {
		all: {A: latencyStats(A), D: latencyStats(D)},
		longMixed: {fixtures: longIds, A: latencyStats(inGroup(A, longIds)), D: latencyStats(inGroup(D, longIds))},
		short: {fixtures: shortIds, A: latencyStats(inGroup(A, shortIds)), D: latencyStats(inGroup(D, shortIds))}
	};
	const ready = sameCoverage && usageComplete(A) && usageComplete(D) && latency.all.A.complete && latency.all.D.complete;
	const failingFixtures = fixtures.filter(id => D.some(trial => trial.fixtureId === id && !trialOk(trial)));
	const promptRatio = ratio(sum(D, "promptTokens"), sum(A, "promptTokens")), completionRatio = ratio(sum(D, "completionTokens"), sum(A, "completionTokens"));
	const p50LongImprovement = improvement(latency.longMixed.A.p50, latency.longMixed.D.p50);
	const p50ShortRatio = ratio(latency.short.D.p50, latency.short.A.p50);
	const p95Ratio = ratio(latency.all.D.p95, latency.all.A.p95);
	const gates = {
		correctness: {passed: D.length > 0 && failingFixtures.length === 0, rule: "D valid on 100% of trials in every fixture", failingFixtures, valid: D.filter(trialOk).length, total: D.length},
		protectedIntegrity: {passed: D.length > 0 && D.every(trial => trial.protectedIntegrity === "pass"), rule: "protected content byte-conserved in every D trial", failures: D.filter(trial => trial.protectedIntegrity !== "pass").length},
		markerStructure: {passed: D.length > 0 && D.every(trial => trial.structureDiagnostics && trial.structureDiagnostics.missingMarkerIndices.length === 0 && trial.structureDiagnostics.duplicateMarkerIndices.length === 0 && trial.structureDiagnostics.unknownMarkerCount === 0 && trial.structureDiagnostics.orderPreserved === true && trial.structureDiagnostics.receivedItemCount === trial.structureDiagnostics.expectedItemCount), rule: "marker count, order and mapping conserved in every D trial"},
		singleRequest: {passed: D.length > 0 && D.every(trial => trial.requestCount === 1), rule: "one physical request per clean message"},
		promptTokens: {passed: promptRatio != null && promptRatio <= 0.30, rule: "D prompt tokens <= 30% of A (all trials)", ratio: promptRatio, A: sum(A, "promptTokens"), D: sum(D, "promptTokens")},
		completionTokens: {passed: completionRatio != null && completionRatio <= 0.50, rule: "D completion tokens <= 50% of A (all trials)", ratio: completionRatio, A: sum(A, "completionTokens"), D: sum(D, "completionTokens")},
		p50LongMixed: {passed: longIds.length === 0 ? null : p50LongImprovement != null && p50LongImprovement >= 30, rule: "Provider P50 improves >= 30% on long/mixed fixtures", improvementPercent: p50LongImprovement, A: latency.longMixed.A.p50, D: latency.longMixed.D.p50, fixtures: longIds},
		p50Short: {passed: shortIds.length === 0 ? null : p50ShortRatio != null && p50ShortRatio <= 1.10, rule: "Provider P50 on short fixtures not worse than +10%", ratio: p50ShortRatio, A: latency.short.A.p50, D: latency.short.D.p50, fixtures: shortIds},
		p95All: {passed: p95Ratio != null && p95Ratio <= 1.10, rule: "Provider P95 across all fixtures not worse than +10%", ratio: p95Ratio, A: latency.all.A.p95, D: latency.all.D.p95},
		cost: {passed: null, rule: "token-derived cost; no unit price on the primary engine, informational only", value: null}
	};
	const blocking = ["correctness", "protectedIntegrity", "markerStructure", "singleRequest", "promptTokens", "completionTokens", "p50LongMixed", "p50Short", "p95All"];
	const failed = blocking.filter(name => gates[name].passed === false);
	const passed = ready && failed.length === 0;
	return {
		schemaVersion: DECISION_SCHEMA_VERSION,
		ready,
		passed,
		reason: !ready ? "not-ready" : failed.length ? `gate-failed:${failed.join(",")}` : "passed",
		eliminatedByCorrectness: ["correctness", "protectedIntegrity", "markerStructure"].some(name => gates[name].passed === false),
		coverage: {fixtures, sameCoverage, trialsA: A.length, trialsD: D.length},
		latency,
		gates
	};
}

// W2c ruling 3/4 (2026-09-03) for D against A (A = production P2 wire). Latency per trial is
// first answer plus repair when one was sent; token totals include repair requests. Every
// gate is reported; passed is the AND of the blocking gates, p50LongMixed is informational.
function decideW2c(measured, groups) {
	const A = measured.filter(trial => trial.arm === "typed-json"), D = measured.filter(trial => trial.arm === "whole-marker");
	const fixtures = [...new Set([...A, ...D].map(trial => trial.fixtureId))].sort();
	const sameCoverage = fixtures.length > 0 && fixtures.every(id => A.filter(trial => trial.fixtureId === id).length === D.filter(trial => trial.fixtureId === id).length && D.some(trial => trial.fixtureId === id));
	const structure = trial => trial.structureDiagnostics || {};
	const repaired = trial => structure(trial).repairRequested === true || count(trial.requestCount) > 1;
	const promptOf = trial => Number(trial.promptTokens || 0) + Number(structure(trial).repairPromptTokens || 0);
	const completionOf = trial => Number(trial.completionTokens || 0) + Number(structure(trial).repairCompletionTokens || 0);
	const totalMs = trial => trial.providerMs == null ? null : Number(trial.providerMs) + Number(structure(trial).repairProviderMs || 0);
	const usageComplete = rows => rows.length > 0 && rows.every(trial => trial.promptTokens != null && trial.completionTokens != null && (!repaired(trial) || (structure(trial).repairPromptTokens != null && structure(trial).repairCompletionTokens != null)));
	const stats = (rows, pick) => {const values = rows.map(pick).filter(value => value != null); return {samples: values.length, p50: values.length ? nearestRank(values, 0.5) : null, p95: values.length ? nearestRank(values, 0.95) : null, complete: values.length === rows.length && rows.length > 0};};
	const longIds = fixtures.filter(id => groups[id] && groups[id].group === "long-mixed"), shortIds = fixtures.filter(id => groups[id] && groups[id].group === "short");
	const inGroup = (rows, ids) => rows.filter(trial => ids.includes(trial.fixtureId));
	const latency = {
		all: {A: stats(A, trial => trial.providerMs), D: stats(D, totalMs), DFirstPass: stats(D, trial => trial.providerMs)},
		longMixed: {fixtures: longIds, A: stats(inGroup(A, longIds), trial => trial.providerMs), D: stats(inGroup(D, longIds), totalMs)},
		short: {fixtures: shortIds, A: stats(inGroup(A, shortIds), trial => trial.providerMs), D: stats(inGroup(D, shortIds), totalMs)},
		perFixture: Object.fromEntries(fixtures.map(id => [id, {A: stats(inGroup(A, [id]), trial => trial.providerMs), D: stats(inGroup(D, [id]), totalMs), p50ImprovementPercent: improvement(stats(inGroup(A, [id]), trial => trial.providerMs).p50, stats(inGroup(D, [id]), totalMs).p50)}]))
	};
	const ready = sameCoverage && usageComplete(A) && usageComplete(D) && latency.all.A.complete && latency.all.D.complete;
	const singleShotOk = trial => !repaired(trial) && trialOk(trial);
	const aValid = A.filter(trialOk).length, dSingle = D.filter(singleShotOk).length, dFinal = D.filter(trialOk).length, dRepaired = D.filter(repaired).length;
	const aRate = A.length ? aValid / A.length : null, dSingleRate = D.length ? dSingle / D.length : null;
	const promptRatio = ratio(D.reduce((sum, trial) => sum + promptOf(trial), 0), A.reduce((sum, trial) => sum + Number(trial.promptTokens || 0), 0));
	const completionRatio = ratio(D.reduce((sum, trial) => sum + completionOf(trial), 0), A.reduce((sum, trial) => sum + Number(trial.completionTokens || 0), 0));
	const p95Improvement = improvement(latency.all.A.p95, latency.all.D.p95), p95FirstPassImprovement = improvement(latency.all.A.p95, latency.all.DFirstPass.p95);
	const p50ShortRatio = ratio(latency.short.D.p50, latency.short.A.p50), p50LongImprovement = improvement(latency.longMixed.A.p50, latency.longMixed.D.p50);
	const failingAfterRepair = fixtures.filter(id => D.some(trial => trial.fixtureId === id && !trialOk(trial)));
	const gates = {
		singleShotNotBelowA: {passed: D.length > 0 && A.length > 0 && dSingleRate >= aRate, rule: "D first-answer valid rate >= A valid rate (same round)", D: {valid: dSingle, total: D.length, rate: dSingleRate}, A: {valid: aValid, total: A.length, rate: aRate}},
		validAfterRepair: {passed: D.length > 0 && failingAfterRepair.length === 0, rule: "D valid on 100% of trials after at most one repair", valid: dFinal, total: D.length, failingFixtures: failingAfterRepair},
		repairRate: {passed: D.length > 0 && dRepaired / D.length <= 0.05, rule: "repair requested on <= 5% of D trials", repaired: dRepaired, total: D.length, rate: D.length ? dRepaired / D.length : null},
		protectedIntegrity: {passed: D.length > 0 && D.every(trial => trial.protectedIntegrity === "pass"), rule: "protected content byte-conserved in every D trial; a first-answer placeholder mismatch is a failure repair cannot hide", failures: D.filter(trial => trial.protectedIntegrity !== "pass").length},
		markerStructure: {passed: D.length > 0 && D.every(trial => structure(trial).unknownMarkerCount === 0 && (structure(trial).duplicateMarkerIndices || []).length === 0 && structure(trial).orderPreserved === true && structure(trial).wrappedInCodeFence !== true), rule: "no unknown/duplicate/out-of-order marker and no code fence in any D answer (fail-closed, not repairable)"},
		singleRequest: {passed: D.length > 0 && D.every(trial => structure(trial).firstPassValid !== true || count(trial.requestCount) === 1), rule: "one physical request per clean message; repair counted separately", repairRequests: dRepaired},
		promptTokens: {passed: promptRatio != null && promptRatio <= 0.30, rule: "D prompt tokens (incl. repair) <= 30% of A (all trials)", ratio: promptRatio, A: A.reduce((sum, trial) => sum + Number(trial.promptTokens || 0), 0), D: D.reduce((sum, trial) => sum + promptOf(trial), 0)},
		completionTokens: {passed: completionRatio != null && completionRatio <= 0.50, rule: "D completion tokens (incl. repair) <= 50% of A (all trials)", ratio: completionRatio, A: A.reduce((sum, trial) => sum + Number(trial.completionTokens || 0), 0), D: D.reduce((sum, trial) => sum + completionOf(trial), 0)},
		p95All: {passed: p95Improvement != null && p95Improvement >= 30, rule: "P95 over all fixtures improves >= 30% (D latency = first answer + repair)", improvementPercent: p95Improvement, firstPassImprovementPercent: p95FirstPassImprovement, A: latency.all.A.p95, D: latency.all.D.p95, DFirstPass: latency.all.DFirstPass.p95},
		p50Short: {passed: shortIds.length === 0 ? null : p50ShortRatio != null && p50ShortRatio <= 1.10, rule: "short fixture P50 not worse than +10%", ratio: p50ShortRatio, A: latency.short.A.p50, D: latency.short.D.p50, fixtures: shortIds},
		p50LongMixed: {passed: null, informational: true, rule: "long/mixed P50 improvement >= 30% (informational: engine floor ~0.7-1.2 s, E1)", improvementPercent: p50LongImprovement, meets30: p50LongImprovement != null && p50LongImprovement >= 30, A: latency.longMixed.A.p50, D: latency.longMixed.D.p50, fixtures: longIds},
		cost: {passed: null, informational: true, rule: "token-derived cost; no unit price on the primary engine", value: null}
	};
	const blocking = ["singleShotNotBelowA", "validAfterRepair", "repairRate", "protectedIntegrity", "markerStructure", "singleRequest", "promptTokens", "completionTokens", "p95All", "p50Short"];
	const failed = blocking.filter(name => gates[name].passed === false);
	return {
		schemaVersion: W2C_DECISION_SCHEMA_VERSION,
		ready,
		passed: ready && failed.length === 0,
		reason: !ready ? "not-ready" : failed.length ? `gate-failed:${failed.join(",")}` : "passed",
		eliminatedByCorrectness: ["singleShotNotBelowA", "validAfterRepair", "repairRate", "protectedIntegrity", "markerStructure"].some(name => gates[name].passed === false),
		coverage: {fixtures, sameCoverage, trialsA: A.length, trialsD: D.length, repairedD: dRepaired},
		latency,
		gates
	};
}

function analyzeW2b0Results(inputs) {
	const list = Array.isArray(inputs) ? inputs.filter(input => input && input.result && typeof input.result === "object") : [];
	if (!list.length) throw new Error("no-results");
	const trials = collectTrials(list), measured = trials.filter(trial => !trial.warmup);
	const groups = fixtureGroups(measured);
	const byArmFixture = {}, byArm = {};
	for (const arm of ARMS) {
		const armTrials = measured.filter(trial => trial.arm === arm);
		if (!armTrials.length) continue;
		byArm[arm] = Object.assign({label: ARM_LABELS[arm]}, summarizeTrials(armTrials));
		byArmFixture[arm] = {};
		for (const fixtureId of [...new Set(armTrials.map(trial => trial.fixtureId))].sort()) byArmFixture[arm][fixtureId] = summarizeTrials(armTrials.filter(trial => trial.fixtureId === fixtureId));
	}
	const baselineTrials = measured.filter(trial => trial.arm === "typed-json");
	const baselineFixtures = {};
	for (const fixtureId of [...new Set(baselineTrials.map(trial => trial.fixtureId))].sort()) baselineFixtures[fixtureId] = summarizeTrials(baselineTrials.filter(trial => trial.fixtureId === fixtureId));
	return {
		schemaVersion: ANALYSIS_SCHEMA_VERSION,
		inputs: list.map(describeInput),
		trialCounts: {total: trials.length, warmup: trials.length - measured.length, measured: measured.length, withSegmentDiagnostics: measured.filter(trial => Array.isArray(trial.segmentDiagnostics) && trial.segmentDiagnostics.length).length, withStructureDiagnostics: measured.filter(trial => trial.structureDiagnostics).length},
		warmups: trials.filter(trial => trial.warmup).map(trial => ({source: trial.sourceLabel, trialId: count(trial.trialId), arm: trial.arm, fixtureId: trial.fixtureId, status: label(trial.status, "unknown"), reason: trial.reason == null ? null : label(trial.reason, "unknown"), valid: trial.valid === true, providerMs: nullableNumber(trial.providerMs), promptTokens: nullableNumber(trial.promptTokens), completionTokens: nullableNumber(trial.completionTokens)})),
		byArm,
		byArmFixture,
		segmentFailures: segmentTable(measured),
		structure: structureSummary(measured),
		baselineA: {fixtures: baselineFixtures, allClean: baselineTrials.length > 0 && baselineTrials.every(trialOk), total: baselineTrials.length, ok: baselineTrials.filter(trialOk).length},
		fixtureGroups: groups,
		decision: decideW2b(measured, groups),
		decisionW2c: decideW2c(measured, groups)
	};
}

function parseAnalysisArguments(argv) {
	const options = {results: [], outputPath: null, decisionPath: null, ruling: "w2c"};
	for (let index = 0; index < argv.length; index++) {
		const flag = String(argv[index]);
		const take = () => {
			if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) throw new Error(`argument-${flag.slice(2)}`);
			return String(argv[++index]);
		};
		if (flag === "--result") options.results.push(path.resolve(take()));
		else if (flag === "--output") options.outputPath = path.resolve(take());
		else if (flag === "--decision-output") options.decisionPath = path.resolve(take());
		else if (flag === "--ruling") {options.ruling = take(); if (!["w2b", "w2c"].includes(options.ruling)) throw new Error("argument-ruling");}
		else throw new Error("argument-unknown");
	}
	if (!options.results.length) throw new Error("argument-result");
	if (!options.outputPath) throw new Error("argument-output");
	return options;
}

function writeJsonOnce(filePath, value) {
	if (fs.existsSync(filePath)) throw new Error("output-exists");
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
}

function runW2b0Analysis(argv = []) {
	const options = parseAnalysisArguments(argv);
	const inputs = options.results.map(filePath => ({label: path.basename(filePath), result: JSON.parse(fs.readFileSync(filePath, "utf8"))}));
	const analysis = analyzeW2b0Results(inputs);
	if (fs.existsSync(options.outputPath) || (options.decisionPath && fs.existsSync(options.decisionPath))) throw new Error("output-exists");
	writeJsonOnce(options.outputPath, analysis);
	if (options.decisionPath) writeJsonOnce(options.decisionPath, Object.assign({inputs: analysis.inputs.map(input => input.label), ruling: options.ruling}, options.ruling === "w2b" ? analysis.decision : analysis.decisionW2c));
	return analysis;
}

if (require.main === module) {
	try {
		const analysis = runW2b0Analysis(process.argv.slice(2));
		process.stdout.write(`${JSON.stringify({schemaVersion: ANALYSIS_SCHEMA_VERSION, inputs: analysis.inputs.length, trials: analysis.trialCounts, arms: Object.keys(analysis.byArm), decision: {ready: analysis.decision.ready, passed: analysis.decision.passed, reason: analysis.decision.reason}})}\n`);
	}
	catch (error) {
		process.stdout.write(`${JSON.stringify({schemaVersion: ANALYSIS_SCHEMA_VERSION, status: "failed", reason: error && error.message || "unknown"})}\n`);
		process.exitCode = 1;
	}
}

module.exports = {ANALYSIS_SCHEMA_VERSION, DECISION_SCHEMA_VERSION, W2C_DECISION_SCHEMA_VERSION, analyzeW2b0Results, decideW2b, decideW2c, runW2b0Analysis};
