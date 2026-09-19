const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {runW2ProviderHarness, parseArguments, HarnessError} = require("../../scripts/run-w2-provider-benchmark");
const {analyzeW2b0Results, runW2b0Analysis} = require("../../scripts/analyze-w2b0-wire-diagnostics");

const KEY_SECRET = "W2-KEY-SENTINEL-NEVER-EXPORT";
const ENDPOINT_SECRET = "https://W2-ENDPOINT-SENTINEL.invalid/v1/chat/completions";
const MODEL_SECRET = "W2-MODEL-SENTINEL-NEVER-EXPORT";
const SOURCE_SENTINEL = "W2-SOURCE-SENTINEL-NEVER-EXPORT";
const SUBSET = "f01-exact-academic,f05-protection-composite,f06-markdown-structure,f08-order-oracle,f09-unicode-lines";

function sha256File(filePath) {return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();}

function chineseFor(text, index) {
	if (/apple/i.test(text)) return "苹果是红色的。";
	if (/ocean/i.test(text)) return "海洋是蓝色的。";
	if (/bird/i.test(text)) return "鸟可以飞翔。";
	if (/moon/i.test(text)) return "月亮很明亮。";
	if (/^GED$/.test(text)) return "GED";
	// P2 wire: protection tokens travel inside the segment text and a valid answer echoes them.
	const tokens = [...String(text).matchAll(/⟦(?:[CW])?\d+⟧/g)].map(match => match[0]).join("");
	return `这是第${index + 1}项合成译文${tokens}。`;
}

function createFakeFetch() {
	let calls = 0;
	const fetchFunction = async (_url, options = {}) => {
		calls++;
		await new Promise(resolve => setImmediate(resolve));
		const envelope = JSON.parse(String(options.body || "{}"));
		const systemPrompt = String((envelope.messages || []).find(row => row.role === "system")?.content || "");
		const userPrompt = String((envelope.messages || []).find(row => row.role === "user")?.content || "");
		const input = JSON.parse(userPrompt);
		let translated;
		if (Array.isArray(input.segments)) translated = JSON.stringify({segments: input.segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
		else {
			const values = input.x.map(chineseFor);
			translated = /exact markers/i.test(systemPrompt)
				? "```\n" + values.map((value, index) => `⟦W${index}⟧${value}`).join("\n") + `\n⟦W${values.length}⟧\n` + "```"
				: JSON.stringify(values);
		}
		const body = JSON.stringify({choices: [{message: {content: translated}}], usage: {prompt_tokens: 40, completion_tokens: 20, completion_tokens_details: {reasoning_tokens: 0}}});
		return {status: 200, headers: {get: name => String(name).toLowerCase() === "content-type" ? "application/json" : ""}, text: async () => body};
	};
	return {fetchFunction, get calls() {return calls;}};
}

function createFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "w2b0-runner-"));
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
	for (const secret of [KEY_SECRET, ENDPOINT_SECRET, MODEL_SECRET, SOURCE_SENTINEL, "Authorization", "systemPrompt", "userPrompt", "rawResponse", "⟦", "Undergraduate"])
		assert.equal(encoded.includes(secret), false, secret);
}

test("W2b-0 runner arguments accept arm, fixture and sample subsets and reject unknown values", () => {
	const base = ["--preflight", "--config", "c.json", "--installed", "p.js", "--output", "o.json"];
	const defaults = parseArguments(base);
	assert.deepEqual(defaults.arms, ["A", "Ba", "Bm"]);
	assert.equal(defaults.fixtureIds, null);
	assert.equal(defaults.samplesPerFixture, 6);
	const subset = parseArguments([...base, "--arms", "Bm, A", "--fixtures", SUBSET, "--samples-per-fixture", "6"]);
	assert.deepEqual(subset.arms, ["A", "Bm"]);
	assert.deepEqual(subset.fixtureIds, SUBSET.split(","));
	assert.equal(subset.samplesPerFixture, 6);
	for (const [flags, code] of [
		[["--arms", "A,Q"], "argument-arms"],
		[["--arms", ""], "argument-arms"],
		[["--fixtures", "f99-nope"], "argument-fixtures"],
		[["--samples-per-fixture", "0"], "argument-samples-per-fixture"],
		[["--samples-per-fixture", "2.5"], "argument-samples-per-fixture"]
	]) assert.throws(() => parseArguments([...base, ...flags]), error => error instanceof HarnessError && error.code === code, flags.join(" "));
});

