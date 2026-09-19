"use strict";

// P3 real-provider probe: sends the production typed-json wire (arm A) for the P3 fixtures to the
// configured primary engine, read-only, and judges every first answer twice: strictly (the P2
// verdict, softKeep:false) and with the P3 soft-keep policy. When P3 still needs a repair, the
// one repair P3 allows is dispatched and judged the same two ways. Nothing but counts, reasons,
// segment indices, byte sizes, latencies and token usage is written; no message text, no
// endpoint, no model name, no key.
//
//   node scripts/run-p3-soft-validation-probe.js --preflight --output <file.json>
//   node scripts/run-p3-soft-validation-probe.js --run --output <file.json> [--max-requests 30]

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {HarnessError, defaultPaths, readConfiguration, hashFile, createReadOnlyRuntime} = require("./run-w2-provider-benchmark");
const {createProtectionLogic, MESSAGE_PLACES} = require("../src/protection/protection-logic");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair, attachSemanticLocalState} = require("../src/planner/translation-semantic-runtime");
const {isSoftReason} = require("../src/planner/translation-soft-validation");
const {P3_FIXTURES, requestTextFor} = require("../tests/fixtures/p3-soft-validation-fixtures");
const {W2_ALL_FIXTURES} = require("../src/diagnostics/w2-wire-benchmark-fixtures");

const PROBE_SCHEMA_VERSION = "p3-soft-validation-probe-1";
const DEFAULT_MAX_REQUESTS = 30;
const PLANS = Object.freeze({
	main: Object.freeze([
		{id: "f14-forward-embed-title-footer", samples: 6},
		{id: "f15-channel-name-line-with-link", samples: 6},
		{id: "f05-protection-composite", samples: 2},
		{id: "f01-exact-academic", samples: 2}
	]),
	// Second batch, field-shaped: title+footer-only embed and a bare channel name.
	field: Object.freeze([
		{id: "f19-embed-title-footer-only", samples: 4},
		{id: "f20-channel-name-only", samples: 4}
	]),
	// Third batch: f19 again with one request compiled per sample (see the record).
	field2: Object.freeze([{id: "f19-embed-title-footer-only", samples: 4}])
});
const PLAN = PLANS.main;
const sha256 = value => crypto.createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex").toUpperCase();
const likelyTarget = value => /[\p{Script=Han}\p{Script=Bopomofo}]/u.test(String(value || ""));
const similarity = (source, target) => String(source || "").trim() === String(target || "").trim() ? 1 : 0;
const JUDGE = {likelyTarget, similarity, maxSimilarity: 0.94};

function parseArguments(argv) {
	const options = {mode: null, outputPath: null, maxRequests: DEFAULT_MAX_REQUESTS, engineKey: null, plan: "main"};
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--preflight" || flag === "--run") options.mode = flag.slice(2);
		else if (flag === "--output") options.outputPath = path.resolve(String(argv[++index] || ""));
		else if (flag === "--max-requests") options.maxRequests = Math.max(1, Math.min(DEFAULT_MAX_REQUESTS, Number(argv[++index]) || DEFAULT_MAX_REQUESTS));
		else if (flag === "--engine") options.engineKey = String(argv[++index] || "");
		else if (flag === "--plan") {options.plan = String(argv[++index] || ""); if (!PLANS[options.plan]) throw new HarnessError("argument");}
		else throw new HarnessError("argument");
	}
	if (!options.mode || !options.outputPath) throw new HarnessError("argument");
	return options;
}

function sourceFor(id) {
	const p3 = P3_FIXTURES.find(row => row.id === id);
	if (p3) return {id, source: requestTextFor(p3), targetLanguageId: "zh-CN", corpus: "p3"};
	const w2 = W2_ALL_FIXTURES.find(row => row.id === id);
	if (w2) return {id, source: w2.source, targetLanguageId: w2.targetLanguageId, corpus: "w2"};
	throw new HarnessError("fixture");
}

