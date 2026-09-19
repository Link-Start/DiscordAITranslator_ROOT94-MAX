const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {runW2ProviderHarness} = require("../../scripts/run-w2-provider-benchmark");
const {analyzeW2b0Results, decideW2b, runW2b0Analysis} = require("../../scripts/analyze-w2b0-wire-diagnostics");
const {W2_ALL_FIXTURES, W2_MEASURED_FIXTURES} = require("../../src/diagnostics/w2-wire-benchmark-fixtures");
const {W2B_ARM_KEYS, normalizeW2ScheduleOptions, compileW2FixtureArm, validateW2ArmResponse, diagnoseW2ArmResponse, createW2WireBenchmark} = require("../../src/diagnostics/w2-wire-benchmark");
const {W2_ALL_ARMS, createW2WireBenchmarkStore} = require("../../src/diagnostics/w2-wire-benchmark-store");

const KEY_SECRET = "W2-KEY-SENTINEL-NEVER-EXPORT";
const ENDPOINT_SECRET = "https://W2-ENDPOINT-SENTINEL.invalid/v1/chat/completions";
const MODEL_SECRET = "W2-MODEL-SENTINEL-NEVER-EXPORT";
const SOURCE_SENTINEL = "W2-SOURCE-SENTINEL-NEVER-EXPORT";
const ALL_IDS = W2_ALL_FIXTURES.map(fixture => fixture.id);
// W2c contract: a range starts at its open marker and runs to the next marker or its line end.
const RANGE_RE = /⟪(\d+)⟫([^⟪\r\n]*)/g;
const TOKEN_RE = /⟦(?:[CW])?\d+⟧|⟦\/?F\d+⟧/g;

function sha256File(filePath) {return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();}

function chineseFor(text, index) {
	if (/apple/i.test(text)) return "苹果是红色的。";
	if (/ocean/i.test(text)) return "海洋是蓝色的。";
	if (/bird/i.test(text)) return "鸟可以飞翔。";
	if (/moon/i.test(text)) return "月亮很明亮。";
	const tokens = [...String(text).matchAll(TOKEN_RE)].map(match => match[0]).join("").replace(/⟦F\d+⟧/g, "$&格式文字");
	return `这是第${index + 1}项合成译文${tokens}。`;
}

function dResponseFor(wire) {
	return [...wire.matchAll(RANGE_RE)].map((match, index) => `⟪${match[1]}⟫${chineseFor(match[2], index)}`).join("\n");
}

function createFakeFetch() {
	let calls = 0;
	const fetchFunction = async (_url, options = {}) => {
		calls++;
		await new Promise(resolve => setImmediate(resolve));
		const envelope = JSON.parse(String(options.body || "{}"));
		const systemPrompt = String((envelope.messages || []).find(row => row.role === "system")?.content || "");
		const userPrompt = String((envelope.messages || []).find(row => row.role === "user")?.content || "");
		let translated, usage;
		if (/⟪n⟫/.test(systemPrompt)) {translated = dResponseFor(userPrompt); usage = {prompt_tokens: 60, completion_tokens: 40};}
		else {
			const input = JSON.parse(userPrompt);
			translated = JSON.stringify({segments: input.segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
			usage = {prompt_tokens: 300, completion_tokens: 100};
		}
		const body = JSON.stringify({choices: [{message: {content: translated}}], usage: Object.assign({completion_tokens_details: {reasoning_tokens: 0}}, usage)});
		return {status: 200, headers: {get: name => String(name).toLowerCase() === "content-type" ? "application/json" : ""}, text: async () => body};
	};
	return {fetchFunction, get calls() {return calls;}};
}

function createFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "w2b-runner-"));
	const configPath = path.join(directory, "DiscordAITranslator.config.json");
	const installedPath = path.join(directory, "DiscordAITranslator.plugin.js");
	fs.writeFileSync(configPath, JSON.stringify({all: {
		engines: {translator: "custom-w2fixture", backup: "----", customProviders: [{id: "custom-w2fixture", name: SOURCE_SENTINEL}]},
		authKeys: {"custom-w2fixture": {key: KEY_SECRET, endpoint: ENDPOINT_SECRET, model: MODEL_SECRET, interfaceFormat: "openai_chat"}}
	}}, null, 2));
	fs.writeFileSync(installedPath, "// W2 installed fixture\n");
	return {directory, configPath, installedPath, file: name => path.join(directory, name)};
}

