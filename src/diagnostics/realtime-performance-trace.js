// Owns the F0 realtime-performance observations: bounded queue/dispatch counters,
// per-message queue-wait quantiles, enqueue-to-DOM spans and a bounded lifecycle
// trace. Pure observation - it never schedules timers, never touches the network
// and never alters queue or display behaviour. Payloads carry only ids, enums and
// numbers; message text, prompts, endpoints, keys, headers and responses never
// enter this module. Factory function only: no module-level shared mutable state.

// TTFT contract for later slices (F2a measures it; F0 only pins the definition):
// measured from the physical attempt dispatch to the first NON-EMPTY translation
// body delta. Everything before real translated text - HTTP headers, SSE comments,
// role events, reasoning deltas, usage blocks - does not count. A non-streaming
// request has no TTFT; reporting total time in its place is forbidden.
const TTFT_DEFINITION = Object.freeze({
	measuredFrom: "physical-attempt-dispatch",
	firstCountedEvent: "first-non-empty-translation-body-delta",
	excludes: Object.freeze(["http-headers", "sse-comments", "role-events", "reasoning-deltas", "usage-blocks"]),
	nonStreamingValue: null
});

const TRACE_LIMIT = 200;
const WAIT_SAMPLE_LIMIT = 50;
const MIN_QUANTILE_SAMPLES = 5;
// Only these payload fields may enter the trace ring; anything else is dropped so a
// future call site cannot accidentally widen the privacy footprint.
const TRACE_PAYLOAD_KEYS = ["channelId", "messageId", "queueDepth", "queueWaitMs", "mode", "batchSize", "site", "reason", "messageCount", "spanMs", "active"];
const BLOCK_REASON_KEYS = {"manual-lock": "manualLock", "live-lock": "liveLock", "backoff": "backoff"};
const STALE_SITE_KEYS = {"queue-head": "queueHead", "burst-pre": "burstPre", "burst-requeue": "burstRequeue", "burst-post": "burstPost"};

