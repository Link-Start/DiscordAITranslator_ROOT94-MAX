"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {SCHEMA_VERSION, classifyQuality, summarizeResults, runQualityGate, parseArguments, writeReport} = require("../scripts/run-translation-quality-gate");
const root = path.resolve(__dirname, "..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
let report;
test.before(async () => {report = await runQualityGate();});
const byId = id => report.rows.find(row => row.id === id);

function temporaryReport(action) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dta-quality-gate-"));
	const output = path.join(directory, "report.json");
	try {return action(output);}
	finally {if (fs.existsSync(output)) fs.unlinkSync(output); fs.rmdirSync(directory);}
}

test("accepted short prose echo is a quality violation, not an allowed name", () => {
	assert.deepEqual(classifyQuality({runtimeAccepted: true, translation: "I am hungry"}, {source: "I am hungry", references: ["我饿了"], allowedKeeps: []}), {category: "suspected-error", reason: "source-echo"});
});

test("offline corpus keeps runtime acceptance separate from fixed reference quality", () => {
	assert.equal(report.schemaVersion, SCHEMA_VERSION);
	assert.equal(report.exitCode, 2);
	assert.deepEqual(report.summary, {total: 16, runtimeAccepted: 8, runtimeRejected: 8, runtimeAcceptedWithKept: 1, runtimeAcceptedWithoutKept: 7, keptCount: 1, repairCount: 16, qualityCategories: {"genuine-translation": 5, "reasonable-keep": 2, "suspected-error": 1, "hard-failure": 8}, violationCount: 1});
	// Repeated ordinary echoes must fail the complete result after bounded repair.
	// The independent nonsense fixture still exposes the semantic evaluator's limit.
	for (const id of ["short-echo", "mixed-residual", "embed-footer-residual"]) {
		assert.equal(byId(id).repairCount, 2, id);
		assert.equal(byId(id).quality.category, "hard-failure", id);
	}
});

test("healthy results produce a passing summary without counting expected hard failures as defects", () => {
	const summary = summarizeResults([
		{runtimeAccepted: true, keptCount: 0, repairCount: 0, quality: {category: "genuine-translation"}, violations: []},
		{runtimeAccepted: false, keptCount: 0, repairCount: 2, quality: {category: "hard-failure"}, violations: []}
	]);
	assert.equal(summary.violationCount, 0);
	assert.equal(summary.runtimeAccepted, 1);
	assert.equal(summary.runtimeRejected, 1);
});

test("target-script nonsense accepted without kept is still a meaning mismatch", () => {
	const row = byId("short-wrong-meaning");
	assert.equal(row.runtimeAccepted, true);
	assert.equal(row.keptCount, 0);
	assert.equal(row.translation, "香蕉");
	assert.deepEqual(row.quality, {category: "suspected-error", reason: "meaning-mismatch"});
});

test("reference matching is exact, not length, substring, script or whitespace similarity", () => {
	const fixture = {source: "Please bring the blue notebook.", references: ["请带上蓝色笔记本。"], allowedKeeps: []};
	for (const translation of ["请带上", "请带上蓝色笔记本。Do not come", " 请带上蓝色笔记本。", "我"])
		assert.equal(classifyQuality({runtimeAccepted: true, translation}, fixture).category, "suspected-error");
	assert.equal(classifyQuality({runtimeAccepted: true, translation: fixture.references[0]}, fixture).category, "genuine-translation");
});

test("mixed-language prefix cannot turn an unchanged English clause into a correct result", () => {
	assert.equal(byId("mixed-complete").translation, "请帮忙 我饿了");
	assert.equal(byId("mixed-complete").quality.category, "genuine-translation");
	const row = byId("mixed-residual");
	assert.equal(row.translation, null);
	assert.equal(row.runtimeAccepted, false);
	assert.equal(row.keptCount, 0);
	assert.equal(row.quality.category, "hard-failure");
});