function compileFixture(fixture, engineKey) {
	const settings = {wordStart: ["!"], protectedTerms: [], wrapperPairs: [], protectedTermsForReceived: true, wrapperPairsForReceived: true};
	const plugin = {settings: {exceptions: settings}, getProtectedWrapperRules() {return [];}};
	const logic = createProtectionLogic();
	const protection = logic.prepareSemanticSource(plugin, fixture.source, MESSAGE_PLACES.RECEIVED);
	const request = createSemanticRequest({engineKey, source: protection.source, direction: "received", fieldPath: "body", inputLanguageId: "auto", targetLanguageId: fixture.targetLanguageId, attempt: 1, maxAttempts: 3});
	if (!request || !request.enabled) throw new HarnessError("capability-unverified");
	attachSemanticLocalState(request, {protectedSegments: protection.protectedSegments, cachePlanHash: "probe"});
	return {request, protection, segmentCount: request.segmentOrder.length, bodyBytes: request.bodyBytes, promptBytes: Buffer.byteLength(request.systemPrompt), estimatedTokens: request.estimatedTokens};
}

function indexOf(request, id) {return request.rootSegmentOrder.indexOf(id);}

function judge(request, text, priorValid, priorStrictValid) {
	const soft = validateSemanticResponse(request, text, Object.assign({priorValid}, JUDGE));
	const strict = validateSemanticResponse(request, text, Object.assign({priorValid: priorStrictValid, softKeep: false}, JUDGE));
	const invalid = (strict.validation && strict.validation.invalid || []).map(row => ({index: indexOf(request, row.id), reason: row.reason}));
	return {
		soft: {ok: soft.ok, reason: soft.reason, keptCount: soft.keptCount, keptReasons: soft.keptReasons, keptIndices: Object.keys(soft.kept || {}).map(id => indexOf(request, id)).sort((a, b) => a - b), remainingIndices: soft.invalidIds.map(id => indexOf(request, id)).sort((a, b) => a - b), valid: soft.valid},
		strict: {ok: strict.ok, reason: strict.reason, invalid, softFailedCount: invalid.filter(row => isSoftReason(row.reason)).length, hardFailedCount: invalid.filter(row => !isSoftReason(row.reason)).length, valid: strict.valid},
		softOutcome: soft,
		strictOutcome: strict
	};
}

function stripValid(view) {return {ok: view.ok, reason: view.reason, keptCount: view.keptCount, keptReasons: view.keptReasons, keptIndices: view.keptIndices, remainingIndices: view.remainingIndices, invalid: view.invalid, softFailedCount: view.softFailedCount, hardFailedCount: view.hardFailedCount};}

