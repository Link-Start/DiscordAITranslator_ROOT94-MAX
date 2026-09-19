const test = require("node:test");
const assert = require("node:assert/strict");
const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");

const WIRE_OBSERVATION = Object.freeze({
	schemaVersion: "w0-1",
	wireFamily: "typed-json",
	wireVersion: "s8b-p1-v1",
	sourceBytes: 2167,
	translateBytes: 1063,
	wireBytes: 14528,
	promptBytes: 14932,
	metadataBytes: 13869,
	requestBodyBytes: 15100,
	wireAmplification: 14528 / 2167,
	segmentCount: 61,
	itemCount: 1,
	contextIncluded: true,
	contextBytes: 3928,
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
	protectedIntegrity: "pass"
});

function recordW0Attempt(store, overrides = {}) {
	const token = store.beginLatencyRequest(Object.assign({
		kind: "manual",
		lane: "manual",
		queueWaitMs: 7,
		messageCount: 1
	}, overrides.begin || {}));
	const event = store.recordLatencyEvent(Object.assign({
		token,
		role: "primary",
		engineKey: "oaicompat",
		engineFamily: "custom",
		transportMs: 321,
		leaseWaitMs: 3,
		status: "ok",
		outcome: "translated",
		stage: "provider",
		reason: null,
		usage: {promptTokens: 101, completionTokens: 37, reasoningTokens: 9},
		wireObservation: WIRE_OBSERVATION
	}, overrides.record || {}));
	return {token, event, snapshot: store.getLatencySnapshot()};
}

test("W0 red harness still exercises the existing bounded store rather than a fixture stub", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	for (let index = 0; index < 21; index++) {
		const token = store.beginLatencyRequest({kind: "manual"});
		store.recordLatencyEvent({token, engineKey: "oaicompat", status: "ok"});
	}
	assert.equal(store.getAttemptsCount(), 20);
	assert.equal(store.getLatencySnapshot().attemptsCount, 20);
});

test("W0 begin and settle retain the approved lane, usage, wire and byte schema", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	const {token, event, snapshot} = recordW0Attempt(store);

	assert.equal(token.lane, "manual");
	assert.equal(event.lane, "manual");
	assert.equal(event.engineFamily, "custom");
	assert.equal(event.leaseWaitMs, 3);
	assert.equal(event.outcome, "translated");
	assert.equal(event.stage, "provider");
	assert.equal(event.reason, null);
	assert.equal(event.promptTokens, 101);
	assert.equal(event.completionTokens, 37);
	assert.equal(event.reasoningTokens, 9);
	for (const [field, value] of Object.entries(WIRE_OBSERVATION)) assert.equal(event[field], value, field);
	assert.equal(snapshot.latestTranslation, event);
	assert.equal(Object.isFrozen(event), true);
});

test("W0 usage preserves authoritative zero and leaves every missing token field null", () => {
	const withZero = recordW0Attempt(createProviderLatencyStore(), {
		record: {usage: {promptTokens: 0, completionTokens: 0, reasoningTokens: 0}}
	}).event;
	assert.deepEqual(
		[withZero.promptTokens, withZero.completionTokens, withZero.reasoningTokens],
		[0, 0, 0]
	);

	const missing = recordW0Attempt(createProviderLatencyStore(), {record: {usage: null}}).event;
	assert.deepEqual(
		[missing.promptTokens, missing.completionTokens, missing.reasoningTokens],
		[null, null, null]
	);
	assert.equal(Object.prototype.hasOwnProperty.call(missing, "estimatedTokens"), false,
		"estimated tokens must not impersonate provider usage");
});

test("W0 records physical repair/fallback roles and only the real finite reason vocabulary", () => {
	const allowedReasons = [
		"malformed", "unknown-id", "duplicate-id", "missing-id", "empty",
		"placeholder-mismatch", "wrong-language", "too-similar",
		"attempt-budget", "body-budget", "token-budget",
		"capability-unverified", "unknown"
	];
	const store = createProviderLatencyStore();
	for (const [index, reason] of allowedReasons.entries()) {
		const token = store.beginLatencyRequest({kind: "historical", lane: index % 2 ? "item-repair" : "history-primary"});
		const event = store.recordLatencyEvent({
			token,
			role: index % 2 ? "repair" : "fallback",
			engineKey: "oaicompat",
			engineFamily: "custom",
			status: "error",
			outcome: "failed",
			stage: index % 2 ? "repair" : "provider",
			reason,
			wireObservation: WIRE_OBSERVATION
		});
		assert.equal(event.reason, reason);
		assert.equal(event.role, index % 2 ? "repair" : "fallback");
	}
	const unknownToken = store.beginLatencyRequest({kind: "manual", lane: "not-a-real-lane"});
	const unknown = store.recordLatencyEvent({
		token: unknownToken,
		role: "not-a-real-role",
		engineFamily: "not-a-real-family",
		outcome: "not-a-real-outcome",
		stage: "not-a-real-stage",
		reason: "RAW_SECRET_REASON"
	});
	assert.equal(unknown.lane, "unknown");
	assert.equal(unknown.role, "primary");
	assert.equal(unknown.engineFamily, "unknown");
	assert.equal(unknown.outcome, "failed");
	assert.equal(unknown.reason, "unknown");
	assert.doesNotMatch(JSON.stringify(store.getLatencySnapshot()), /RAW_SECRET_REASON|not-a-real/);
});

