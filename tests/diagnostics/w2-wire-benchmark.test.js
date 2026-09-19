const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
	W2_FIXTURE_REVISION,
	W2_FIXTURE_MANIFEST_SHA256,
	W2_ARMS,
	W2_BALANCED_ORDERS,
	W2_WARMUP_FIXTURE,
	W2_MEASURED_FIXTURES
} = require("../../src/diagnostics/w2-wire-benchmark-fixtures");
const {
	W2_SCHEMA_VERSION,
	createW2Schedule,
	compileW2FixtureArm,
	validateW2ArmResponse,
	createW2WireBenchmark
} = require("../../src/diagnostics/w2-wire-benchmark");

const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex").toUpperCase();

function chineseFor(text, index) {
	if (/apple/i.test(text)) return "苹果是红色的。";
	if (/ocean/i.test(text)) return "海洋是蓝色的。";
	if (/bird/i.test(text)) return "鸟可以飞翔。";
	if (/moon/i.test(text)) return "月亮很明亮。";
	// P2 wire: protection tokens travel inside the segment text and a valid answer echoes them.
	const tokens = [...String(text).matchAll(/⟦(?:[CW])?\d+⟧|⟦\/?F\d+⟧/g)].map(match => match[0]).join("").replace(/⟦F\d+⟧/g, "$&格式文字");
	return `这是第${index + 1}项合成译文${tokens}。`;
}

function responseFor(request, mutate = null) {
	let response;
	if (request.arm === "A") {
		const payload = JSON.parse(request.userPrompt);
		response = JSON.stringify({segments: payload.segments.map((row, index) => ({id: row.id, translation: chineseFor(row.text, index)}))});
	}
	else {
		const payload = JSON.parse(request.userPrompt);
		const values = payload.x.map(chineseFor);
		response = request.arm === "Ba"
			? JSON.stringify(values)
			: values.map((value, index) => `⟦W${index}⟧${value}`).join("\n") + `\n⟦W${values.length}⟧`;
	}
	return typeof mutate === "function" ? mutate(response, request) : response;
}

function createProviderHarness({failureCount = 0, hold = false} = {}) {
	let configDigest = "w2c1:0123456789abcdefabcd";
	let active = 0;
	let activeHighWater = 0;
	let dispatchCount = 0;
	const calls = [];
	const providerClient = {
		getWireExperimentCapability() {return {ok: true, engineKey: "fixture-ai", protocolFamily: "openai_chat", configDigest};},
		createWireExperimentSession(_engineKey, options = {}) {
			return {
				capability: providerClient.getWireExperimentCapability(),
				async dispatch(request) {
					dispatchCount++;
					calls.push({arm: request.wireObservation.wireFamily, bytes: Buffer.byteLength(request.userPrompt)});
					active++;
					activeHighWater = Math.max(activeHighWater, active);
					try {
						if (hold) await new Promise(resolve => {
							if (options.signal && options.signal.aborted) return resolve();
							options.signal && options.signal.addEventListener("abort", resolve, {once: true});
						});
						if (options.signal && options.signal.aborted) return {ok: false, reason: "cancelled", providerMs: 1, usage: null};
						if (dispatchCount <= failureCount) return {ok: false, reason: "network", providerMs: 3, usage: null};
						return {ok: true, text: responseFor(request.localRequest), providerMs: 5, usage: {promptTokens: 11, completionTokens: 7, reasoningTokens: 0}};
					}
					finally {active--;}
				},
				cancel() {},
				async drain() {},
				snapshot() {return {activeHighWater};}
			};
		}
	};
	return {providerClient, calls, setConfigDigest(value) {configDigest = value;}, get activeHighWater() {return activeHighWater;}};
}

test("W2 fixed runtime manifest owns nine synthetic fixtures and immutable SHA identities", () => {
	assert.equal(W2_FIXTURE_REVISION, "w2-fixed-v1");
	assert.equal(W2_SCHEMA_VERSION, "w2-1");
	assert.deepEqual(W2_ARMS, ["A", "Ba", "Bm"]);
	assert.equal(W2_MEASURED_FIXTURES.length, 9);
	assert.equal(new Set(W2_MEASURED_FIXTURES.map(row => row.id)).size, 9);
	for (const fixture of [W2_WARMUP_FIXTURE, ...W2_MEASURED_FIXTURES]) {
		assert.equal(fixture.synthetic, true);
		assert.match(fixture.sha256, /^[0-9A-F]{64}$/);
		assert.equal(sha256(fixture.source), fixture.sha256);
		assert.equal(JSON.stringify(fixture).match(/channelId|messageId|guildId|authorId/g), null);
	}
	const manifestIdentity = JSON.stringify([W2_FIXTURE_REVISION, ...[W2_WARMUP_FIXTURE, ...W2_MEASURED_FIXTURES].map(row => [row.id, row.sha256, row.targetLanguageId])]);
	assert.equal(sha256(manifestIdentity), W2_FIXTURE_MANIFEST_SHA256);
});