async function main(argv) {
	const options = parseArguments(argv);
	const paths = defaultPaths();
	const configuration = readConfiguration(paths.config), configBefore = configuration.sha256, installedBefore = hashFile(paths.installed);
	const engineKey = options.engineKey || String(configuration.all.engines.translator || "");
	if (!engineKey || engineKey === "----") throw new HarnessError("configuration");
	const fixtures = PLANS[options.plan].map(row => Object.assign({}, sourceFor(row.id), {samples: row.samples}));
	const compiled = fixtures.map(fixture => Object.assign({}, fixture, compileFixture(fixture, engineKey)));
	const firstRequests = compiled.reduce((total, row) => total + row.samples, 0);
	const preview = {
		schemaVersion: PROBE_SCHEMA_VERSION,
		mode: options.mode,
		plan: options.plan,
		engineKeyDigest: `ek1:${sha256(engineKey).slice(0, 16)}`,
		configSha256: configBefore,
		installedSha256: installedBefore,
		maxRequests: options.maxRequests,
		firstRequests,
		repairBudget: Math.max(0, options.maxRequests - firstRequests),
		fixtures: compiled.map(row => ({id: row.id, corpus: row.corpus, samples: row.samples, segmentCount: row.segmentCount, bodyBytes: row.bodyBytes, promptBytes: row.promptBytes, estimatedTokens: row.estimatedTokens, sourceSha256: sha256(row.source)}))
	};
	if (options.mode === "preflight") {
		fs.mkdirSync(path.dirname(options.outputPath), {recursive: true});
		fs.writeFileSync(options.outputPath, `${JSON.stringify(preview, null, 2)}\n`, {flag: "wx"});
		return preview;
	}
	const fetchFunction = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
	if (!fetchFunction) throw new HarnessError("fetch-unavailable");
	const runtime = createReadOnlyRuntime(configuration.all, {fetchFunction});
	const session = runtime.providerClient.createWireExperimentSession(engineKey, {maxRequests: options.maxRequests, maxOutputTokens: 4096, maxBodyBytes: 65536});
	let physicalRequests = 0, repairRequests = 0;
	const trials = [];
	const canDispatch = () => physicalRequests < options.maxRequests;
	const startedAt = Date.now();
	try {
		for (const row of compiled) {
			for (let sample = 0; sample < row.samples; sample++) {
				if (!canDispatch()) break;
				// One request object per sample: kept state accumulates per message (root plan) across
				// repair rounds, so a reused request would carry one sample's kept ids into the next.
				const fresh = compileFixture(row, engineKey), request = fresh.request;
				const trial = {fixtureId: row.id, sample: sample + 1, segmentCount: row.segmentCount, requestCount: 0, first: null, repair: null, p3: null, p2: null};
				const provider = await session.dispatch({systemPrompt: request.systemPrompt, userPrompt: request.wire, wireObservation: {wireFamily: "typed-json", wireVersion: request.semanticRevision, wireBytes: request.bodyBytes, segmentCount: row.segmentCount}});
				physicalRequests++; trial.requestCount++;
				if (!provider || !provider.ok) {trial.first = {ok: false, providerReason: provider && provider.reason || "provider", providerMs: provider && provider.providerMs || null}; trial.p3 = {finalOk: false, reason: "provider"}; trial.p2 = {firstOk: false, reason: "provider"}; trials.push(trial); continue;}
				const first = judge(request, provider.text, {}, {});
				trial.first = Object.assign({providerMs: provider.providerMs, promptTokens: provider.usage && provider.usage.promptTokens, completionTokens: provider.usage && provider.usage.completionTokens}, {soft: stripValid(first.soft), strict: stripValid(first.strict)});
				trial.p2 = {firstOk: first.strict.ok, firstReason: first.strict.reason, wouldRepair: !first.strict.ok};
				if (first.soft.ok) {trial.p3 = {finalOk: true, repairs: 0, keptCount: first.soft.keptCount, keptReasons: first.soft.keptReasons, path: first.soft.keptCount > 0 ? "kept-first-answer" : "clean"}; trials.push(trial); continue;}
				const repairPlan = planSemanticRepair(request, first.softOutcome, {parentSettled: true, maxItems: 10, maxChars: 12000});
				if (!repairPlan.dispatchable || repairPlan.requests.length !== 1 || !canDispatch()) {trial.p3 = {finalOk: false, repairs: 0, reason: !canDispatch() ? "attempt-budget" : repairPlan.reason, path: "no-repair-available"}; trials.push(trial); continue;}
				const repairRequest = repairPlan.requests[0];
				const repairProvider = await session.dispatch({systemPrompt: repairRequest.systemPrompt, userPrompt: repairRequest.wire, wireObservation: {wireFamily: "typed-json", wireVersion: repairRequest.semanticRevision, wireBytes: repairRequest.bodyBytes, segmentCount: repairRequest.segmentOrder.length}});
				physicalRequests++; repairRequests++; trial.requestCount++;
				if (!repairProvider || !repairProvider.ok) {trial.repair = {ok: false, providerReason: repairProvider && repairProvider.reason || "provider"}; trial.p3 = {finalOk: false, repairs: 1, reason: "provider", path: "repair-provider-failed"}; trials.push(trial); continue;}
				const second = judge(repairRequest, repairProvider.text, first.soft.valid, first.strict.valid);
				trial.repair = Object.assign({segmentCount: repairRequest.segmentOrder.length, providerMs: repairProvider.providerMs, promptTokens: repairProvider.usage && repairProvider.usage.promptTokens, completionTokens: repairProvider.usage && repairProvider.usage.completionTokens}, {soft: stripValid(second.soft), strict: stripValid(second.strict)});
				trial.p3 = {finalOk: second.soft.ok, repairs: 1, keptCount: second.soft.keptCount, keptReasons: second.soft.keptReasons, reason: second.soft.ok ? null : second.soft.reason, path: second.soft.ok ? (second.soft.keptCount > 0 ? "kept-after-one-repair" : "repaired") : "hard-failure-after-repair"};
				trial.p2 = Object.assign(trial.p2, {afterOneRepairOk: second.strict.ok, afterOneRepairReason: second.strict.reason, wouldRepairAgain: !second.strict.ok});
				trials.push(trial);
			}
		}
	}
	finally {try {session.cancel("p3-probe-done");} catch {} try {await runtime.drain();} catch {}}
	const metrics = runtime.metrics();
	const byFixture = {};
	for (const trial of trials) {
		const row = byFixture[trial.fixtureId] || (byFixture[trial.fixtureId] = {samples: 0, providerFailures: 0, firstSoftFailed: 0, firstHardFailed: 0, firstClean: 0, segmentsSoftFailedFirst: 0, keptFirstAnswer: 0, p3Repairs: 0, p3FinalOk: 0, p3KeptTotal: 0, p2FirstFailed: 0, p2StillFailedAfterOneRepair: 0, requests: 0});
		row.samples++; row.requests += trial.requestCount;
		if (!trial.first || trial.first.ok === false) {row.providerFailures++; continue;}
		if (trial.first.strict.ok) row.firstClean++;
		if (trial.first.strict.softFailedCount > 0) {row.firstSoftFailed++; row.segmentsSoftFailedFirst += trial.first.strict.softFailedCount;}
		if (trial.first.strict.hardFailedCount > 0) row.firstHardFailed++;
		if (trial.first.soft.keptCount > 0 && trial.p3 && trial.p3.repairs === 0) row.keptFirstAnswer++;
		if (trial.p3) {row.p3Repairs += trial.p3.repairs || 0; if (trial.p3.finalOk) row.p3FinalOk++; row.p3KeptTotal += trial.p3.keptCount || 0;}
		if (trial.p2) {if (!trial.p2.firstOk) row.p2FirstFailed++; if (trial.p2.wouldRepairAgain) row.p2StillFailedAfterOneRepair++;}
	}
	const result = Object.assign({}, preview, {
		mode: "run",
		status: metrics.settingsWriteAttemptCount === 0 && metrics.callbackRequestCount === 0 ? "complete" : "failed",
		durationMs: Date.now() - startedAt,
		physicalRequests, repairRequests, hardRequestCap: options.maxRequests,
		integrity: {configBefore, configAfter: readConfiguration(paths.config).sha256, installedBefore, installedAfter: hashFile(paths.installed), settingsWriteAttempts: metrics.settingsWriteAttemptCount, callbackRequests: metrics.callbackRequestCount, transportPhysicalRequests: metrics.physicalRequestCount},
		byFixture,
		trials
	});
	fs.mkdirSync(path.dirname(options.outputPath), {recursive: true});
	fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, {flag: "wx"});
	return result;
}

if (require.main === module) main(process.argv.slice(2)).then(result => {process.stdout.write(`${JSON.stringify({mode: result.mode, status: result.status || "ready", physicalRequests: result.physicalRequests || 0, repairRequests: result.repairRequests || 0, byFixture: result.byFixture || null}, null, 2)}\n`); process.exit(0);}, error => {console.error(error && error.message || error); process.exit(1);});
module.exports = {PROBE_SCHEMA_VERSION, PLAN, PLANS, parseArguments, main};