test("W0 transport retry stays primary while an explicit semantic repair counts as repair", () => {
	const store = createProviderLatencyStore();
	const reasoning = store.beginLatencyRequest({kind: "manual", lane: "manual"});
	const retry = store.recordLatencyEvent({token: reasoning, role: "retry", engineKey: "oaicompat", status: "ok", wireObservation: WIRE_OBSERVATION});
	assert.equal(retry.role, "primary");
	assert.equal(retry.repairCount, 0);
	const semantic = store.beginLatencyRequest({kind: "historical", lane: "item-repair"});
	const repair = store.recordLatencyEvent({token: semantic, role: "retry", observationRole: "repair", engineKey: "oaicompat", status: "ok", wireObservation: WIRE_OBSERVATION});
	assert.equal(repair.role, "repair");
	assert.equal(repair.repairCount, 1);
});

test("W0 first confirmed DOM span closes the latest live attempt exactly once", () => {
	const store = createProviderLatencyStore();
	const old = store.beginLatencyRequest({kind: "live", lane: "auto-single"});
	store.recordLatencyEvent({token: old, engineKey: "old-provider", status: "ok", wireObservation: WIRE_OBSERVATION});
	const token = store.beginLatencyRequest({kind: "live", lane: "auto-single"});
	store.recordLatencyEvent({token, engineKey: "oaicompat", status: "ok", wireObservation: WIRE_OBSERVATION});
	assert.equal(store.getLatencySnapshot().latestTranslation.enqueueToDomMs, null);
	store.recordDisplayObservation({generation: old.generation, requestId: old.requestId, outcome: "confirmed", enqueueToDomMs: 7});
	assert.equal(store.getLatencySnapshot().latestTranslation.enqueueToDomMs, null, "an older request confirmation cannot close the newer live attempt");
	store.recordDisplayObservation({generation: token.generation, requestId: token.requestId, outcome: "confirmed", enqueueToDomMs: 42});
	assert.equal(store.getLatencySnapshot().latestTranslation.enqueueToDomMs, 42);
	store.recordDisplayObservation({generation: token.generation, requestId: token.requestId, outcome: "confirmed", enqueueToDomMs: 99});
	assert.equal(store.getLatencySnapshot().latestTranslation.enqueueToDomMs, 42, "later confirmations from the same burst neither replace it nor walk backward into an older request");
});

test("W0 validator can replace the provisional HTTP outcome without changing the physical attempt", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "manual", lane: "manual"});
	store.recordLatencyEvent({token, engineKey: "oaicompat", status: "ok", wireObservation: WIRE_OBSERVATION});
	assert.equal(store.getLatencySnapshot().latestTranslation.outcome, "translated");
	store.recordAttemptOutcome({token, outcome: "failed", stage: "parse", reason: "malformed"});
	const attempt = store.getLatencySnapshot().latestTranslation;
	assert.equal(attempt.outcome, "failed");
	assert.equal(attempt.stage, "parse");
	assert.equal(attempt.reason, "malformed");
	assert.equal(store.getAttemptsCount(), 1);
});

test("W0 reset clears all observation counters and rejects late dispatch and settle data", () => {
	const store = createProviderLatencyStore();
	const old = store.beginLatencyRequest({kind: "live", lane: "live-burst"});
	store.recordLatencyEvent({
		token: old,
		engineKey: "oaicompat",
		status: "ok",
		usage: {promptTokens: 10, completionTokens: 2, reasoningTokens: 0},
		wireObservation: Object.assign({}, WIRE_OBSERVATION, {configuredTermLeakCount: 1})
	});
	store.resetLatency();
	assert.equal(store.recordLatencyEvent({
		token: old,
		engineKey: "oaicompat",
		status: "ok",
		usage: {promptTokens: 999, completionTokens: 999, reasoningTokens: 999},
		wireObservation: Object.assign({}, WIRE_OBSERVATION, {emailLeakCount: 999})
	}), null);

	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.generation, 1);
	assert.equal(snapshot.latestAttempt, null);
	assert.equal(snapshot.attemptsCount, 0);
	assert.deepEqual(snapshot.wireObservation, {
		schemaVersion: "w0-1",
		generation: 1,
		attemptCount: 0,
		localSampleCount: 0,
		latestLocal: null,
		repairReasonCounts: {},
		fallbackReasonCounts: {},
		batchShapeCounts: {},
		batchAnswerCount: 0,
		recentBatchAnswers: [],
		budgetCounts: {attempt: 0, body: 0, token: 0, capability: 0},
		leakCounts: {configuredTerm: 0, wrapperContent: 0, email: 0, bareDomain: 0, ipPort: 0, command: 0},
		display: {latestMs: null, confirmedCount: 0, deferredCount: 0, staleCount: 0, failedCount: 0}
	});
});

test("W0 snapshot ignores sensitive extras and remains below the public diagnostic budget", () => {
	const store = createProviderLatencyStore();
	for (let index = 0; index < 100; index++) {
		recordW0Attempt(store, {record: {
			endpoint: "https://W0-ENDPOINT-SENTINEL.invalid",
			model: "W0-MODEL-SENTINEL",
			key: "W0-KEY-SENTINEL",
			source: "W0-SOURCE-SENTINEL",
			prompt: "W0-PROMPT-SENTINEL",
			rawResponse: "W0-RESPONSE-SENTINEL",
			rawError: "W0-ERROR-SENTINEL"
		}});
	}
	const serialized = JSON.stringify(store.getLatencySnapshot());
	for (const secret of ["W0-ENDPOINT", "W0-MODEL", "W0-KEY", "W0-SOURCE", "W0-PROMPT", "W0-RESPONSE", "W0-ERROR"])
		assert.doesNotMatch(serialized, new RegExp(secret));
	assert.ok(Buffer.byteLength(serialized, "utf8") < 1024 * 1024);
	assert.equal(store.getAttemptsCount(), 20);
});
