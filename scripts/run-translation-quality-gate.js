"use strict";

// Offline semantic quality gate: synthetic answers pass through the real protection,
// planner, validator, repair and language/similarity helpers. No provider is created or
// dispatched. Accepted/kept is runtime policy, not evidence of correct meaning.
// Usage: node scripts/run-translation-quality-gate.js --output <new-report.json>
// Exit 0: fixed-reference gate passes; 2: quality violations; 1: harness/integrity error.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {pathToFileURL} = require("node:url");
const {createPluginInstance} = require("../tests/helpers/createPluginInstance");
const {createProtectionLogic, MESSAGE_PLACES} = require("../src/protection/protection-logic");
const {createSemanticRequest, validateSemanticResponse, planSemanticRepair, attachSemanticLocalState} = require("../src/planner/translation-semantic-runtime");

const {planReceivedMarkdown} = require("../src/planner/received-markdown-lossless-planner");
const {buildWholeMarkerRequest, parseWholeMarkerResponse, reassembleWholeMarkerResponse} = require("../src/planner/translation-whole-marker-wire");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES_PATH = path.join(ROOT, "tests/fixtures/translation-quality-gate.json");
const OBSERVED_FIXTURES_PATH = path.join(ROOT, "tests/fixtures/observed-translation-regressions.json");
const SCHEMA_VERSION = "translation-quality-gate-v1";
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();

function classifyQuality(actual, fixture) {
	if (!actual.runtimeAccepted) return {category: "hard-failure", reason: actual.reason || "rejected"};
	if ((fixture.allowedKeeps || []).includes(actual.translation)) return {category: "reasonable-keep", reason: "explicit-fixture-permission"};
	if ((fixture.references || []).includes(actual.translation)) return {category: "genuine-translation", reason: "exact-fixed-reference"};
	return {category: "suspected-error", reason: actual.translation === fixture.source ? "source-echo" : (fixture.residualSourceFragments || []).some(fragment => actual.translation.includes(fragment)) ? "untranslated-fragment" : "meaning-mismatch"};
}