test("W2 schedule is 3 excluded warmups plus 162 measured requests with six balanced positions", () => {
	assert.equal(W2_BALANCED_ORDERS.length, 6);
	assert.equal(new Set(W2_BALANCED_ORDERS.map(row => row.join("/"))).size, 6);
	const schedule = createW2Schedule();
	assert.equal(schedule.length, 165);
	assert.deepEqual(schedule.slice(0, 3).map(row => [row.arm, row.warmup]), [["A", true], ["Ba", true], ["Bm", true]]);
	const measured = schedule.filter(row => !row.warmup);
	assert.equal(measured.length, 162);
	for (const arm of W2_ARMS) {
		const armRows = measured.filter(row => row.arm === arm);
		assert.equal(armRows.length, 54);
		assert.deepEqual([0, 1, 2].map(position => armRows.filter(row => row.position === position).length), [18, 18, 18]);
	}
	for (const fixture of W2_MEASURED_FIXTURES) {
		const rows = measured.filter(row => row.fixtureId === fixture.id);
		assert.equal(rows.length, 18);
		assert.deepEqual([...new Set(rows.map(row => row.orderId))], [0, 1, 2, 3, 4, 5]);
	}
});

test("W2 A/Ba/Bm compile from one protected plan and strictly validate their own response contracts", () => {
	for (const fixture of W2_MEASURED_FIXTURES) {
		for (const arm of W2_ARMS) {
			const request = compileW2FixtureArm(fixture, arm);
			assert.equal(request.ok, true, `${fixture.id}/${arm}: ${request.reason}`);
			assert.equal(request.sourceIdentity, fixture.sha256);
			assert.equal(request.arm, arm);
			assert.ok(request.estimatedInputTokens > 0);
			if (arm === "A") assert.equal(request.wireFamily, "typed-json");
			else {
				const payload = JSON.parse(request.userPrompt);
				assert.equal(Object.keys(payload).every(key => key === "c" || key === "x"), true);
				assert.equal(request.wireFamily, arm === "Ba" ? "compact-order" : "compact-marker");
			}
			const validated = validateW2ArmResponse(request, responseFor(request));
			assert.equal(validated.ok, true, `${fixture.id}/${arm}: ${validated.reason}`);
			assert.equal(typeof validated.translation, "string");
			assert.equal(validated.translation.length > 0, true);
		}
	}

	const fixture = W2_MEASURED_FIXTURES.find(row => row.id === "f08-order-oracle");
	const array = compileW2FixtureArm(fixture, "Ba");
	const swapped = JSON.parse(responseFor(array));
	[swapped[0], swapped[1]] = [swapped[1], swapped[0]];
	assert.equal(validateW2ArmResponse(array, JSON.stringify(swapped)).reason, "fixture-oracle");
	const marker = compileW2FixtureArm(fixture, "Bm");
	assert.equal(validateW2ArmResponse(marker, responseFor(marker).replace("⟦W0⟧", "⟦W1⟧")).ok, false);
	const malformed = validateW2ArmResponse(compileW2FixtureArm(fixture, "A"), "not-json");
	assert.equal(malformed.reason, "malformed");
	assert.equal(malformed.protectedIntegrity, "unknown", "an unparseable response has no byte-integrity evidence");

	const protectedFixture = W2_MEASURED_FIXTURES.find(row => row.id === "f05-protection-composite");
	for (const arm of ["Ba", "Bm"]) {
		const request = compileW2FixtureArm(protectedFixture, arm);
		const corrupted = responseFor(request, encoded => {
			if (arm === "Ba") {
				const values = JSON.parse(encoded);
				values[0] += "⟦0⟧";
				return JSON.stringify(values);
			}
			return encoded.replace("⟦W1⟧", "⟦0⟧⟦W1⟧");
		});
		const failed = validateW2ArmResponse(request, corrupted);
		assert.equal(failed.reason, "placeholder-mismatch");
		assert.equal(failed.protectedIntegrity, "fail");
	}
});

