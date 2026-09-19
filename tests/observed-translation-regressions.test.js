"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {createPluginInstance} = require("./helpers/createPluginInstance");
const {createProtectionLogic} = require("../src/protection/protection-logic");
const {validateObservedRegressions, readObservedRegressions, replayObservedRegressions} = require("../scripts/run-translation-quality-gate");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const load = () => readObservedRegressions().corpus;
function withPlugin(action) {
	const saved = new Map(["window", "BdApi", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	let networkAttempts = 0, settingsWrites = 0;
	const rejectNetwork = () => {networkAttempts++; throw new Error("observed-test-network");};
	try {
		globalThis.fetch = rejectNetwork;
		const plugin = createPluginInstance({settings: {engines: {translator: "oaicompat", backup: "----"}, choices: {received: {input: "en", output: "zh-CN"}}}, bdfdb: {DataUtils: {load: () => ({}), save: () => {settingsWrites++; throw new Error("observed-test-settings-write");}}, LibraryRequires: {request: rejectNetwork}}});
		globalThis.BdApi.Net = {fetch: rejectNetwork};
		const result = action(plugin);
		assert.equal(networkAttempts, 0); assert.equal(settingsWrites, 0);
		return result;
	}
	finally {for (const [key, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}}
}
const replay = (plugin, corpus = load()) => replayObservedRegressions(plugin, createProtectionLogic(), corpus);

test("observed corpus is an exact self-contained four-row copy with independently pinned historical provenance", () => {
	const {corpus, sha256} = readObservedRegressions();
	// Only private provenance locations/reviewer metadata were anonymized; row hashes stay pinned below.
	assert.equal(sha256, "EC36ED822B1003EA333B9C141856EEF61F0F8B1EF45C0346A82DEF71D606D6CA");
	assert.equal(corpus.provenance.review.sha256, "B13D080090760F72414BE25FC26CC4C6600C4ECDD77CDB909B5C527753BB34AE");
	assert.equal(corpus.provenance.result.sha256, "ED3AF5C49C87D6801D8B76FEA6C67B5683044C102859A30C86AAA6201F200E5C");
	assert.equal(corpus.provenance.observedBundleBuildId, "005a6852cc85835f");
	assert.equal(corpus.provenance.observedBundleSha256, "2F4FA808DEC38067995645842FB083E3F330DD20ED846A35C1ED4A631E51DAD3");
	assert.equal(corpus.provenance.providerModel, "gemini-3.6-flash-high");
	assert.deepEqual(corpus.rows.map(row => [row.sequence, row.fixtureId, row.mode, row.finalWireFamily]), [[1, "f06-markdown-structure", "typed", "typed-json"], [2, "f06-markdown-structure", "canary", "whole-marker"], [3, "f07-academic-technical", "typed", "typed-json"], [4, "f07-academic-technical", "canary", "typed-json"]]);
});

test("observed content and each of five real choices bind exact original hashes and physical order", () => {
	const corpus = load();
	for (const row of corpus.rows) {
		assert.equal(hash(row.source), row.sourceSha256); assert.equal(hash(row.output), row.outputSha256);
		for (const [index, attempt] of row.providerEvidence.entries()) {assert.equal(attempt.physicalOrdinal, index + 1); assert.equal(hash(attempt.choices[0].content), attempt.choices[0].contentSha256);}
	}
	assert.equal(corpus.rows.reduce((sum, row) => sum + row.providerEvidence.length, 0), 5);
	assert.equal(corpus.rows[2].providerEvidence[0].choices[0].contentSha256, "A7A0A57E778F4807BEA96FE9A01CEF2D4A48458C0A4471E30A4C2DC3EBD80061");
});

test("observed source, final output and choice byte tampering fail before replay", () => {
	for (const alter of [corpus => {corpus.rows[0].source += " ";}, corpus => {corpus.rows[0].output += " ";}, corpus => {corpus.rows[0].providerEvidence[0].choices[0].content += " ";}]) {const corpus = load(); alter(corpus); assert.throws(() => validateObservedRegressions(corpus), /observed-fixture-(content-hash|response)/);}
});

test("observed risks remain three open errors and one uncertain term rather than four definite failures", () => {
	const corpus = load();
	assert.deepEqual(corpus.rows.map(row => row.riskState), ["open", "open", "open", "needs-review"]);
	assert.equal(corpus.rows[2].issues[0].kind, "semantic-role-reversal");
	assert.equal(corpus.rows[3].verdict, "terminology-ambiguity-needs-review");
	for (const row of corpus.rows) {const changed = load(); changed.rows[row.sequence - 1].riskState = "resolved"; assert.throws(() => validateObservedRegressions(changed), /risk-state/);}
});

test("observed replay has no external evidence-file dependency and restores original exception settings", () => withPlugin(plugin => {
	const corpus = load(), settings = plugin.settings.exceptions;
	corpus.provenance.review.path = "missing-historical-review.json"; corpus.provenance.result.path = "missing-historical-result.json";
	const report = replay(plugin, corpus);
	assert.equal(report.rows.length, 4); assert.equal(plugin.settings.exceptions, settings);
	assert.equal(report.scope.pureProtocolReplayOnly, true); assert.equal(report.scope.liveCanaryOrDisplayExercised, false);
	assert.equal(report.scope.passingReplayResolvesSemanticRisk, false); assert.equal(report.scope.arbitraryOutputEvaluator, false);
}));

test("real planner, protection and validators reproduce four final outputs without certifying their meaning", () => withPlugin(plugin => {
	const report = replay(plugin);
	assert.deepEqual(report.summary, {total: 4, open: 3, needsReview: 1, resolved: 0, historicalPhysicalResponses: 5, replayedFinalOutputs: 4});
	assert.equal(report.status, "known-semantic-risks-open");
	for (const row of report.rows) {assert.equal(row.replay.runtimeAccepted, true); assert.equal(row.replay.outputMatchesObserved, true); assert.equal(row.replay.outputSha256, row.outputSha256); assert.equal(row.replay.semanticRiskResolved, false); assert.equal(row.replay.keptCount, 0);}
	assert.match(report.rows[2].output, /配偶\/抚养人/);
	assert.equal(report.rows[2].riskState, "open");
}));

test("D duplicate marker is rejected before the retained typed fallback, never credited as committed D text", () => withPlugin(plugin => {
	const row = replay(plugin).rows[3];
	assert.deepEqual(row.replay.attempts.map(attempt => [attempt.physicalOrdinal, attempt.wireFamily, attempt.runtimeAccepted, attempt.reason]), [[1, "whole-marker", false, "duplicate-marker"], [2, "typed-json", true, null]]);
	assert.equal(row.replay.finalWireFamily, "typed-json"); assert.equal(row.accounting.canaryTypedFallbacks, 1);
	assert.match(row.providerEvidence[0].choices[0].content, /⟪2⟫⟪2⟫/);
	assert.ok(!row.output.includes("⟪2⟫")); assert.equal(row.riskState, "needs-review");
}));

test("an invented corrected answer is replay drift, not an automatic resolution or synonym judgment", () => withPlugin(plugin => {
	const corpus = load(), choice = corpus.rows[2].providerEvidence[0].choices[0], settings = plugin.settings.exceptions;
	choice.content = choice.content.replace("配偶/抚养人", "配偶/受抚养人"); choice.contentSha256 = hash(choice.content);
	assert.throws(() => replay(plugin, corpus), /observed-replay-drift/);
	assert.equal(plugin.settings.exceptions, settings); assert.equal(corpus.rows[2].riskState, "open");
}));

test("fixed-source observed evidence adds no private config or generic output evaluation scope", () => {
	const corpus = load();
	assert.equal(corpus.scope.syntheticSourceOnly, true); assert.equal(corpus.scope.actualHistoricalProviderResponses, true); assert.equal(corpus.scope.newProviderRequests, 0); assert.equal(corpus.scope.aiReview, true); assert.equal(corpus.scope.humanReview, false); assert.equal(corpus.scope.professionalTranslationReview, false);
	assert.ok(!/"(?:apiKey|authorization|authKeys|endpoint|requestHeaders|responseHeaders)"\s*:/i.test(JSON.stringify(corpus)));
	const corpusPath = path.join(__dirname, "fixtures/observed-translation-regressions.json"); assert.ok(fs.statSync(corpusPath).size < 65536);
});
