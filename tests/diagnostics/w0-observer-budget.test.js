const test = require("node:test");
const assert = require("node:assert/strict");
const {performance} = require("node:perf_hooks");

const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");
const {createProtectionLeakScanner} = require("../../src/diagnostics/wire-observation-producer");
const {createProviderClient} = require("../../src/providers/provider-client");

const CLEAN_WIRE_OBSERVATION = Object.freeze({
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

function percentile(samples, quantile) {
	const sorted = samples.slice().sort((left, right) => left - right);
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))];
}

function recordObservedAttempt(store) {
	const token = store.beginLatencyRequest({kind: "manual", lane: "manual", messageCount: 1, inputChars: 2167});
	return store.recordLatencyEvent({
		token,
		role: "primary",
		engineKey: "oaicompat",
		engineFamily: "custom",
		transportMs: 25,
		status: "ok",
		usage: {promptTokens: 101, completionTokens: 37, reasoningTokens: 0},
		wireObservation: CLEAN_WIRE_OBSERVATION
	});
}

test("W0 store records at least 10k physical attempts under the 0.5ms P95 event budget", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	for (let index = 0; index < 1000; index++) recordObservedAttempt(store);

	const samples = [];
	for (let index = 0; index < 10000; index++) {
		const token = store.beginLatencyRequest({kind: "manual", lane: "manual", messageCount: 1, inputChars: 2167});
		const startedAt = performance.now();
		store.recordLatencyEvent({
			token,
			role: "primary",
			engineKey: "oaicompat",
			engineFamily: "custom",
			transportMs: 25,
			status: "ok",
			usage: {promptTokens: 101, completionTokens: 37, reasoningTokens: 0},
			wireObservation: CLEAN_WIRE_OBSERVATION
		});
		samples.push(performance.now() - startedAt);
	}

	const p95Ms = percentile(samples, 0.95);
	assert.ok(p95Ms < 0.5, `W0 store event P95 ${p95Ms.toFixed(4)}ms exceeded 0.5ms`);
	assert.equal(store.getAttemptsCount(), 20, "the existing attempt ring must remain capped at 20");
	const serialized = JSON.stringify(store.getLatencySnapshot());
	assert.ok(Buffer.byteLength(serialized, "utf8") < 1024 * 1024, "public diagnostics exceeded 1MiB");
});

test("W0 64-term scanner holds a 64KB provider wire under the 0.5ms P95 budget", () => {
	const configuredTerms = Array.from({length: 64}, (_, index) => `W0_CANARY_${String(index).padStart(2, "0")}_VALUE`);
	const scanner = createProtectionLeakScanner({
		configuredTerms,
		wrapperContents: [],
		emails: [],
		bareDomains: [],
		ipPorts: [],
		commands: []
	});
	const wire = `${"x".repeat(64 * 1024 - configuredTerms[63].length - 1)} ${configuredTerms[63]}`;
	for (let index = 0; index < 200; index++) scanner.scan([wire]);

	const samples = [];
	let latest = null;
	for (let index = 0; index < 2000; index++) {
		const startedAt = performance.now();
		latest = scanner.scan([wire]);
		samples.push(performance.now() - startedAt);
	}
	const p95Ms = percentile(samples, 0.95);
	assert.ok(p95Ms < 0.5, `W0 scanner P95 ${p95Ms.toFixed(4)}ms exceeded 0.5ms`);
	assert.equal(latest.configuredTermLeakCount, 1);
	assert.equal(latest.protectedIntegrity, "fail");
});

