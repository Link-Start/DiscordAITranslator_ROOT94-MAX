const test = require("node:test");
const assert = require("node:assert/strict");
const {createProviderLatencyStore} = require("../../src/diagnostics/provider-latency-store");

test("provider latency store creates frozen token on beginLatencyRequest", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({
		kind: "live",
		queueWaitMs: 150,
		messageCount: 3,
		inputChars: 480
	});

	assert.equal(token.generation, 0);
	assert.equal(token.kind, "live");
	assert.equal(token.queueWaitMs, 150);
	assert.equal(token.messageCount, 3);
	assert.equal(token.inputChars, 480);
	assert.ok(token.requestId > 0);
	assert.ok(Object.isFrozen(token));
});

test("provider latency store records attempts up to 20 in ring buffer and calculates nearest-rank P50/P95", () => {
	let currentTime = 1000;
	const store = createProviderLatencyStore({now: () => currentTime});

	// Record 4 completed live requests for deepseek (below n=5 threshold)
	for (let i = 1; i <= 4; i++) {
		const token = store.beginLatencyRequest({kind: "live", queueWaitMs: 50, messageCount: 1});
		store.recordLatencyEvent({
			token,
			role: "primary",
			engineKey: "deepseek",
			transportMs: i * 100,
			status: "ok"
		});
	}

	let snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.sampleCount, 4);
	assert.equal(snapshot.sufficient, false);
	assert.equal(snapshot.p50Ms, null);
	assert.equal(snapshot.p95Ms, null);
	assert.equal(snapshot.latestAttempt.transportMs, 400);

	// Add 5th sample (100, 200, 300, 400, 500) -> n=5, sufficient=true
	const token5 = store.beginLatencyRequest({kind: "manual", messageCount: 1});
	store.recordLatencyEvent({
		token: token5,
		role: "primary",
		engineKey: "deepseek",
		transportMs: 500,
		status: "ok"
	});

	snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.sampleCount, 5);
	assert.equal(snapshot.sufficient, true);
	// Sorted: [100, 200, 300, 400, 500]
	// P50: ceil(0.50 * 5) - 1 = 3 - 1 = index 2 -> 300
	// P95: ceil(0.95 * 5) - 1 = 5 - 1 = index 4 -> 500
	assert.equal(snapshot.p50Ms, 300);
	assert.equal(snapshot.p95Ms, 500);

	// Detect requests are excluded from P50/P95 but appear in latestAttempt
	const detectToken = store.beginLatencyRequest({kind: "detect"});
	store.recordLatencyEvent({
		token: detectToken,
		role: "primary",
		engineKey: "deepseek",
		transportMs: 50,
		status: "ok"
	});

	snapshot = store.getLatencySnapshot({engineKey: "deepseek"});
	assert.equal(snapshot.sampleCount, 5); // still 5, detect excluded
	assert.equal(snapshot.latestAttempt.kind, "detect");
	assert.equal(snapshot.latestAttempt.transportMs, 50);
	assert.equal(snapshot.latestTranslation.transportMs, 500);
	assert.equal(snapshot.latestDetect.transportMs, 50);
	assert.equal(snapshot.engineKey, "deepseek", "detect must not replace the translation statistics engine");

	// Ring buffer overflow past 20 items
	for (let i = 6; i <= 25; i++) {
		const tok = store.beginLatencyRequest({kind: "live"});
		store.recordLatencyEvent({
			token: tok,
			role: "primary",
			engineKey: "deepseek",
			transportMs: i * 100,
			status: "ok"
		});
	}

	assert.equal(store.getAttemptsCount(), 20);
});

test("provider latency store deduplicates failover count within the same logical requestId", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "live", queueWaitMs: 80});

	// Primary fails
	store.recordLatencyEvent({
		token,
		role: "primary",
		engineKey: "openai",
		transportMs: 1200,
		status: "http_429",
		errorClass: "rate_limit"
	});

	// First backup attempt -> failoverCount becomes 1, rateLimitCount becomes 1
	store.recordLatencyEvent({
		token,
		role: "backup",
		engineKey: "deepseek",
		transportMs: 800,
		status: "http_500",
		errorClass: "server"
	});

	assert.equal(store.getLatencySnapshot().failoverCount, 1);
	assert.equal(store.getLatencySnapshot().rateLimitCount, 1);

	// Second backup retry -> failoverCount MUST remain 1
	store.recordLatencyEvent({
		token,
		role: "backup",
		engineKey: "deepseek",
		transportMs: 600,
		status: "ok"
	});

	assert.equal(store.getLatencySnapshot().failoverCount, 1);
});