function sourceIdentity() {
	const files = [];
	function visit(relative) {
		for (const entry of fs.readdirSync(path.join(ROOT, relative), {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			const name = `${relative}/${entry.name}`;
			if (entry.isDirectory()) visit(name);
			else if (entry.isFile()) files.push({path: name, sha256: sha256(fs.readFileSync(path.join(ROOT, name)))});
		}
	}
	visit("src");
	return {sha256: sha256(Buffer.from(JSON.stringify(files))), files};
}

async function verifyRuntimeIdentity() {
	const before = sourceIdentity();
	const bundlePath = path.join(ROOT, "DiscordAITranslator.plugin.js");
	const bundle = fs.readFileSync(bundlePath);
	const {createPluginBundle} = await import(pathToFileURL(path.join(ROOT, "scripts/build-plugin.mjs")).href);
	const generated = Buffer.from(await createPluginBundle(), "utf8");
	const after = sourceIdentity();
	if (before.sha256 !== after.sha256 || !bundle.equals(generated) || !bundle.equals(fs.readFileSync(bundlePath))) throw new Error("runtime-identity-mismatch: source/bundle changed or bundle is stale");
	return {bundleSha256: sha256(bundle), bundleBuildId: (bundle.toString("utf8").match(/@buildId ([a-f0-9]+)/) || [])[1] || null, sourceTree: before, rebuiltBundleSha256: sha256(generated), bundleMatchesSource: true, harnessSha256: sha256(fs.readFileSync(path.join(ROOT, "tests/helpers/createPluginInstance.js"))), toolSha256: sha256(fs.readFileSync(__filename)), packageLockSha256: sha256(fs.readFileSync(path.join(ROOT, "package-lock.json")))};
}

function readFixtures() {
	const bytes = fs.readFileSync(FIXTURES_PATH), corpus = JSON.parse(bytes.toString("utf8"));
	if (corpus.schemaVersion !== "translation-quality-fixtures-v1" || corpus.targetLanguageId !== "zh-CN" || corpus.engineAdapter !== "oaicompat" || !Array.isArray(corpus.fixtures) || !corpus.fixtures.length) throw new Error("fixture-schema");
	const ids = new Set();
	for (const fixture of corpus.fixtures) {
		if (!fixture.id || ids.has(fixture.id) || typeof fixture.source !== "string" || !Array.isArray(fixture.expectedWireTexts) || !Array.isArray(fixture.references) || !Array.isArray(fixture.allowedKeeps) || !fixture.answer || !["accepted", "hard-failure"].includes(fixture.expectedDisposition)) throw new Error("fixture-row");
		if (fixture.allowedKeeps.length && !fixture.keepRationale) throw new Error("fixture-keep-permission");
		ids.add(fixture.id);
	}
	return {corpus, sha256: sha256(bytes)};
}


// Historical observed risks stay separate from deliberate fault injections and their
// exact-reference summary. These fixed bytes can replay protocol behavior, not certify
// meaning or judge a future arbitrary answer. Provenance paths are never opened here.
function validateObservedRegressions(corpus) {
	const fail = reason => {throw new Error("observed-fixture-" + reason);};
	const hashMatches = (text, hash) => typeof text === "string" && /^[A-F0-9]{64}$/.test(hash || "") && sha256(Buffer.from(text)) === hash;
	if (!corpus || corpus.schemaVersion !== "observed-translation-regressions-v1" || corpus.targetLanguageId !== "zh-CN" || corpus.inputLanguageId !== "en" || corpus.engineAdapter !== "oaicompat" || !Array.isArray(corpus.rows) || corpus.rows.length !== 4) fail("schema");
	if (!corpus.scope || corpus.scope.syntheticSourceOnly !== true || corpus.scope.actualHistoricalProviderResponses !== true || corpus.scope.newProviderRequests !== 0 || corpus.scope.aiReview !== true || corpus.scope.humanReview !== false || corpus.scope.professionalTranslationReview !== false || corpus.scope.arbitraryOutputEvaluator !== false || corpus.scope.passingReplayResolvesSemanticRisk !== false) fail("scope");
	const provenance = corpus.provenance;
	if (!provenance || provenance.pathsAreHistoricalMetadataOnly !== true || !provenance.review || !provenance.result || ![provenance.review.sha256, provenance.result.sha256, provenance.observedBundleSha256].every(hash => /^[A-F0-9]{64}$/.test(hash || "")) || !/^[a-f0-9]{16}$/.test(provenance.observedBundleBuildId || "") || !provenance.providerModel || !provenance.review.reviewer || !Array.isArray(provenance.selectedSequences)) fail("provenance");
	const ids = new Set();
	for (const [index, row] of corpus.rows.entries()) {
		if (!row.id || ids.has(row.id) || row.sequence !== index + 1 || row.sequence !== provenance.selectedSequences[index] || !row.fixtureId || !["typed", "canary"].includes(row.mode) || !["typed-json", "whole-marker"].includes(row.finalWireFamily)) fail("row");
		ids.add(row.id);
		if (!hashMatches(row.source, row.sourceSha256) || !hashMatches(row.output, row.outputSha256)) fail("content-hash");
		if (!Array.isArray(row.issues) || !row.issues.length || !Array.isArray(row.acceptableVariants) || !["high", "medium"].includes(row.confidence)) fail("review");
		if (!(row.verdict === "localized-semantic-error" && row.riskState === "open" || row.verdict === "terminology-ambiguity-needs-review" && row.riskState === "needs-review")) fail("risk-state");
		const settings = row.replaySettings, expected = row.expectedReplay, evidence = row.providerEvidence;
		if (!settings || ![settings.wordStart, settings.protectedTerms, settings.wrapperPairs].every(Array.isArray) || settings.protectedTermsForReceived !== true || settings.wrapperPairsForReceived !== true) fail("settings");
		if (!Array.isArray(evidence) || !evidence.length || evidence.length > 2 || !expected || expected.finalAccepted !== true || expected.keptCount !== 0 || !Array.isArray(expected.attemptAccepted) || !Array.isArray(expected.attemptReasons) || expected.attemptAccepted.length !== evidence.length || expected.attemptReasons.length !== evidence.length) fail("attempts");
		for (const [ordinal, attempt] of evidence.entries()) {
			if (attempt.physicalOrdinal !== ordinal + 1 || attempt.status !== 200 || !["typed-json", "whole-marker"].includes(attempt.wireFamily) || !Array.isArray(attempt.choices) || attempt.choices.length !== 1 || attempt.choices[0].index !== 0 || !hashMatches(attempt.choices[0].content, attempt.choices[0].contentSha256)) fail("response");
			if (typeof expected.attemptAccepted[ordinal] !== "boolean" || expected.attemptReasons[ordinal] !== null && expected.attemptReasons[ordinal] !== "duplicate-marker") fail("attempt-expectation");
		}
		if (evidence.at(-1).wireFamily !== row.finalWireFamily || row.mode === "typed" && (evidence.length !== 1 || row.finalWireFamily !== "typed-json") || row.mode === "canary" && evidence[0].wireFamily !== "whole-marker") fail("route");
		if (evidence.length === 2 && (evidence[1].wireFamily !== "typed-json" || expected.attemptAccepted[0] !== false || expected.attemptReasons[0] !== "duplicate-marker")) fail("fallback-route");
		if (!row.accounting || row.accounting.actualPhysicalRequests !== evidence.length || row.accounting.applicationCalls !== evidence.length || row.accounting.canaryTypedFallbacks !== evidence.length - 1) fail("accounting");
	}
	return corpus;
}

function readObservedRegressions() {
	const bytes = fs.readFileSync(OBSERVED_FIXTURES_PATH);
	return {corpus: validateObservedRegressions(JSON.parse(bytes.toString("utf8"))), sha256: sha256(bytes)};
}

function replayObservedRegressions(plugin, protectionLogic, corpus) {
	validateObservedRegressions(corpus);
	const originalExceptions = plugin.settings.exceptions;
	const rows = [];
	try {
		for (const row of corpus.rows) {
			plugin.settings.exceptions = Object.assign({}, originalExceptions, structuredClone(row.replaySettings));
			const protection = protectionLogic.prepareSemanticSource(plugin, row.source, MESSAGE_PLACES.RECEIVED);
			// Captured replies belong to the pre-format wire. Preserve that request contract
			// and the literal bad outputs; this replay must never rewrite historical evidence.
			const request = createSemanticRequest({engineKey: corpus.engineAdapter, source: protection.source, direction: "received", fieldPath: "body", inputLanguageId: corpus.inputLanguageId, targetLanguageId: corpus.targetLanguageId, maxAttempts: 3, inlineFormatting: false});
			if (!request.enabled) throw new Error("observed-planning-disabled: " + row.id);
			attachSemanticLocalState(request, {protectedSegments: protection.protectedSegments, cachePlanHash: sha256(Buffer.from(row.source))});
			const judge = {likelyTarget: text => plugin.isTranslationLikelyInTargetLanguage(text, corpus.targetLanguageId), similarity: (source, text) => plugin.getTextSimilarityScore(source, text), maxSimilarity: 0.94};
			const attempts = [];
			let translation = null, keptCount = 0;
			for (const attempt of row.providerEvidence) {
				const raw = attempt.choices[0].content;
				let outcome;
				if (attempt.wireFamily === "typed-json") {
					outcome = validateSemanticResponse(request, raw, judge);
					keptCount = outcome.keptCount;
					translation = outcome.ok ? protectionLogic.addSemanticExceptions(plugin, outcome.translation, protection.protectedSegments) : null;
				}
				else {
					const plan = planReceivedMarkdown(protection.source, {direction: "received", fieldPath: "body", targetLanguageId: corpus.targetLanguageId});
					const whole = buildWholeMarkerRequest(plan, protection.protectedSegments, {targetLanguageId: corpus.targetLanguageId});
					if (!whole.ok) throw new Error("observed-D-planning-disabled: " + row.id);
					outcome = parseWholeMarkerResponse(whole, raw, judge);
					translation = outcome.ok ? protectionLogic.addSemanticExceptions(plugin, reassembleWholeMarkerResponse(whole, outcome.valid), whole.protectedSegments) : null;
				}
				attempts.push({physicalOrdinal: attempt.physicalOrdinal, wireFamily: attempt.wireFamily, responseSha256: attempt.choices[0].contentSha256, runtimeAccepted: outcome.ok, reason: outcome.reason || null});
			}
			const expected = row.expectedReplay;
			if (translation !== row.output || keptCount !== expected.keptCount || attempts.some((attempt, index) => attempt.runtimeAccepted !== expected.attemptAccepted[index] || attempt.reason !== expected.attemptReasons[index])) throw new Error("observed-replay-drift: " + row.id);
			rows.push({...row, replay: {runtimeAccepted: attempts.at(-1).runtimeAccepted, finalWireFamily: attempts.at(-1).wireFamily, outputSha256: sha256(Buffer.from(translation)), outputMatchesObserved: true, keptCount, attempts, semanticRiskResolved: false}});
		}
	}
	finally {plugin.settings.exceptions = originalExceptions;}
	return {status: "known-semantic-risks-open", scope: {...corpus.scope, pureProtocolReplayOnly: true, liveCanaryOrDisplayExercised: false}, provenance: corpus.provenance, summary: {total: rows.length, open: rows.filter(row => row.riskState === "open").length, needsReview: rows.filter(row => row.riskState === "needs-review").length, resolved: 0, historicalPhysicalResponses: rows.reduce((sum, row) => sum + row.providerEvidence.length, 0), replayedFinalOutputs: rows.length}, rows};
}

function syntheticAnswer(request, answer) {
	if (answer.kind === "malformed") return "synthetic broken response {";
	if (answer.kind === "missing") return {segments: []};
	if (!["translations", "duplicate"].includes(answer.kind)) throw new Error("fixture-answer-kind");
	const wire = JSON.parse(request.wire);
	const rows = wire.segments.map(segment => {
		if (!Object.prototype.hasOwnProperty.call(answer.translationsBySource || {}, segment.text)) throw new Error(`fixture-answer-missing: ${segment.text}`);
		return {id: segment.id, translation: answer.translationsBySource[segment.text]};
	});
	if (answer.kind === "duplicate" && rows.length) rows.push({...rows[0]});
	return {segments: rows};
}

function runFixture(plugin, protectionLogic, fixture, corpus) {
	const protection = protectionLogic.prepareSemanticSource(plugin, fixture.source, MESSAGE_PLACES.RECEIVED);
	const request = createSemanticRequest({engineKey: corpus.engineAdapter, source: protection.source, direction: "received", fieldPath: fixture.fieldPath, targetLanguageId: corpus.targetLanguageId, maxAttempts: 3});
	if (!request.enabled) throw new Error(`fixture-planning-disabled: ${fixture.id}`);
	attachSemanticLocalState(request, {protectedSegments: protection.protectedSegments, cachePlanHash: sha256(Buffer.from(fixture.source))});
	const wire = JSON.parse(request.wire);
	if (JSON.stringify(wire.segments.map(segment => segment.text)) !== JSON.stringify(fixture.expectedWireTexts)) throw new Error(`fixture-plan-drift: ${fixture.id}`);
	const judge = {likelyTarget: text => plugin.isTranslationLikelyInTargetLanguage(text, corpus.targetLanguageId), similarity: (source, text) => plugin.getTextSimilarityScore(source, text), maxSimilarity: 0.94};
	let active = request, priorValid = {}, outcome, repairCount = 0, repairStopReason = null;
	const attempts = [];
	for (;;) {
		const response = syntheticAnswer(active, fixture.answer);
		outcome = validateSemanticResponse(active, response, {...judge, priorValid});
		attempts.push({attempt: active.attempt, segmentCount: active.segmentOrder.length, runtimeAccepted: outcome.ok, reason: outcome.reason, keptCount: outcome.keptCount, keptReasons: outcome.keptReasons, invalidIds: outcome.invalidIds, response});
		if (outcome.ok) break;
		const repair = planSemanticRepair(active, outcome, {parentSettled: true, maxItems: 10, maxChars: 12000});
		if (!repair.dispatchable) {repairStopReason = repair.reason; break;}
		if (repair.requests.length !== 1 || repairCount >= 2) throw new Error(`fixture-repair-shape: ${fixture.id}`);
		active = repair.requests[0]; priorValid = outcome.valid; repairCount++;
	}
	const translation = outcome.ok ? protectionLogic.addSemanticExceptions(plugin, outcome.translation, protection.protectedSegments) : null;
	const actual = {runtimeAccepted: outcome.ok, reason: outcome.reason, translation};
	const quality = classifyQuality(actual, fixture);
	const violations = [];
	if (quality.category === "suspected-error") violations.push(quality.reason);
	if (!outcome.ok && fixture.expectedDisposition !== "hard-failure") violations.push("unexpected-hard-failure");
	if (outcome.ok && fixture.expectedDisposition === "hard-failure") violations.push("hard-failure-injection-accepted");
	return {id: fixture.id, fieldPath: fixture.fieldPath, compiledFieldPath: request.plan.fieldPath, fieldCoverageMode: fixture.fieldCoverage ? "synthetic-combined-request-text" : "semantic-field-path", fieldCoverage: fixture.fieldCoverage || [fixture.fieldPath], source: fixture.source, references: fixture.references, allowedKeeps: fixture.allowedKeeps, keepRationale: fixture.keepRationale || null, injection: fixture.injection || null, expectedDisposition: fixture.expectedDisposition, sourceSha256: sha256(Buffer.from(fixture.source)), segmentCount: request.segmentOrder.length, protectedCount: protection.placeholderCount, ...actual, keptCount: outcome.keptCount, keptReasons: outcome.keptReasons, repairCount, repairStopReason, quality, violations, attempts};
}

async function runQualityGate() {
	const identity = await verifyRuntimeIdentity(), {corpus, sha256: fixturesSha256} = readFixtures(), observed = readObservedRegressions();
	const savedGlobals = new Map(["window", "BdApi", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let networkAttempts = 0, settingsWriteAttempts = 0, rows, observedRegressions;
	const rejectNetwork = () => {networkAttempts++; throw new Error("offline-network-attempt");};
	try {
		globalThis.fetch = rejectNetwork;
		const plugin = createPluginInstance({settings: {engines: {translator: "oaicompat", backup: "----"}, choices: {received: {input: "auto", output: "zh-CN"}}}, bdfdb: {DataUtils: {load: () => ({}), save: () => {settingsWriteAttempts++; throw new Error("offline-settings-write");}}, LibraryRequires: {request: rejectNetwork}}});
		globalThis.BdApi.Net = {fetch: rejectNetwork};
		const protectionLogic = createProtectionLogic();
		rows = corpus.fixtures.map(fixture => runFixture(plugin, protectionLogic, fixture, corpus));
		observedRegressions = replayObservedRegressions(plugin, protectionLogic, observed.corpus);
	}
	finally {
		for (const [key, descriptor] of savedGlobals) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}
	}
	if (networkAttempts || settingsWriteAttempts) throw new Error("offline-boundary-violation");
	if (identity.sourceTree.sha256 !== sourceIdentity().sha256 || identity.bundleSha256 !== sha256(fs.readFileSync(path.join(ROOT, "DiscordAITranslator.plugin.js"))) || fixturesSha256 !== sha256(fs.readFileSync(FIXTURES_PATH)) || observed.sha256 !== sha256(fs.readFileSync(OBSERVED_FIXTURES_PATH))) throw new Error("inputs-changed-during-run");
	const summary = summarizeResults(rows);
	return {schemaVersion: SCHEMA_VERSION, mode: "offline-synthetic-quality-gate", status: summary.violationCount ? "quality-violations" : "passed", exitCode: summary.violationCount ? 2 : 0, scope: {providerRequests: 0, installedPluginAccessed: false, userConfigurationAccessed: false, measuresProductionOmissionRate: false, measuresLatency: false, coversTerminalCancellationOrStaleCommit: false, explanation: "The original summary covers AI-authored fixed references and deliberate faults only; observedRegressions separately replays historical synthetic provider responses with frozen AI review. No independent human review is claimed. Runtime acceptance is not semantic correctness. Exact reference mismatch is a fixture quality signal, not a universal translation evaluator. No live client/render/cache/transport acceptance is claimed."}, identity, fixtures: {path: "tests/fixtures/translation-quality-gate.json", sha256: fixturesSha256, provenance: corpus.provenance}, integrity: {networkAttempts, settingsWriteAttempts}, summary, rows, observedRegressions: {...observedRegressions, fixtures: {path: "tests/fixtures/observed-translation-regressions.json", sha256: observed.sha256}}};
}

function summarizeResults(rows) {
	const summary = {total: rows.length, runtimeAccepted: 0, runtimeRejected: 0, runtimeAcceptedWithKept: 0, runtimeAcceptedWithoutKept: 0, keptCount: 0, repairCount: 0, qualityCategories: {"genuine-translation": 0, "reasonable-keep": 0, "suspected-error": 0, "hard-failure": 0}, violationCount: 0};
	for (const row of rows) {
		summary[row.runtimeAccepted ? "runtimeAccepted" : "runtimeRejected"]++;
		if (row.runtimeAccepted) summary[row.keptCount > 0 ? "runtimeAcceptedWithKept" : "runtimeAcceptedWithoutKept"]++;
		summary.keptCount += row.keptCount; summary.repairCount += row.repairCount;
		summary.qualityCategories[row.quality.category]++;
		if (row.violations.length) summary.violationCount++;
	}
	return summary;
}

function parseArguments(argv) {
	if (argv.length !== 2 || argv[0] !== "--output" || !argv[1] || argv[1].startsWith("--")) throw new Error("usage: --output <new-report.json>");
	return {outputPath: path.resolve(argv[1])};
}

function writeReport(report, outputPath) {
	// Exclusive creation is intentional: prior evidence is never silently replaced.
	const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
	fs.writeFileSync(outputPath, bytes, {flag: "wx"});
	const saved = fs.readFileSync(outputPath);
	if (!saved.equals(bytes) || JSON.parse(saved.toString("utf8")).schemaVersion !== SCHEMA_VERSION) throw new Error("report-readback-mismatch");
	return {path: outputPath, sha256: sha256(saved), bytes: saved.length};
}

async function main(argv) {
	const {outputPath} = parseArguments(argv);
	if (fs.existsSync(outputPath)) throw new Error("output-exists");
	const report = await runQualityGate();
	return {report, artifact: writeReport(report, outputPath)};
}

if (require.main === module) main(process.argv.slice(2)).then(({report, artifact}) => {process.stdout.write(`${JSON.stringify({status: report.status, exitCode: report.exitCode, summary: report.summary, artifact}, null, 2)}\n`); process.exitCode = report.exitCode;}, error => {process.stderr.write(`${error && error.message || error}\n`); process.exitCode = 1;});
module.exports = {validateObservedRegressions, readObservedRegressions, replayObservedRegressions, SCHEMA_VERSION, classifyQuality, summarizeResults, runQualityGate, parseArguments, writeReport, main};