test("proper name retention requires explicit fixture permission independent of the runtime heuristic", () => {
	const row = byId("explicit-proper-name");
	assert.equal(row.runtimeAccepted, true);
	assert.equal(row.keptCount, 1);
	assert.equal(row.quality.category, "reasonable-keep");
	assert.deepEqual(row.allowedKeeps, ["Atomic Gains"]);
	assert.ok(row.keepRationale);
	assert.equal(classifyQuality(row, {source: row.source, references: [], allowedKeeps: []}).category, "suspected-error");
});

test("reply field path reaches the actual semantic wire, not just report metadata", () => {
	const row = byId("reply-correct");
	assert.equal(row.compiledFieldPath, "reply.content");
	assert.equal(row.fieldCoverageMode, "semantic-field-path");
	assert.equal(row.quality.category, "genuine-translation");
});

test("combined embed body/title/description/footer compare complete restored text", () => {
	const row = byId("embed-complete");
	assert.equal(row.segmentCount, 4);
	assert.equal(row.fieldCoverageMode, "synthetic-combined-request-text");
	assert.deepEqual(row.fieldCoverage, ["body", "embed.title", "embed.description", "embed.footer"]);
	assert.equal(row.translation, "会议更新\n__________________ __________________ __________________\n每周报告\n请在明天之前查看所有改动。\n明天见");
	const residual = byId("embed-footer-residual");
	assert.equal(residual.runtimeAccepted, false);
	assert.equal(residual.keptCount, 0);
	assert.equal(residual.translation, null);
	assert.deepEqual(residual.quality, {category: "hard-failure", reason: "wrong-language"});
});

test("pure code/URL is losslessly protected rather than credited as a translation", () => {
	const row = byId("code-url-preserved");
	assert.equal(row.segmentCount, 0);
	assert.equal(row.translation, "```js\nconst ready = true;\n```\nhttps://example.invalid/manual");
	assert.equal(row.quality.category, "reasonable-keep");
	assert.equal(row.keptCount, 0);
	assert.equal(row.repairCount, 0);
});

test("inline protected token is restored by the real protection pipeline", () => {
	const row = byId("inline-protection-correct");
	assert.equal(row.translation, "请在开始之前检查 `ready`。");
	assert.equal(row.quality.category, "genuine-translation");
	assert.match(row.attempts[0].response.segments[0].translation, /⟦C0⟧/);
	assert.ok(!row.translation.includes("⟦C0⟧"));
});

for (const [id, reason] of [["hard-missing", "missing-id"], ["hard-duplicate", "duplicate-id"], ["hard-placeholder", "placeholder-mismatch"], ["hard-malformed", "malformed"]]) {
	test(`${id} remains rejected after the actual bounded repair path`, () => {
		const row = byId(id);
		assert.equal(row.runtimeAccepted, false);
		assert.equal(row.translation, null);
		assert.equal(row.reason, reason);
		assert.equal(row.keptCount, 0);
		assert.equal(row.repairCount, 2);
		assert.equal(row.attempts.length, 3);
		assert.deepEqual(row.quality, {category: "hard-failure", reason});
		assert.deepEqual(row.violations, []);
	});
}

test("ordinary long echo exhausts bounded repair without publishing a partial result", () => {
	const row = byId("long-prose-echo-after-repair");
	assert.equal(row.attempts[0].runtimeAccepted, false);
	assert.equal(row.attempts[0].keptCount, 0);
	assert.equal(row.attempts[1].runtimeAccepted, false);
	assert.equal(row.attempts[2].runtimeAccepted, false);
	assert.equal(row.repairCount, 2);
	assert.equal(row.keptCount, 0);
	assert.equal(row.translation, null);
	assert.equal(row.quality.category, "hard-failure");
});