test("provider latency store accepts only the new invalid-request enums and never stores body text", () => {
	const store = createProviderLatencyStore();
	for (const errorClass of ["invalid_request", "unsupported_field", "unsupported_value", "sampling_conflict", "schema"]) {
		const token = store.beginLatencyRequest({kind: "detect", inputChars: 12});
		store.recordLatencyEvent({token, engineKey: "oaicompat", status: "http_400", httpStatus: 400, errorClass, rawErrorMessage: "secret body", responseBody: "secret body"});
	}
	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.attemptsCount, 5);
	assert.equal(snapshot.latestDetect.errorClass, "schema");
	assert.doesNotMatch(JSON.stringify(snapshot), /secret body|rawErrorMessage|responseBody/);
});

test("provider latency store drops events from stale generations after resetLatency", () => {
	const store = createProviderLatencyStore();
	const oldToken = store.beginLatencyRequest({kind: "live"});

	store.resetLatency();

	// Attempt from old token after reset
	store.recordLatencyEvent({
		token: oldToken,
		role: "primary",
		engineKey: "deepseek",
		transportMs: 300,
		status: "ok"
	});

	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.latestAttempt, null);
	assert.equal(snapshot.sampleCount, 0);
	assert.equal(snapshot.failoverCount, 0);
});

test("provider latency snapshots keep queue wait zero and ignore sensitive extras", () => {
	const store = createProviderLatencyStore();
	const token = store.beginLatencyRequest({kind: "live", queueWaitMs: 0, inputChars: 12});
	store.recordLatencyEvent({
		token,
		engineKey: "openai",
		transportMs: 10,
		status: "ok",
		outputChars: 8,
		endpoint: "SENSITIVE_ENDPOINT",
		key: "SENSITIVE_KEY",
		messageText: "SENSITIVE_MESSAGE",
		rawErrorMessage: "SENSITIVE_ERROR"
	});
	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.queueWaitMs, 0);
	assert.equal(snapshot.latestTranslation.inputChars, 12);
	assert.equal(snapshot.latestTranslation.outputChars, 8);
	const serialized = JSON.stringify(snapshot);
	for (const value of ["SENSITIVE_ENDPOINT", "SENSITIVE_KEY", "SENSITIVE_MESSAGE", "SENSITIVE_ERROR"]) assert.doesNotMatch(serialized, new RegExp(value));
});

test("detect cannot hide the latest translation or its queue wait and queue percentiles count logical requests once", () => {
	const store = createProviderLatencyStore();
	for (let i = 1; i <= 5; i++) {
		const token = store.beginLatencyRequest({kind: "live", queueWaitMs: i * 10, messageCount: i, inputChars: i * 100});
		store.recordLatencyEvent({token, role: "primary", engineKey: "oaicompat", transportMs: i * 1000, status: "ok", outputChars: i * 50});
		if (i === 5) store.recordLatencyEvent({token, role: "backup", engineKey: "openai", transportMs: 200, status: "ok", outputChars: 40});
	}
	const detect = store.beginLatencyRequest({kind: "detect", inputChars: 5});
	store.recordLatencyEvent({token: detect, engineKey: "oaicompat", transportMs: 100, status: "ok", outputChars: 2});

	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.latestAttempt.kind, "detect");
	assert.equal(snapshot.latestTranslation.kind, "live");
	assert.equal(snapshot.latestTranslation.role, "backup");
	assert.equal(snapshot.latestDetect.transportMs, 100);
	assert.equal(snapshot.queueWaitMs, 50);
	assert.equal(snapshot.queueSampleCount, 5, "the backup attempt must not duplicate its logical queue wait");
	assert.equal(snapshot.queueP50Ms, 30);
	assert.equal(snapshot.queueP95Ms, 50);
});

test("all-detect rings expose no translation sample and eviction updates derived latest records", () => {
	const store = createProviderLatencyStore();
	for (let i = 0; i < 20; i++) {
		const token = store.beginLatencyRequest({kind: i === 0 ? "live" : "detect"});
		store.recordLatencyEvent({token, engineKey: "openai", transportMs: i, status: "ok"});
	}
	assert.equal(store.getLatencySnapshot().latestTranslation.kind, "live");
	const overflow = store.beginLatencyRequest({kind: "detect"});
	store.recordLatencyEvent({token: overflow, engineKey: "openai", transportMs: 21, status: "ok"});
	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.latestTranslation, null);
	assert.equal(snapshot.latestDetect.transportMs, 21);
	assert.equal(snapshot.sampleCount, 0);
});