test("W2b-0 runner preflights and runs a 62-request A/Bm subset with per-trial diagnostics and unchanged config/install", async t => {
	const fixture = createFixture();
	t.after(() => fs.rmSync(fixture.directory, {recursive: true, force: true}));
	const fake = createFakeFetch();
	const common = ["--config", fixture.configPath, "--installed", fixture.installedPath, "--max-output-tokens", "512", "--arms", "A,Bm", "--fixtures", SUBSET, "--samples-per-fixture", "6"];
	const configBefore = sha256File(fixture.configPath), installedBefore = sha256File(fixture.installedPath);
	const preview = await runW2ProviderHarness(["--preflight", ...common, "--output", fixture.file("preflight.json")], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(preview.status, "ready");
	assert.equal(fake.calls, 0);
	assert.deepEqual(preview.preview.arms, ["A", "Bm"]);
	assert.deepEqual(preview.preview.fixtureIds, SUBSET.split(","));
	assert.equal(preview.preview.samplesPerFixture, 6);
	assert.equal(preview.preview.warmupRequests, 2);
	assert.equal(preview.preview.measuredRequests, 60);
	assert.equal(preview.preview.maxRequests, 62);
	assert.equal(preview.preview.maxPhysicalRequests, 62);
	assert.equal(preview.preview.hardRequestCap, 165);
	assert.equal(preview.preview.hardOutputTokenCap, 62 * 512);
	assertAnonymous(preview);

	const fullPreview = await runW2ProviderHarness(["--preflight", "--config", fixture.configPath, "--installed", fixture.installedPath, "--max-output-tokens", "512", "--output", fixture.file("preflight-full.json")], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(fullPreview.preview.maxRequests, 165);
	assert.notEqual(fullPreview.confirmationToken, preview.confirmationToken, "the subset is bound into the confirmation token");
	const rejected = await runW2ProviderHarness(["--run", ...common, "--confirm", fullPreview.confirmationToken, "--output", fixture.file("rejected.json")], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(rejected.reason, "confirmation-mismatch");
	assert.equal(fake.calls, 0);

	const result = await runW2ProviderHarness(["--run", ...common, "--confirm", preview.confirmationToken, "--output", fixture.file("result.json")], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(result.status, "complete");
	assert.equal(result.benchmark.completedRequests, 62);
	assert.equal(result.benchmark.maxRequests, 62);
	assert.equal(result.transport.physicalRequestCount, 62);
	assert.equal(result.transport.activeHighWater, 1);
	assert.equal(fake.calls, 62);
	assert.deepEqual(result.store.plannedArms, ["typed-json", "compact-marker"]);
	assert.equal(result.store.trialCount, 62);
	assert.equal(result.store.warmupTrialCount, 2);
	assert.equal(result.store.planComplete, true);
	assert.equal(result.store.gate.ready, false);
	assert.equal(result.store.arms["compact-order"].sampleCount, 0);
	assert.equal(result.store.arms["compact-marker"].reasonCounts["markdown-fence"], undefined, "fenced marker responses are rejected by the marker parser under its own reason");
	assert.equal(result.store.arms["compact-marker"].successCount, 0);
	const measured = result.store.trials.filter(row => !row.warmup);
	assert.equal(measured.length, 60);
	assert.equal(measured.every(row => Array.isArray(row.segmentDiagnostics) && row.segmentDiagnostics.length > 0), true);
	assert.equal(measured.filter(row => row.arm === "compact-marker").every(row => row.structureDiagnostics.wrappedInCodeFence === true), true);
	const ged = measured.filter(row => row.fixtureId === "f01-exact-academic" && row.arm === "typed-json");
	assert.equal(ged.length, 6);
	assert.equal(ged.every(row => row.reason === "wrong-language" && row.segmentDiagnostics[46].reason === "wrong-language" && row.segmentDiagnostics[46].targetHasCjk === false), true);
	assert.equal(result.integrity.configUnchanged, true);
	assert.equal(result.integrity.installedUnchanged, true);
	assert.equal(sha256File(fixture.configPath), configBefore);
	assert.equal(sha256File(fixture.installedPath), installedBefore);
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file("result.json"), "utf8")), result);
	assertAnonymous(result);

	const analysis = analyzeW2b0Results([{label: "subset", result}]);
	assert.equal(analysis.schemaVersion, "w2b0-analysis-2");
	assert.equal(analysis.decision.ready, false, "no D arm means the W2b decision cannot be ready");
	assert.equal(analysis.decision.reason, "not-ready");
	assert.equal(analysis.inputs.length, 1);
	assert.equal(analysis.inputs[0].status, "complete");
	assert.equal(analysis.warmups.length, 2);
	assert.equal(analysis.byArmFixture["typed-json"]["f01-exact-academic"].total, 6);
	assert.equal(analysis.byArmFixture["typed-json"]["f01-exact-academic"].ok, 0);
	assert.equal(analysis.byArmFixture["typed-json"]["f01-exact-academic"].reasons["wrong-language"], 6);
	assert.equal(analysis.byArmFixture["typed-json"]["f05-protection-composite"].ok, 6);
	assert.equal(analysis.byArmFixture["compact-marker"]["f08-order-oracle"].reasons["marker-schema"], 6);
	assert.equal(analysis.byArmFixture["compact-order"], undefined, "unplanned arms are not fabricated");
	const f01 = analysis.segmentFailures["f01-exact-academic"];
	assert.equal(f01.expectedSegmentCount, 61);
	assert.equal(f01.rows.length, 61);
	assert.equal(f01.rows[46].lengthBucket, "1-12");
	assert.equal(f01.rows[46].isListItem, true);
	assert.equal(f01.rows[46].byArm["typed-json"].failed, 6);
	assert.equal(f01.rows[46].byArm["typed-json"].reasons["wrong-language"], 6);
	assert.equal(f01.rows[46].byArm["compact-marker"].failed, 6, "segment content is judged even when the marker envelope was rejected");
	assert.equal(f01.rows[46].byArm["compact-marker"].reasons["wrong-language"], 6);
	assert.equal(f01.rows[1].byArm["typed-json"].failed, 0);
	assert.equal(f01.rows[1].byArm["compact-marker"].failed, 0);
	assert.equal(f01.topFailing[0].index, 46);
	assert.equal(analysis.structure["compact-marker"].trials, 30);
	assert.equal(analysis.structure["compact-marker"].wrappedInCodeFence, 30);
	assert.equal(analysis.structure["compact-marker"].terminalMarkerMissing, 0);
	assert.equal(analysis.structure["compact-marker"].terminalMarkerLastRecorded, 30);
	assert.equal(analysis.structure["compact-marker"].terminalMarkerNotLast, 0);
	assert.equal(analysis.structure["compact-marker"].terminalMarkerNotLastDeduced, 0);
	assert.equal(analysis.structure["compact-marker"].leadingText, 0);
	const legacy = JSON.parse(JSON.stringify(result));
	for (const trial of legacy.store.trials) if (trial.arm === "compact-marker" && !trial.warmup && trial.structureDiagnostics) {
		delete trial.structureDiagnostics.terminalMarkerLast;
		trial.reason = "missing-terminal-marker";
		trial.structureDiagnostics.trailingChars = 0;
	}
	assert.equal(analyzeW2b0Results([{label: "legacy", result: legacy}]).structure["compact-marker"].terminalMarkerNotLastDeduced, 30, "pre-field results deduce present-empty-rejected terminals");
	assert.equal(analysis.structure["compact-marker"].byFixture["f01-exact-academic"].trials, 6);
	assert.equal(analysis.baselineA.fixtures["f05-protection-composite"].ok, 6);
	assert.equal(analysis.baselineA.allClean, false);
	assertAnonymous(analysis);

	const written = runW2b0Analysis(["--result", fixture.file("result.json"), "--output", fixture.file("analysis.json")]);
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file("analysis.json"), "utf8")), written);
	assert.equal(written.inputs[0].label, "result.json");
	assert.throws(() => runW2b0Analysis(["--result", fixture.file("result.json"), "--output", fixture.file("analysis.json")]), /output-exists/);
});
