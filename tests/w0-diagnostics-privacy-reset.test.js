const test = require("node:test");
const assert = require("node:assert/strict");

const {createProviderLatencyStore} = require("../src/diagnostics/provider-latency-store");
const {createAiLatencyDiagnosticsPayload, createDiagnosticsCopyPayload} = require("../src/ui/settings-panel");

const SECRET_VALUES = Object.freeze([
	"W0-SOURCE-PRIVACY-SENTINEL",
	"W0-PROMPT-PRIVACY-SENTINEL",
	"https://W0-ENDPOINT-PRIVACY-SENTINEL.invalid",
	"W0-KEY-PRIVACY-SENTINEL",
	"W0-RAW-RESPONSE-PRIVACY-SENTINEL",
	"w0-private@example.invalid"
]);

function cleanAggregate(overrides = {}) {
	return Object.assign({
		schemaVersion: "w0-1",
		generation: 7,
		attemptCount: 2,
		localSampleCount: 0,
		latestLocal: null,
		repairReasonCounts: {"missing-id": 1},
		fallbackReasonCounts: {"root-malformed": 1},
		budgetCounts: {attempt: 0, body: 1, token: 0, capability: 0},
		leakCounts: {configuredTerm: 0, wrapperContent: 0, email: 0, bareDomain: 0, ipPort: 0, command: 0},
		display: {latestMs: null, confirmedCount: 0, deferredCount: 0, staleCount: 0, failedCount: 0}
	}, overrides);
}

function assertNoSecrets(value) {
	const serialized = JSON.stringify(value);
	for (const secret of SECRET_VALUES) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	for (const forbiddenKey of ["source", "text", "prompt", "systemPrompt", "endpoint", "model", "key", "header", "rawRequest", "rawResponse", "rawError", "channelId", "messageId", "userId"])
		assert.equal(new RegExp(`"${forbiddenKey}"\\s*:`).test(serialized), false, `diagnostic leaked forbidden key ${forbiddenKey}`);
}

test("copied batch structures enforce their own field, enum and capacity limits", () => {
	const row = {requestId: SECRET_VALUES[0], promptVersion: SECRET_VALUES[1], envelope: SECRET_VALUES[2], jsonSource: SECRET_VALUES[4], malformed: SECRET_VALUES[3], rawResponse: SECRET_VALUES[4], messageId: SECRET_VALUES[5], rowCount: Infinity, expectedMessageCount: 1e20, missingMessageCount: -1, fallbackStarted: SECRET_VALUES[0]};
	const dirty = cleanAggregate({batchAnswerCount: 25, recentBatchAnswers: Array(25).fill(row)});
	const copied = createAiLatencyDiagnosticsPayload({wireObservation: dirty}, {}).wireObservation;
	assert.equal(copied.batchAnswerCount, 25);
	assert.equal(copied.recentBatchAnswers.length, 20);
	const safe = copied.recentBatchAnswers[0];
	assert.equal(safe.requestId, 0);
	assert.equal(safe.promptVersion, "unknown");
	assert.equal(safe.envelope, "none");
	assert.equal(safe.jsonSource, "none");
	assert.equal(safe.malformed, "unknown");
	assert.equal(safe.rowCount, 0);
	assert.equal(safe.expectedMessageCount, 4096);
	assert.equal(safe.missingMessageCount, 0);
	assert.equal(safe.fallbackStarted, false);
	assertNoSecrets(copied);
});

test("W0 copied diagnostics explicitly sanitize the wireObservation block", () => {
	const dirty = cleanAggregate({
		source: SECRET_VALUES[0],
		prompt: SECRET_VALUES[1],
		endpoint: SECRET_VALUES[2],
		key: SECRET_VALUES[3],
		rawResponse: SECRET_VALUES[4],
		attempts: [{
			wireFamily: "typed-json",
			sourceBytes: 100,
			promptTokens: 10,
			email: SECRET_VALUES[5],
			rawError: SECRET_VALUES[4]
		}]
	});
	const payload = createAiLatencyDiagnosticsPayload({wireObservation: dirty}, {});
	assert.ok(payload.wireObservation, "copy diagnostics omitted the approved wireObservation block");
	assert.equal(payload.wireObservation.schemaVersion, "w0-1");
	assert.equal(payload.wireObservation.generation, 7);
	assert.equal(payload.wireObservation.attemptCount, 2);
	assert.equal(payload.wireObservation.repairReasonCounts["missing-id"], 1);
	assert.equal(payload.wireObservation.budgetCounts.body, 1);
	assert.deepEqual(payload.wireObservation.leakCounts, cleanAggregate().leakCounts);
	assertNoSecrets(payload.wireObservation);
	assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 1024 * 1024);
	assert.equal(dirty.source, SECRET_VALUES[0], "sanitizer must not mutate the owner snapshot");
});