function assertAnonymous(value) {
	const encoded = JSON.stringify(value);
	for (const secret of [KEY_SECRET, ENDPOINT_SECRET, MODEL_SECRET, SOURCE_SENTINEL, "Authorization", "systemPrompt", "userPrompt", "rawResponse", "⟦", "⟪", "Undergraduate", "Longma", "Deployment"])
		assert.equal(encoded.includes(secret), false, secret);
}

test("W2b schedule admits arm D and the thirteen fixtures while the frozen default stays 165 requests", () => {
	assert.deepEqual(W2B_ARM_KEYS, ["A", "Ba", "Bm", "D"]);
	assert.deepEqual(W2_ALL_ARMS, ["typed-json", "compact-order", "compact-marker", "whole-marker"]);
	const full = normalizeW2ScheduleOptions();
	assert.deepEqual(full.arms, ["A", "Ba", "Bm"]);
	assert.equal(full.fixtureIds.length, 9, "the default plan never picks up the W2b fixtures");
	assert.equal(full.totalRequests, 165);
	const w2b = normalizeW2ScheduleOptions({arms: ["D", "A"], fixtureIds: ALL_IDS, samplesPerFixture: 6});
	assert.equal(w2b.ok, true);
	assert.deepEqual(w2b.arms, ["A", "D"]);
	assert.equal(w2b.fixtureIds.length, 13);
	assert.equal(w2b.warmupRequests, 2);
	assert.equal(w2b.measuredRequests, 156);
	assert.equal(w2b.totalRequests, 158);
	const w2c = normalizeW2ScheduleOptions({arms: ["A", "D"], fixtureIds: ALL_IDS, samplesPerFixture: 5});
	assert.equal(w2c.totalRequests, 132, "W2c plan: 13 fixtures x 5 samples x 2 arms + 2 warm-ups");
	assert.deepEqual(w2b.orders, [["A", "D"], ["D", "A"]]);
	assert.equal(normalizeW2ScheduleOptions({arms: ["A", "Ba", "Bm", "D"], fixtureIds: ALL_IDS, samplesPerFixture: 6}).reason, "request-budget");
	assert.equal(normalizeW2ScheduleOptions({arms: ["D"], fixtureIds: ["f10-markdown-protected-mixed"], samplesPerFixture: 1}).totalRequests, 2);
});

