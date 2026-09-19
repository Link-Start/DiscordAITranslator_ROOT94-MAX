const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {runW2ProviderHarness} = require("../../scripts/run-w2-provider-benchmark");

const KEY_SECRET = "W2-KEY-SENTINEL-NEVER-EXPORT";
const ENDPOINT_SECRET = "https://W2-ENDPOINT-SENTINEL.invalid/v1/chat/completions";
const MODEL_SECRET = "W2-MODEL-SENTINEL-NEVER-EXPORT";
const SOURCE_SENTINEL = "W2-SOURCE-SENTINEL-NEVER-EXPORT";

function sha256File(filePath) {return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();}

function chineseFor(text, index) {
	if (/apple/i.test(text)) return "苹果是红色的。";
	if (/ocean/i.test(text)) return "海洋是蓝色的。";
	if (/bird/i.test(text)) return "鸟可以飞翔。";
	if (/moon/i.test(text)) return "月亮很明亮。";
	return `这是第${index + 1}项合成译文。`;
}

function createFakeFetch() {
	let calls = 0, active = 0, activeHighWater = 0;
	const fetchFunction = async (_url, options = {}) => {
		calls++;
		active++;
		activeHighWater = Math.max(activeHighWater, active);
		try {
			await new Promise(resolve => setImmediate(resolve));
			const envelope = JSON.parse(String(options.body || "{}"));
			const systemPrompt = String(envelope.messages && envelope.messages.find(row => row.role === "system") && envelope.messages.find(row => row.role === "system").content || "");
			const userPrompt = String(envelope.messages && envelope.messages.find(row => row.role === "user") && envelope.messages.find(row => row.role === "user").content || "");
			const input = JSON.parse(userPrompt);
			let translated;
			if (Array.isArray(input.segments)) translated = JSON.stringify({segments: input.segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
			else {
				const values = input.x.map(chineseFor);
				translated = /exact markers/i.test(systemPrompt)
					? values.map((value, index) => `⟦W${index}⟧${value}`).join("\n") + `\n⟦W${values.length}⟧`
					: JSON.stringify(values);
			}
			const body = JSON.stringify({
				choices: [{message: {content: translated}}],
				usage: {
					prompt_tokens: Math.ceil(Buffer.byteLength(String(options.body || "")) / 4),
					completion_tokens: Math.ceil(Buffer.byteLength(translated) / 4),
					completion_tokens_details: {reasoning_tokens: 0}
				}
			});
			return {status: 200, headers: {get: name => String(name).toLowerCase() === "content-type" ? "application/json" : ""}, text: async () => body};
		}
		finally {active--;}
	};
	return {fetchFunction, get calls() {return calls;}, get activeHighWater() {return activeHighWater;}};
}

function createFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "w2-provider-runner-"));
	const configPath = path.join(directory, "DiscordAITranslator.config.json");
	const installedPath = path.join(directory, "DiscordAITranslator.plugin.js");
	const previewPath = path.join(directory, "preview.json");
	const resultPath = path.join(directory, "result.json");
	const rejectedPath = path.join(directory, "rejected.json");
	fs.writeFileSync(configPath, JSON.stringify({all: {
		engines: {translator: "custom-w2fixture", backup: "----", customProviders: [{id: "custom-w2fixture", name: SOURCE_SENTINEL}]},
		authKeys: {"custom-w2fixture": {key: KEY_SECRET, endpoint: ENDPOINT_SECRET, model: MODEL_SECRET, interfaceFormat: "openai_chat"}}
	}}, null, 2));
	fs.writeFileSync(installedPath, "// W2 installed fixture\n");
	return {directory, configPath, installedPath, previewPath, resultPath, rejectedPath};
}

function assertAnonymous(value) {
	const encoded = JSON.stringify(value);
	for (const secret of [KEY_SECRET, ENDPOINT_SECRET, MODEL_SECRET, SOURCE_SENTINEL, "Authorization", "systemPrompt", "userPrompt", "rawResponse"])
		assert.equal(encoded.includes(secret), false, secret);
}

test("external W2 preflight writes an anonymous confirmation and performs zero requests", async t => {
	const fixture = createFixture();
	t.after(() => fs.rmSync(fixture.directory, {recursive: true, force: true}));
	const fake = createFakeFetch(), stdout = [];
	const configBefore = sha256File(fixture.configPath), installedBefore = sha256File(fixture.installedPath);
	const preview = await runW2ProviderHarness([
		"--preflight", "--config", fixture.configPath, "--installed", fixture.installedPath,
		"--output", fixture.previewPath, "--max-output-tokens", "256"
	], {fetchFunction: fake.fetchFunction, stdout: value => stdout.push(value)});
	assert.equal(preview.mode, "preflight");
	assert.equal(preview.status, "ready");
	assert.match(preview.confirmationToken, /^w2h1:[0-9a-f]{32}$/);
	assert.equal(preview.preview.maxPhysicalRequests, 165);
	assert.equal(preview.transport.physicalRequestCount, 0);
	assert.equal(fake.calls, 0);
	assert.equal(sha256File(fixture.configPath), configBefore);
	assert.equal(sha256File(fixture.installedPath), installedBefore);
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.previewPath, "utf8")), preview);
	assert.deepEqual(JSON.parse(stdout.join("")), preview);
	assertAnonymous(preview);
});

test("external W2 run recompiles the token, issues 165 serial synthetic requests, and leaves config/install byte-identical", async t => {
	const fixture = createFixture();
	t.after(() => fs.rmSync(fixture.directory, {recursive: true, force: true}));
	const fake = createFakeFetch();
	const common = ["--config", fixture.configPath, "--installed", fixture.installedPath, "--max-output-tokens", "256"];
	const preview = await runW2ProviderHarness(["--preflight", ...common, "--output", fixture.previewPath], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(fake.calls, 0);
	const rejected = await runW2ProviderHarness(["--run", ...common, "--confirm", "w2h1:00000000000000000000000000000000", "--output", fixture.rejectedPath], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(rejected.status, "failed");
	assert.equal(rejected.reason, "confirmation-mismatch");
	assert.equal(fake.calls, 0);

	const configBefore = sha256File(fixture.configPath), installedBefore = sha256File(fixture.installedPath);
	const result = await runW2ProviderHarness(["--run", ...common, "--confirm", preview.confirmationToken, "--output", fixture.resultPath], {fetchFunction: fake.fetchFunction, stdout: () => {}});
	assert.equal(result.mode, "run");
	assert.equal(result.status, "complete");
	assert.equal(result.benchmark.completedRequests, 165);
	assert.equal(result.transport.physicalRequestCount, 165);
	assert.equal(result.transport.callbackRequestCount, 0);
	assert.equal(result.transport.settingsWriteAttemptCount, 0);
	assert.equal(result.store.gate.reason, "candidate-failed");
	assert.equal(result.store.trials.length, 165);
	assert.equal(result.store.trials.find(row => row.status === "ok").errorClass, null);
	assert.equal(fake.calls, 165);
	assert.equal(fake.activeHighWater, 1);
	assert.equal(result.transport.activeHighWater, 1);
	assert.equal(result.integrity.configUnchanged, true);
	assert.equal(result.integrity.installedUnchanged, true);
	assert.equal(sha256File(fixture.configPath), configBefore);
	assert.equal(sha256File(fixture.installedPath), installedBefore);
	assert.deepEqual(JSON.parse(fs.readFileSync(fixture.resultPath, "utf8")), result);
	assertAnonymous(result);
});