test("W2 preview exposes 165 requests and bounded token/cost fields without dispatch", () => {
	const harness = createProviderHarness();
	const benchmark = createW2WireBenchmark({providerClient: harness.providerClient});
	const unknown = benchmark.prepare("fixture-ai");
	assert.equal(unknown.ok, true);
	assert.equal(unknown.maxRequests, 165);
	assert.equal(unknown.warmupRequests, 3);
	assert.equal(unknown.measuredRequests, 162);
	assert.equal(unknown.maxCost, null);
	assert.ok(unknown.estimatedInputTokens > 0);
	assert.equal(unknown.hardOutputTokenCap, 165 * unknown.maxOutputTokensPerRequest);
	assert.equal(harness.calls.length, 0);
	const priced = benchmark.prepare("fixture-ai", {inputPricePerMillion: 1, outputPricePerMillion: 2});
	assert.equal(priced.maxCost, (priced.estimatedInputTokens + priced.hardOutputTokenCap * 2) / 1_000_000);
	assert.equal(Object.prototype.hasOwnProperty.call(priced, "confirmationToken"), false);
});

test("W2 requires a one-use confirmation token and rejects stale config before dispatch", async () => {
	const harness = createProviderHarness();
	const benchmark = createW2WireBenchmark({providerClient: harness.providerClient});
	const preview = benchmark.prepare("fixture-ai");
	assert.equal((await benchmark.run("missing")).reason, "confirmation-required");
	assert.equal(harness.calls.length, 0);
	const token = benchmark.confirm(preview.previewId);
	assert.equal(typeof token, "string");
	harness.setConfigDigest("w2c1:fedcba9876543210abcd");
	assert.equal((await benchmark.run(token)).reason, "stale");
	assert.equal(harness.calls.length, 0);
	assert.equal((await benchmark.run(token)).reason, "confirmation-required", "confirmation tokens are one-use even when stale");
});

test("W2 full run stays serial, excludes warmups and writes only anonymous bounded events", async () => {
	const harness = createProviderHarness();
	const events = [];
	const benchmark = createW2WireBenchmark({providerClient: harness.providerClient, observationStore: {recordW2BenchmarkEvent: event => events.push(event)}});
	const preview = benchmark.prepare("fixture-ai", {maxOutputTokens: 1024});
	const result = await benchmark.run(benchmark.confirm(preview.previewId));
	assert.equal(result.status, "complete");
	assert.equal(result.completedRequests, 165);
	assert.equal(harness.calls.length, 165);
	assert.equal(harness.activeHighWater, 1);
	for (const arm of W2_ARMS) {
		assert.equal(result.arms[arm].planned, 54);
		assert.equal(result.arms[arm].attempted, 54);
		assert.equal(result.arms[arm].succeeded, 54);
		assert.equal(result.arms[arm].p50Ms, 5);
		assert.equal(result.arms[arm].p95Ms, 5);
		assert.equal(result.arms[arm].promptTokens, 54 * 11);
		assert.equal(result.arms[arm].completionTokens, 54 * 7);
	}
	assert.equal(events.length, 165);
	assert.equal(events.every(event => event.schemaVersion === "w2-1"), true);
	const exported = JSON.stringify(events);
	// "sourceChars"/"sourceHasCjk" are W2b-0 count fields; only an exact "source" key or text would leak.
	for (const forbidden of ["\"source\":", "\"sourceText\"", "systemPrompt", "userPrompt", "rawResponse", "endpoint", "model", "key", "channel", "message", "Longma", "apple", "⟦"]) assert.equal(exported.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
	assert.equal(events.filter(event => !event.warmup).every(event => Array.isArray(event.segmentDiagnostics) && event.segmentDiagnostics.length > 0 && event.structureDiagnostics), true, "every measured trial carries anonymous segment diagnostics");
});

test("W2 cancellation aborts the current request and dispatches no later schedule rows", async () => {
	const harness = createProviderHarness({hold: true});
	const benchmark = createW2WireBenchmark({providerClient: harness.providerClient});
	const preview = benchmark.prepare("fixture-ai");
	const pending = benchmark.run(benchmark.confirm(preview.previewId));
	while (!harness.calls.length) await new Promise(resolve => setImmediate(resolve));
	benchmark.cancel();
	const result = await pending;
	assert.equal(result.status, "cancelled");
	assert.equal(harness.calls.length, 1);
	assert.equal(result.completedRequests, 1);
});

test("W2 stops after two consecutive failures and keeps failures in the measured denominator", async () => {
	const harness = createProviderHarness({failureCount: 2});
	const benchmark = createW2WireBenchmark({providerClient: harness.providerClient});
	const preview = benchmark.prepare("fixture-ai");
	const result = await benchmark.run(benchmark.confirm(preview.previewId));
	assert.equal(result.status, "failed");
	assert.equal(result.reason, "consecutive-failures");
	assert.equal(harness.calls.length, 2);
	assert.equal(result.completedRequests, 2);
	assert.equal(result.gateReady, false);
});