test("W0 one hundred reset cycles leave the ring and every fixed counter empty", () => {
	const store = createProviderLatencyStore({now: () => 1000});
	for (let cycle = 0; cycle < 100; cycle++) {
		const token = store.beginLatencyRequest({kind: "historical", lane: "history-primary"});
		store.recordSemanticObservation({token, reason: "body-budget", fallbackKind: "root-malformed", count: 1});
		recordObservedAttempt(store);
		store.resetLatency();
		assert.equal(store.recordLatencyEvent({token, status: "ok"}), null, "late settle crossed a reset generation");
	}

	assert.equal(store.getGeneration(), 100);
	assert.equal(store.getAttemptsCount(), 0);
	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.attemptTotalCount, 0);
	assert.equal(snapshot.batchRequestCount, 0);
	assert.equal(snapshot.streamAttemptCount, 0);
	assert.deepEqual(snapshot.wireObservation, {
		schemaVersion: "w0-1",
		generation: 100,
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
	assert.doesNotMatch(JSON.stringify(snapshot), /timer|listener|controller|pendingSave/i,
		"the W0 owner acquired a resource instead of remaining synchronous and in-memory");
});

test("W0 throwing physical observers do not alter completion or leak their error text", () => {
	const secret = "W0_OBSERVER_THROW_SECRET";
	let clock = 1000;
	let callbackCount = 0;
	const store = createProviderLatencyStore({now: () => ++clock});
	const client = createProviderClient({
		request: (_url, _options, callback) => {
			callback(null, {statusCode: 200, headers: {}}, JSON.stringify({choices: [{message: {content: "ok"}}]}));
			return {abort() {}};
		},
		setTimeout: () => ({fixture: "timer"}),
		clearTimeout: () => {},
		now: () => ++clock,
		recordLatencyEvent: event => store.recordLatencyEvent(event)
	});
	const token = store.beginLatencyRequest({kind: "manual", lane: "manual"});
	client.requestWithTimeout("https://fixture.invalid", {method: "post", body: `{"secret":"${secret}"}`}, () => {callbackCount++;}, 30000, {
		token,
		role: "primary",
		engineKey: "oaicompat",
		engineFamily: "custom",
		lane: "manual",
		messageCount: 1,
		diagnosticRequestObserver: () => {throw new Error(secret);},
		diagnosticStageObserver: () => {throw new Error(secret);},
		wireObservationProbe: Object.freeze({observe: () => {throw new Error(secret);}}),
		usageFromBody: () => {throw new Error(secret);}
	});

	assert.equal(callbackCount, 1, "observer failure changed the provider callback contract");
	assert.equal(store.getAttemptsCount(), 1);
	assert.deepEqual([
		store.getLatencySnapshot().latestAttempt.promptTokens,
		store.getLatencySnapshot().latestAttempt.completionTokens,
		store.getLatencySnapshot().latestAttempt.reasoningTokens
	], [null, null, null]);
	assert.doesNotMatch(JSON.stringify(store.getLatencySnapshot()), new RegExp(secret));
});

test("W0 rejected observer promises are consumed without an unhandled rejection", async () => {
	const failures = [];
	const onUnhandled = reason => failures.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const store = createProviderLatencyStore();
		const client = createProviderClient({
			request: (_url, _options, callback) => {callback(null, {statusCode: 200, headers: {}}, JSON.stringify({choices: [{message: {content: "ok"}}]})); return {abort() {}};},
			setTimeout: () => 1,
			clearTimeout: () => {},
			recordLatencyEvent: event => store.recordLatencyEvent(event)
		});
		const token = store.beginLatencyRequest({kind: "manual", lane: "manual"});
		client.requestWithTimeout("https://fixture.invalid", {method: "post", body: "{}"}, () => {}, 30000, {
			token,
			role: "primary",
			engineKey: "oaicompat",
			diagnosticRequestObserver: () => Promise.reject(new Error("ASYNC_REQUEST_REJECT")),
			diagnosticStageObserver: () => Promise.reject(new Error("ASYNC_STAGE_REJECT")),
			wireObservationProbe: {observe: () => Promise.reject(new Error("ASYNC_PROBE_REJECT"))},
			usageFromBody: () => Promise.reject(new Error("ASYNC_USAGE_REJECT"))
		});
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(failures, []);
		assert.equal(store.getAttemptsCount(), 1);
	}
	finally {process.removeListener("unhandledRejection", onUnhandled);}
});