function createRealtimePerformanceTrace({now = Date.now, traceLimit = TRACE_LIMIT, waitSampleLimit = WAIT_SAMPLE_LIMIT, onDomObservation = () => {}, getObservationGeneration = () => null} = {}) {
	let generation = 0;
	let entries = [];
	let queueWaitSamples = [];
	let domSpanSamples = [];
	// Open enqueue-to-DOM spans keyed by channel:message. Bounded by the trace limit
	// so an abandoned span can never grow the map without bound.
	let openSpans = new Map();
	let deferredSpans = new Set();
	let counters = createCounters();

	function createCounters() {
		return {
			enqueued: 0,
			dispatchedSingle: 0,
			dispatchedBurstMessages: 0,
			burstRequests: 0,
			cachedServes: 0,
			guardDrops: 0,
			requeues: 0,
			queueDepthHighWater: 0,
			laneActiveCurrent: 0,
			laneActiveHighWater: 0,
			blocked: {manualLock: 0, liveLock: 0, backoff: 0},
			staleDrops: {queueHead: 0, burstPre: 0, burstRequeue: 0, burstPost: 0}
		};
	}

	function appendTrace(type, payload) {
		const entry = {type, at: now()};
		for (const key of TRACE_PAYLOAD_KEYS) {
			if (payload && payload[key] != null) entry[key] = payload[key];
		}
		entries.push(Object.freeze(entry));
		if (entries.length > traceLimit) entries.splice(0, entries.length - traceLimit);
	}

	function pushSample(samples, value) {
		samples.push(Math.max(0, Number(value) || 0));
		if (samples.length > waitSampleLimit) samples.splice(0, samples.length - waitSampleLimit);
	}

	function getNearestRankStats(samples) {
		const count = samples.length;
		if (count < MIN_QUANTILE_SAMPLES) return {count, sufficient: false, p50Ms: null, p95Ms: null};
		const sorted = samples.slice().sort((a, b) => a - b);
		const rank = quantile => sorted[Math.max(0, Math.min(count - 1, Math.ceil(quantile * count) - 1))];
		return {count, sufficient: true, p50Ms: rank(0.50), p95Ms: rank(0.95)};
	}

	function spanKey(payload) {
		if (!payload || payload.channelId == null || payload.messageId == null) return null;
		return `${payload.channelId}:${payload.messageId}`;
	}

	function openSpan(payload) {
		const key = spanKey(payload);
		if (!key) return;
		let observationGeneration = null;
		try {observationGeneration = getObservationGeneration();} catch (error) {}
		openSpans.set(key, Object.freeze({startedAt: now(), generation: observationGeneration, requestId: null}));
		if (openSpans.size > traceLimit) {
			const oldestKey = openSpans.keys().next().value;
			openSpans.delete(oldestKey);
		}
	}

	function abandonSpan(payload) {
		const key = spanKey(payload);
		if (!key) return null;
		const entry = openSpans.get(key) || null;
		openSpans.delete(key); deferredSpans.delete(key);
		return entry;
	}
	function linkAttempt(payload) {
		const key = spanKey(payload), current = key && openSpans.get(key);
		if (!current || payload && payload.requestId == null) return false;
		openSpans.set(key, Object.freeze({startedAt: current.startedAt, generation: payload.generation == null ? current.generation : payload.generation, requestId: Math.max(0, Number(payload.requestId) || 0)}));
		return true;
	}
	function emitDomObservation(value) {try {const result = onDomObservation(Object.freeze(value)); if (result && typeof result.then == "function") Promise.resolve(result).catch(() => {});} catch (error) {}}

	function notify(type, payload) {
		switch (type) {
			case "enqueued":
				counters.enqueued++;
				counters.queueDepthHighWater = Math.max(counters.queueDepthHighWater, Math.max(0, Number(payload && payload.queueDepth) || 0));
				openSpan(payload);
				appendTrace(type, payload);
				return;
			case "blocked": {
				const reasonKey = BLOCK_REASON_KEYS[payload && payload.reason];
				if (reasonKey) counters.blocked[reasonKey]++;
				appendTrace(type, payload);
				return;
			}
			case "dispatched":
				if (payload && payload.mode === "burst") counters.dispatchedBurstMessages++;
				else counters.dispatchedSingle++;
				if (payload && payload.queueWaitMs != null) pushSample(queueWaitSamples, payload.queueWaitMs);
				appendTrace(type, payload);
				return;
			case "burst-request":
				counters.burstRequests++;
				appendTrace(type, payload);
				return;
			case "stale-drop": {
				const siteKey = STALE_SITE_KEYS[payload && payload.site];
				if (siteKey) counters.staleDrops[siteKey]++;
				const abandoned = abandonSpan(payload);
				if (abandoned) emitDomObservation({generation: abandoned.generation, requestId: abandoned.requestId, outcome: "stale", enqueueToDomMs: null});
				appendTrace(type, payload);
				return;
			}
			case "cached-serve":
				counters.cachedServes++;
				appendTrace(type, payload);
				return;
			case "guard-drop":
				counters.guardDrops++;
				const abandoned = abandonSpan(payload);
				if (abandoned) emitDomObservation({generation: abandoned.generation, requestId: abandoned.requestId, outcome: "failed", enqueueToDomMs: null});
				appendTrace(type, payload);
				return;
			case "requeued":
				counters.requeues++;
				appendTrace(type, payload);
				return;
			case "lane-active": {
				const active = Math.max(0, Number(payload && payload.active) || 0);
				counters.laneActiveCurrent = active;
				counters.laneActiveHighWater = Math.max(counters.laneActiveHighWater, active);
				appendTrace(type, payload);
				return;
			}
			default:
				return;
		}
	}

	// Fed from the repaint scheduler's onRenderOutcome report; a confirmed repaint is
	// the DOM end of the enqueue-to-DOM span.
	function onRenderOutcome(report) {
		if (!report || !report.outcome) return;
		const channelId = report.channelId;
		for (const messageId of report.outcome.confirmedIds || []) {
			const key = spanKey({channelId, messageId});
			if (!key || !openSpans.has(key)) continue;
			const span = openSpans.get(key);
			openSpans.delete(key);
			deferredSpans.delete(key);
			const spanMs = Math.max(0, now() - span.startedAt);
			pushSample(domSpanSamples, spanMs);
			appendTrace("dom-confirmed", {channelId, messageId: String(messageId), spanMs});
			emitDomObservation({generation: span.generation, requestId: span.requestId, outcome: "confirmed", enqueueToDomMs: spanMs});
		}
		for (const messageId of report.outcome.deferredIds || []) {const key = spanKey({channelId, messageId}), span = key && openSpans.get(key); if (span && !deferredSpans.has(key)) {deferredSpans.add(key); emitDomObservation({generation: span.generation, requestId: span.requestId, outcome: "deferred", enqueueToDomMs: null});}}
	}

	function getSnapshot() {
		const queueWait = getNearestRankStats(queueWaitSamples);
		const enqueueToDom = getNearestRankStats(domSpanSamples);
		return Object.freeze({
			generation,
			enqueuedCount: counters.enqueued,
			dispatchedSingleCount: counters.dispatchedSingle,
			dispatchedBurstMessageCount: counters.dispatchedBurstMessages,
			burstRequestCount: counters.burstRequests,
			cachedServeCount: counters.cachedServes,
			guardDropCount: counters.guardDrops,
			requeuedCount: counters.requeues,
			queueDepthHighWater: counters.queueDepthHighWater,
			blocked: Object.freeze(Object.assign({}, counters.blocked)),
			staleDrops: Object.freeze(Object.assign({}, counters.staleDrops)),
			laneActive: Object.freeze({current: counters.laneActiveCurrent, highWater: counters.laneActiveHighWater}),
			queueWait: Object.freeze({count: queueWait.count, sufficient: queueWait.sufficient, p50Ms: queueWait.p50Ms, p95Ms: queueWait.p95Ms}),
			enqueueToDom: Object.freeze({count: enqueueToDom.count, sufficient: enqueueToDom.sufficient, p50Ms: enqueueToDom.p50Ms, p95Ms: enqueueToDom.p95Ms}),
			traceLength: entries.length
		});
	}

	function listTrace({channelId, messageId} = {}) {
		return entries.filter(entry => (!channelId || entry.channelId === channelId) && (!messageId || entry.messageId === messageId));
	}

	function reset() {
		generation++;
		entries = [];
		queueWaitSamples = [];
		domSpanSamples = [];
		openSpans = new Map();
		deferredSpans = new Set();
		counters = createCounters();
	}

	return Object.freeze({
		queueObserver: Object.freeze({notify}),
		linkAttempt,
		onRenderOutcome,
		getSnapshot,
		listTrace,
		reset,
		getGeneration: () => generation
	});
}

module.exports = {TTFT_DEFINITION, createRealtimePerformanceTrace};