test("report binds exact fixture/source/bundle/harness identities and declares offline limitations", () => {
	assert.equal(report.fixtures.sha256, hash(fs.readFileSync(path.join(root, report.fixtures.path))));
	assert.equal(report.identity.bundleSha256, hash(fs.readFileSync(path.join(root, "DiscordAITranslator.plugin.js"))));
	assert.equal(report.identity.rebuiltBundleSha256, report.identity.bundleSha256);
	assert.equal(report.identity.bundleMatchesSource, true);
	assert.equal(report.identity.harnessSha256, hash(fs.readFileSync(path.join(root, "tests/helpers/createPluginInstance.js"))));
	assert.equal(report.identity.toolSha256, hash(fs.readFileSync(path.join(root, "scripts/run-translation-quality-gate.js"))));
	for (const file of report.identity.sourceTree.files) assert.equal(file.sha256, hash(fs.readFileSync(path.join(root, file.path))));
	assert.deepEqual(report.integrity, {networkAttempts: 0, settingsWriteAttempts: 0});
	assert.equal(report.scope.providerRequests, 0);
	assert.equal(report.scope.installedPluginAccessed, false);
	assert.equal(report.scope.userConfigurationAccessed, false);
	assert.equal(report.scope.measuresProductionOmissionRate, false);
	assert.equal(report.scope.measuresLatency, false);
	assert.equal(report.scope.coversTerminalCancellationOrStaleCommit, false);
});

test("repeated offline runs preserve global harness state and deterministic evidence", async () => {
	const before = ["window", "BdApi", "fetch"].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
	assert.deepEqual(await runQualityGate(), report);
	assert.deepEqual(["window", "BdApi", "fetch"].map(key => Object.getOwnPropertyDescriptor(globalThis, key)), before);
});

test("report writer verifies bytes and never replaces existing evidence", () => temporaryReport(output => {
	const artifact = writeReport(report, output);
	const before = fs.readFileSync(output);
	assert.equal(artifact.sha256, hash(before));
	assert.equal(artifact.bytes, before.length);
	assert.deepEqual(JSON.parse(before), report);
	assert.throws(() => writeReport({...report, status: "tampered"}, output), {code: "EEXIST"});
	assert.deepEqual(fs.readFileSync(output), before);
}));

test("argument parser rejects accidental missing, repeated or unknown switches", () => {
	for (const args of [[], ["--output"], ["--output", ""], ["--output", "--run"], ["--run", "report.json"], ["--output", "a", "--output", "b"]]) assert.throws(() => parseArguments(args), /usage/);
	assert.equal(parseArguments(["--output", "a.json"]).outputPath, path.resolve("a.json"));
});

test("CLI returns quality exit 2 with verified JSON, and tool exit 1 without overwriting it", () => temporaryReport(output => {
	const script = path.join(root, "scripts/run-translation-quality-gate.js");
	const run = spawnSync(process.execPath, [script, "--output", output], {cwd: root, encoding: "utf8"});
	assert.equal(run.status, 2, run.stderr);
	assert.equal(run.stderr, "");
	const stdout = JSON.parse(run.stdout), bytes = fs.readFileSync(output), saved = JSON.parse(bytes);
	assert.equal(saved.exitCode, 2);
	assert.deepEqual(saved.summary, report.summary);
	assert.equal(stdout.artifact.sha256, hash(bytes));
	const repeat = spawnSync(process.execPath, [script, "--output", output], {cwd: root, encoding: "utf8"});
	assert.equal(repeat.status, 1);
	assert.match(repeat.stderr, /output-exists/);
	assert.deepEqual(fs.readFileSync(output), bytes);
	const invalid = spawnSync(process.execPath, [script, "--unknown"], {cwd: root, encoding: "utf8"});
	assert.equal(invalid.status, 1);
	assert.match(invalid.stderr, /usage/);
}));


test("historical observed regressions share the existing report without changing original fixed-injection statistics", () => {
	assert.equal(report.rows.length, 16); assert.equal(report.summary.violationCount, 1); assert.equal(report.exitCode, 2);
	const observed = report.observedRegressions;
	assert.equal(observed.status, "known-semantic-risks-open");
	assert.deepEqual(observed.summary, {total: 4, open: 3, needsReview: 1, resolved: 0, historicalPhysicalResponses: 5, replayedFinalOutputs: 4});
	assert.equal(observed.fixtures.sha256, hash(fs.readFileSync(path.join(root, observed.fixtures.path))));
	assert.equal(observed.scope.newProviderRequests, 0); assert.equal(observed.scope.arbitraryOutputEvaluator, false);
	assert.equal(observed.rows[3].replay.finalWireFamily, "typed-json");
	assert.ok(observed.rows.every(row => row.replay.outputMatchesObserved && !row.replay.semanticRiskResolved));
});