test("W2b arm D compiles, validates and diagnoses every fixture through the shared W2 orchestrator seam", () => {
	for (const fixture of W2_ALL_FIXTURES) {
		const request = compileW2FixtureArm(fixture, "D");
		assert.equal(request.ok, true, `${fixture.id}: ${request.reason}`);
		assert.equal(request.wireFamily, "whole-marker");
		assert.equal(typeof request.estimatedOutputTokens, "number");
		assert.doesNotMatch(request.userPrompt, /m3i-v\d|"segments"|"contexts"|⟪\//);
		const clean = dResponseFor(request.userPrompt);
		const validated = validateW2ArmResponse(request, clean);
		assert.equal(validated.ok, true, `${fixture.id}: ${validated.reason}`);
		assert.equal(validated.protectedIntegrity, "pass");
		assert.equal(validated.orderDetectable, true);
		for (const literal of fixture.preserveLiterals || []) assert.equal(validated.translation.includes(literal), true, `${fixture.id} keeps ${literal}`);
		const diagnostics = diagnoseW2ArmResponse(request, clean);
		assert.equal(diagnostics.segments.length, request.segmentCount);
		assert.equal(diagnostics.segments.every(row => row.reason === "ok" && row.targetHasCjk === true), true);
		assert.equal(diagnostics.structure.outsideMarkerChars, 0);
		assert.equal(diagnostics.structure.closeMarkerEchoes, 0);
		assert.equal(diagnostics.structure.strayMarkerChars, 0);
		assert.equal(diagnostics.structure.windowed, request.local.request.windowed);
		assert.equal(typeof diagnostics.structure.contextChars, "number");
		assert.equal(diagnostics.structure.firstPassValid, true);
		assert.equal(diagnostics.structure.repairRequested, false);
		assert.equal(diagnostics.structure.terminalMarkerPresent, null);
		const broken = validateW2ArmResponse(request, clean.split("\n").slice(1).join("\n"));
		assert.equal(broken.ok, false);
		assert.equal(["missing-marker", "marker-schema"].includes(broken.reason), true, broken.reason);
		const brokenDiagnostics = diagnoseW2ArmResponse(request, clean.split("\n").slice(1).join("\n"));
		assert.equal(brokenDiagnostics.segments[0].reason, broken.reason);
		const trailing = validateW2ArmResponse(request, `${clean}\nThat is all.`);
		assert.equal(trailing.reason, "unsafe-structure");
		assert.equal(diagnoseW2ArmResponse(request, `${clean}\nThat is all.`).structure.outsideMarkerChars, 12);
	}
	const f01 = compileW2FixtureArm(W2_MEASURED_FIXTURES[0], "D"), typed = compileW2FixtureArm(W2_MEASURED_FIXTURES[0], "A");
	assert.ok(f01.wireObservation.wireBytes < typed.wireObservation.wireBytes / 2);
	assert.equal(f01.segmentCount, typed.segmentCount, "f01 has no in-sentence placeholders, so D and A count the same 61 units");
	const f05 = compileW2FixtureArm(W2_ALL_FIXTURES.find(row => row.id === "f05-protection-composite"), "D");
	assert.equal(f05.segmentCount, 3, "f05 sentences stay whole with their placeholders");
});

test("W2b store and orchestrator carry the whole-marker arm without touching the frozen W2 gate", async () => {
	const store = createW2WireBenchmarkStore();
	assert.deepEqual(store.getW2Snapshot().plannedArms, ["typed-json", "compact-order", "compact-marker"], "default plan is still the three W2 arms");
	const token = store.beginW2Session({plannedArms: ["whole-marker", "typed-json"], plannedSamplesPerArm: 1, plannedWarmupCount: 2, plannedLogicalRequests: 4, plannedPhysicalRequests: 4});
	assert.ok(token);
	assert.deepEqual(store.getW2Snapshot().plannedArms, ["typed-json", "whole-marker"]);
	assert.ok(store.recordW2Trial(token, {trialId: 0, arm: "whole-marker", status: "ok", valid: true, protectedIntegrity: "pass", providerMs: 5, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0}, reason: null}));
	assert.equal(store.recordW2Trial(token, {trialId: 1, arm: "typed-json", status: "failed", valid: false, reason: "marker-order"}).reason, "marker-order");
	assert.equal(store.getW2Snapshot().arms["whole-marker"].sampleCount, 1);
	assert.equal(Object.keys(store.getW2Snapshot().comparisons).sort().join(","), "compact-marker,compact-order", "no W2 comparison is minted for D");

	const events = [];
	const providerClient = {
		getWireExperimentCapability() {return {ok: true, engineKey: "fixture-ai", protocolFamily: "openai_chat", configDigest: "w2c1:0123456789abcdefabcd"};},
		createWireExperimentSession() {
			return {capability: providerClient.getWireExperimentCapability(), async dispatch(request) {
				const local = request.localRequest;
				const text = local.arm === "D" ? dResponseFor(local.userPrompt) : JSON.stringify({segments: JSON.parse(local.userPrompt).segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
				return {ok: true, text, providerMs: local.arm === "D" ? 3 : 9, usage: {promptTokens: local.arm === "D" ? 2 : 10, completionTokens: local.arm === "D" ? 2 : 5, reasoningTokens: 0}};
			}, cancel() {}, async drain() {}, snapshot() {return {};}};
		}
	};
	const benchmark = createW2WireBenchmark({providerClient, observationStore: {recordW2BenchmarkEvent: event => events.push(event)}});
	const preview = benchmark.prepare("fixture-ai", {arms: ["A", "D"], fixtureIds: ALL_IDS, samplesPerFixture: 1});
	assert.equal(preview.ok, true);
	assert.equal(preview.maxRequests, 28);
	assert.equal(typeof preview.estimatedOutputTokens, "number");
	assert.equal(preview.extraFixtureRevision, "w2c-fixed-v1");
	const result = await benchmark.run(benchmark.confirm(preview.previewId));
	assert.equal(result.status, "complete");
	assert.equal(result.completedRequests, 28);
	assert.equal(result.physicalRequests, 28);
	assert.equal(result.repairRequests, 0);
	assert.equal(result.arms.D.planned, 13);
	assert.equal(result.arms.D.succeeded, 13);
	assert.equal(result.arms.A.succeeded, 13);
	assert.equal(result.arms.Ba.planned, 0);
	assert.equal(result.gateReady, false);
	assert.equal(events.filter(event => event.arm === "whole-marker" && !event.warmup).every(event => event.segmentDiagnostics.length > 0 && event.structureDiagnostics.outsideMarkerChars === 0), true);
	assertAnonymous(events);
});

test("W2b decision applies rulings 3 and 4 gate by gate", () => {
	const groups = {long: {group: "long-mixed"}, short: {group: "short"}};
	const trial = (arm, fixtureId, providerMs, promptTokens, completionTokens, overrides = {}) => Object.assign({arm, fixtureId, status: "ok", valid: true, protectedIntegrity: "pass", requestCount: 1, providerMs, promptTokens, completionTokens, structureDiagnostics: {missingMarkerIndices: [], duplicateMarkerIndices: [], unknownMarkerCount: 0, orderPreserved: true, receivedItemCount: 3, expectedItemCount: 3}}, overrides);
	const rows = [];
	for (let index = 0; index < 6; index++) {
		rows.push(trial("typed-json", "long", 1000, 500, 200), trial("whole-marker", "long", 600, 120, 90));
		rows.push(trial("typed-json", "short", 800, 100, 50), trial("whole-marker", "short", 850, 30, 25));
	}
	const passed = decideW2b(rows, groups);
	assert.equal(passed.ready, true);
	assert.equal(passed.passed, true, passed.reason);
	assert.equal(passed.gates.promptTokens.ratio, 0.25);
	assert.equal(passed.gates.completionTokens.ratio, 0.46);
	assert.equal(passed.gates.p50LongMixed.improvementPercent, 40);
	assert.equal(passed.gates.p50Short.ratio, 1.0625);
	assert.equal(passed.gates.p95All.passed, true);
	assert.equal(passed.gates.cost.passed, null);

	const slowShort = rows.map(row => row.arm === "whole-marker" && row.fixtureId === "short" ? Object.assign({}, row, {providerMs: 900}) : row);
	const failedShort = decideW2b(slowShort, groups);
	assert.equal(failedShort.passed, false);
	assert.equal(failedShort.reason, "gate-failed:p50Short");
	assert.equal(failedShort.eliminatedByCorrectness, false);

	const oneBad = rows.map((row, index) => index === 1 ? Object.assign({}, row, {status: "failed", valid: false, reason: "wrong-language"}) : row);
	const eliminated = decideW2b(oneBad, groups);
	assert.equal(eliminated.passed, false);
	assert.equal(eliminated.eliminatedByCorrectness, true);
	assert.deepEqual(eliminated.gates.correctness.failingFixtures, ["long"]);
	assert.match(eliminated.reason, /^gate-failed:correctness/);

	const uneven = rows.slice(0, -1);
	assert.equal(decideW2b(uneven, groups).ready, false);
	assert.equal(decideW2b(uneven, groups).reason, "not-ready");
});

test("W2b runner runs A and D over all thirteen fixtures with per-trial diagnostics and a decision", async t => {
	const fixture = createFixture();
	t.after(() => fs.rmSync(fixture.directory, {recursive: true, force: true}));
	const fake = createFakeFetch();
	const common = ["--config", fixture.configPath, "--installed", fixture.installedPath, "--max-output-tokens", "512", "--arms", "A,D", "--fixtures", ALL_IDS.join(","), "--samples-per-fixture", "1"];
	const preview = await runW2ProviderHarness(["--preflight", ...common, "--output", fixture.file("preflight.json")], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(preview.status, "ready");
	assert.deepEqual(preview.preview.arms, ["A", "D"]);
	assert.equal(preview.preview.fixtureIds.length, 13);
	assert.equal(preview.preview.maxRequests, 28);
	assert.equal(preview.preview.extraFixtureRevision, "w2c-fixed-v1");
	assert.match(preview.preview.extraFixtureManifestSha256, /^[0-9A-F]{64}$/);
	assert.equal(typeof preview.preview.estimatedOutputTokens, "number");
	assert.equal(fake.calls, 0);
	const configBefore = sha256File(fixture.configPath), installedBefore = sha256File(fixture.installedPath);
	const result = await runW2ProviderHarness(["--run", ...common, "--confirm", preview.confirmationToken, "--output", fixture.file("result.json")], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(result.status, "complete");
	assert.equal(result.benchmark.completedRequests, 28);
	assert.equal(fake.calls, 28);
	assert.deepEqual(result.store.plannedArms, ["typed-json", "whole-marker"]);
	assert.equal(result.store.planComplete, true);
	assert.equal(result.store.arms["whole-marker"].sampleCount, 13);
	assert.equal(result.store.arms["whole-marker"].successCount, 13);
	assert.equal(result.store.arms["typed-json"].successCount, 13);
	assert.equal(result.benchmark.arms.D.succeeded, 13);
	assert.equal(result.benchmark.arms.D.repairRequested, 0);
	assert.equal(result.benchmark.physicalRequests, 28);
	assert.equal(result.benchmark.repairRequests, 0);
	const dTrials = result.store.trials.filter(row => row.arm === "whole-marker" && !row.warmup);
	assert.equal(dTrials.length, 13);
	assert.equal(dTrials.filter(row => row.structureDiagnostics.windowed === true).map(row => row.fixtureId).sort().join(","), "f04-target-body-title,f13-long-chinese-one-english");
	assert.equal(dTrials.every(row => row.requestCount === 1 && row.segmentDiagnostics.length > 0 && row.structureDiagnostics.outsideMarkerChars === 0 && row.structureDiagnostics.closeMarkerEchoes === 0), true);
	assert.equal(sha256File(fixture.configPath), configBefore);
	assert.equal(sha256File(fixture.installedPath), installedBefore);
	assertAnonymous(result);

	const analysis = analyzeW2b0Results([{label: "w2b", result}]);
	assert.equal(analysis.schemaVersion, "w2b0-analysis-2");
	assert.equal(analysis.byArm["whole-marker"].label, "D");
	assert.equal(analysis.byArm["whole-marker"].ok, 13);
	assert.equal(analysis.byArmFixture["whole-marker"]["f10-markdown-protected-mixed"].ok, 1);
	assert.equal(analysis.structure["whole-marker"].trials, 13);
	assert.equal(analysis.structure["whole-marker"].outsideText, 0);
	assert.equal(analysis.segmentFailures["f05-protection-composite"].expectedSegmentCount, 3, "A's inventory is the P2 production plan: three merged ranges");
	assert.equal(analysis.segmentFailures["f05-protection-composite"].otherInventories, undefined, "A (P2) and D count the same three units on f05");
	assert.equal(analysis.segmentFailures["f01-exact-academic"].otherInventories, undefined, "identical inventories merge");
	assert.equal(analysis.fixtureGroups["f01-exact-academic"].group, "long-mixed");
	assert.equal(analysis.fixtureGroups["f02-short-english"].group, "short");
	assert.equal(analysis.fixtureGroups["f05-protection-composite"].group, "short");
	assert.equal(analysis.fixtureGroups["f10-markdown-protected-mixed"].group, "long-mixed");
	assert.equal(analysis.decision.ready, true);
	assert.equal(analysis.decision.gates.correctness.passed, true);
	assert.equal(analysis.decision.gates.promptTokens.passed, true);
	assert.equal(analysis.decision.gates.promptTokens.ratio, 0.2);
	assert.equal(analysis.decision.gates.completionTokens.passed, true);
	assert.equal(analysis.decision.gates.singleRequest.passed, true);
	assert.equal(typeof analysis.decision.passed, "boolean");
	assertAnonymous(analysis);

	const written = runW2b0Analysis(["--result", fixture.file("result.json"), "--output", fixture.file("analysis.json"), "--decision-output", fixture.file("decision.json")]);
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file("analysis.json"), "utf8")), written);
	const decision = JSON.parse(fs.readFileSync(fixture.file("decision.json"), "utf8"));
	assert.equal(decision.schemaVersion, "w2c-decision-1", "the CLI writes the W2c ruling by default");
	assert.equal(decision.ruling, "w2c");
	assert.deepEqual(decision.inputs, ["result.json"]);
	assert.equal(decision.ready, true);
	assert.equal(decision.gates.singleShotNotBelowA.passed, true);
	assert.equal(decision.gates.validAfterRepair.passed, true);
	assert.equal(decision.gates.repairRate.repaired, 0);
	assert.equal(decision.gates.p50LongMixed.passed, null, "long/mixed P50 is informational");
	assert.equal(analysis.decisionW2c.schemaVersion, "w2c-decision-1");
	const legacy = runW2b0Analysis(["--result", fixture.file("result.json"), "--output", fixture.file("analysis-w2b.json"), "--decision-output", fixture.file("decision-w2b.json"), "--ruling", "w2b"]);
	assert.equal(JSON.parse(fs.readFileSync(fixture.file("decision-w2b.json"), "utf8")).schemaVersion, "w2b-decision-1");
	assert.equal(legacy.decision.schemaVersion, "w2b-decision-1");
});

test("W2c orchestrator repairs a failed D answer once, counts the repair, and stops at the 165 hard cap", async () => {
	const events = [];
	let dispatches = 0, dropOnce = true;
	const providerClient = {
		getWireExperimentCapability() {return {ok: true, engineKey: "fixture-ai", protocolFamily: "openai_chat", configDigest: "w2c1:0123456789abcdefabcd"};},
		createWireExperimentSession(_engineKey, options) {
			assert.equal(options.maxRequests, 165, "the session budget is the hard cap, repairs included");
			return {capability: providerClient.getWireExperimentCapability(), async dispatch(request) {
				dispatches++;
				const isD = request.wireObservation.wireFamily === "whole-marker";
				let text;
				if (isD) {
					const lines = dResponseFor(request.userPrompt).split("\n");
					// The first measured f10 answer loses its last range; the repair request carries only that range.
					if (dropOnce && request.localRequest && request.localRequest.sourceIdentity === W2_ALL_FIXTURES.find(row => row.id === "f10-markdown-protected-mixed").sha256 && !request.localRequest.warmup && lines.length > 1) {dropOnce = false; lines.pop();}
					text = lines.join("\n");
				}
				else text = JSON.stringify({segments: JSON.parse(request.userPrompt).segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
				return {ok: true, text, providerMs: isD ? 3 : 9, usage: {promptTokens: isD ? 2 : 10, completionTokens: isD ? 2 : 5, reasoningTokens: 0}};
			}, cancel() {}, async drain() {}, snapshot() {return {};}};
		}
	};
	const benchmark = createW2WireBenchmark({providerClient, observationStore: {recordW2BenchmarkEvent: event => events.push(event)}});
	const preview = benchmark.prepare("fixture-ai", {arms: ["A", "D"], fixtureIds: ["f10-markdown-protected-mixed", "f11-inline-placeholders-tail"], samplesPerFixture: 2});
	assert.equal(preview.maxRequests, 10);
	const result = await benchmark.run(benchmark.confirm(preview.previewId));
	assert.equal(result.status, "complete");
	assert.equal(result.completedRequests, 10);
	assert.equal(result.physicalRequests, 11, "one repair request on top of the plan");
	assert.equal(result.repairRequests, 1);
	assert.equal(dispatches, 11);
	assert.equal(result.arms.D.succeeded, 4, "the repaired trial counts as valid");
	assert.equal(result.arms.D.repairRequested, 1);
	assert.equal(result.arms.D.repairValid, 1);
	assert.equal(result.arms.D.promptTokens, 4 * 2 + 2, "repair tokens are added to the arm total");
	const repairedEvent = events.find(event => event.arm === "whole-marker" && !event.warmup && event.requestCount === 2);
	assert.ok(repairedEvent, "the repaired trial records two requests");
	assert.equal(repairedEvent.valid, true);
	assert.equal(repairedEvent.protectedIntegrity, "pass");
	assert.equal(repairedEvent.structureDiagnostics.firstPassValid, false);
	assert.equal(repairedEvent.structureDiagnostics.repairRequested, true);
	assert.equal(repairedEvent.structureDiagnostics.repairValid, true);
	assert.equal(repairedEvent.structureDiagnostics.repairPromptTokens, 2);
	assert.equal(repairedEvent.structureDiagnostics.repairProviderMs, 3);
	assert.deepEqual(repairedEvent.structureDiagnostics.missingMarkerIndices, [7], "the first answer missed the last range");
	assert.equal(events.filter(event => event.arm === "whole-marker" && !event.warmup && event.requestCount === 1).length, 3);
	assertAnonymous(events);

	// Hard cap: a plan that leaves no room for the planned trials themselves fails closed at 165.
	const capClient = {
		getWireExperimentCapability() {return {ok: true, engineKey: "fixture-ai", protocolFamily: "openai_chat", configDigest: "w2c1:0123456789abcdefabcd"};},
		createWireExperimentSession() {
			return {capability: capClient.getWireExperimentCapability(), async dispatch(request) {
				const isD = request.wireObservation.wireFamily === "whole-marker";
				// Every D answer misses its last range so every measured D trial needs a repair.
				const lines = isD ? dResponseFor(request.userPrompt).split("\n") : null;
				// Repair dispatches carry no localRequest; only first answers lose their last range.
				if (isD && lines.length > 1 && request.localRequest) lines.pop();
				const text = isD ? lines.join("\n") : JSON.stringify({segments: JSON.parse(request.userPrompt).segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
				return {ok: true, text, providerMs: 1, usage: {promptTokens: 1, completionTokens: 1, reasoningTokens: 0}};
			}, cancel() {}, async drain() {}, snapshot() {return {};}};
		}
	};
	const capped = createW2WireBenchmark({providerClient: capClient});
	const capPreview = capped.prepare("fixture-ai", {arms: ["D"], fixtureIds: ALL_IDS, samplesPerFixture: 12});
	assert.equal(capPreview.maxRequests, 157, "the plan alone fits the cap");
	const capResult = await capped.run(capped.confirm(capPreview.previewId));
	assert.equal(capResult.status, "failed");
	assert.equal(capResult.reason, "attempt-budget");
	assert.equal(capResult.physicalRequests <= 165, true);
	assert.ok(capResult.repairRequests > 0);
});