test("W0 diagnostics root and aiPerformance share one strictly sanitized wireObservation", () => {
	const dirty = cleanAggregate({
		endpoint: SECRET_VALUES[2],
		key: SECRET_VALUES[3],
		rawResponse: SECRET_VALUES[4],
		repairReasonCounts: {"missing-id": 2, RAW_PRIVATE_REASON: 99},
		fallbackReasonCounts: {"root-malformed": 1, RAW_PRIVATE_FALLBACK: 99},
		budgetCounts: {attempt: 1, body: 2, token: 3, capability: 4, RAW_PRIVATE_BUDGET: 99},
		leakCounts: {configuredTerm: 1, wrapperContent: 2, email: 3, bareDomain: 4, ipPort: 5, command: 6, RAW_PRIVATE_LEAK: 99}
	});
	const aiPerformance = createAiLatencyDiagnosticsPayload({wireObservation: dirty}, {});
	const copied = createDiagnosticsCopyPayload({plugin: "fixture", wireObservation: {rawResponse: SECRET_VALUES[4]}}, aiPerformance);

	assert.deepEqual(copied.wireObservation, copied.aiPerformance.wireObservation);
	assert.equal(copied.wireObservation.repairReasonCounts["missing-id"], 2);
	assert.equal(copied.wireObservation.fallbackReasonCounts["root-malformed"], 1);
	assert.deepEqual(Object.keys(copied.wireObservation.budgetCounts).sort(), ["attempt", "body", "capability", "token"]);
	assert.deepEqual(Object.keys(copied.wireObservation.leakCounts).sort(), ["bareDomain", "command", "configuredTerm", "email", "ipPort", "wrapperContent"]);
	assertNoSecrets(copied);
	assert.doesNotMatch(JSON.stringify(copied), /RAW_PRIVATE_/);
	assert.ok(Buffer.byteLength(JSON.stringify(copied), "utf8") < 1024 * 1024);
});

test("W0 reset clears the copied aggregate and late observations cannot repopulate it", () => {
	const store = createProviderLatencyStore();
	assert.equal(typeof store.recordSemanticObservation, "function", "W0 semantic counter owner is not implemented");
	assert.equal(typeof store.getWireObservationSnapshot, "function", "W0 wireObservation snapshot is not implemented");
	const old = store.beginLatencyRequest({kind: "manual", lane: "manual"});
	store.recordSemanticObservation({token: old, reason: "missing-id", fallbackKind: "root-malformed", count: 1});
	store.recordDisplayObservation({generation: old.generation, outcome: "confirmed", enqueueToDomMs: 12});
	store.recordLatencyEvent({
		token: old,
		engineKey: "oaicompat",
		status: "ok",
		usage: {promptTokens: 15, completionTokens: 4, reasoningTokens: 0},
		wireObservation: {
			schemaVersion: "w0-1",
			wireFamily: "typed-json",
			wireVersion: "s8b-p1-v1",
			sourceBytes: 10,
			wireBytes: 20,
			translateBytes: 10,
			promptBytes: 30,
			metadataBytes: 20,
			requestBodyBytes: 40,
			wireAmplification: 2,
			itemCount: 1,
			segmentCount: 1,
			contextIncluded: false,
			contextBytes: 0,
			protectedMarkerBytes: 0,
			prohibitedFieldCount: 0,
			danglingContextRefCount: 0,
			danglingContextRefBytes: 0,
			configuredTermLeakCount: 0,
			wrapperContentLeakCount: 0,
			emailLeakCount: 0,
			bareDomainLeakCount: 0,
			ipPortLeakCount: 0,
			commandLeakCount: 0,
			protectedIntegrity: "pass",
			rawResponse: SECRET_VALUES[4]
		}
	});
	assert.equal(store.getWireObservationSnapshot().attemptCount, 1);
	store.resetLatency();
	assert.equal(store.recordSemanticObservation({token: old, reason: "body-budget", count: 99}), null);
	assert.equal(store.recordDisplayObservation({generation: old.generation, outcome: "confirmed", enqueueToDomMs: 999}), null);

	const direct = store.getWireObservationSnapshot();
	const copied = createAiLatencyDiagnosticsPayload(store.getLatencySnapshot(), {}).wireObservation;
	assert.deepEqual(copied, direct, "reset and copied diagnostics must read the same owner generation");
	assert.equal(copied.generation, old.generation + 1);
	assert.equal(copied.attemptCount, 0);
	assert.equal(copied.localSampleCount, 0);
	assert.equal(copied.latestLocal, null);
	assert.deepEqual(copied.repairReasonCounts, {});
	assert.deepEqual(copied.fallbackReasonCounts, {});
	assert.deepEqual(copied.budgetCounts, {attempt: 0, body: 0, token: 0, capability: 0});
	assert.deepEqual(copied.leakCounts, {configuredTerm: 0, wrapperContent: 0, email: 0, bareDomain: 0, ipPort: 0, command: 0});
	assert.deepEqual(copied.display, {latestMs: null, confirmedCount: 0, deferredCount: 0, staleCount: 0, failedCount: 0});
	assertNoSecrets(copied);
});