test("provider quantiles stay isolated to one engine and successful translations", () => {
	const store = createProviderLatencyStore();
	for (const [engineKey, kind, status, duration] of [
		["openai", "live", "ok", 100],
		["openai", "manual", "ok", 200],
		["openai", "historical", "ok", 300],
		["openai", "live", "ok", 400],
		["openai", "live", "ok", 500],
		["openai", "detect", "ok", 1],
		["openai", "live", "timeout", 30000],
		["gemini", "live", "ok", 9000]
	]) {
		const token = store.beginLatencyRequest({kind});
		store.recordLatencyEvent({token, engineKey, transportMs: duration, status});
	}
	const snapshot = store.getLatencySnapshot({engineKey: "openai"});
	assert.equal(snapshot.sampleCount, 5);
	assert.equal(snapshot.p50Ms, 300);
	assert.equal(snapshot.p95Ms, 500);
});

test("historical physical counters exclude other lanes and reset with the session", () => {
	const store = createProviderLatencyStore();
	for (const kind of ["live", "manual", "detect"]) {
		const token = store.beginLatencyRequest({kind, messageCount: 10});
		store.recordLatencyEvent({token, engineKey: "openai", status: "ok"});
	}
	let snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.historicalAttemptCount, 0);
	assert.equal(snapshot.historicalBatchRequestCount, 0);

	const single = store.beginLatencyRequest({kind: "historical", messageCount: 1});
	store.recordLatencyEvent({token: single, engineKey: "openai", status: "ok"});
	const batch = store.beginLatencyRequest({kind: "historical", messageCount: 10});
	store.recordLatencyEvent({token: batch, role: "primary", engineKey: "openai", status: "http_429", errorClass: "rate_limit"});
	store.recordLatencyEvent({token: batch, role: "backup", engineKey: "openai", status: "timeout", errorClass: "timeout"});
	store.recordLatencyEvent({token: batch, role: "backup", engineKey: "openai", status: "ok"});

	snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.historicalAttemptCount, 4);
	assert.equal(snapshot.historicalBatchRequestCount, 3);
	assert.equal(snapshot.historicalBatchMessageCount, 30);
	assert.equal(snapshot.historicalFailoverCount, 1);
	assert.equal(snapshot.historicalTimeoutCount, 1);
	assert.equal(snapshot.historicalRateLimitCount, 1);

	store.resetLatency();
	snapshot = store.getLatencySnapshot();
	for (const field of ["historicalAttemptCount", "historicalBatchRequestCount", "historicalBatchMessageCount", "historicalFailoverCount", "historicalTimeoutCount", "historicalRateLimitCount"]) assert.equal(snapshot[field], 0);
	assert.equal(store.recordLatencyEvent({token: batch, status: "ok"}), null, "a stale historical attempt cannot repopulate reset counters");
});

test("live TTFT diagnostics count only first non-empty streaming body deltas", () => {
	const store = createProviderLatencyStore({now: () => 9000});
	for (const ttftMs of [80, 120, 160, 200, 240]) {
		const token = store.beginLatencyRequest({kind: "live", messageCount: 1});
		store.recordLatencyEvent({
			token,
			engineKey: "openai",
			transportMs: 500,
			status: "ok",
			streaming: true,
			ttftMs,
			streamChunkCount: 3
		});
	}
	const nonStreaming = store.beginLatencyRequest({kind: "live"});
	store.recordLatencyEvent({token: nonStreaming, engineKey: "openai", transportMs: 40, status: "ok"});
	const reasoningOnly = store.beginLatencyRequest({kind: "live"});
	store.recordLatencyEvent({token: reasoningOnly, engineKey: "openai", transportMs: 60, status: "ok", streaming: true, streamChunkCount: 2});

	const snapshot = store.getLatencySnapshot({engineKey: "openai"});
	assert.equal(snapshot.liveTtftSampleCount, 5);
	assert.equal(snapshot.liveTtftSufficient, true);
	assert.equal(snapshot.liveTtftP50Ms, 160);
	assert.equal(snapshot.liveTtftP95Ms, 240);
	assert.equal(snapshot.streamAttemptCount, 6);
	assert.equal(snapshot.streamChunkCount, 17);
	assert.equal(snapshot.latestTranslation.ttftMs, null, "a stream without a body delta stays null instead of borrowing total time");
});

test("stream fallback and cancellation counters remain anonymous and bounded", () => {
	const store = createProviderLatencyStore();
	const fallback = store.beginLatencyRequest({kind: "live"});
	store.recordLatencyEvent({token: fallback, engineKey: "openai", status: "ok", streaming: true, streamFallback: true});
	const cancelled = store.beginLatencyRequest({kind: "live"});
	store.recordLatencyEvent({token: cancelled, engineKey: "openai", status: "cancelled", errorClass: "abort", streaming: true});
	const snapshot = store.getLatencySnapshot();
	assert.equal(snapshot.streamFallbackCount, 1);
	assert.equal(snapshot.streamCancelCount, 1);
	assert.equal(snapshot.latestTranslation.errorClass, "abort");
});
