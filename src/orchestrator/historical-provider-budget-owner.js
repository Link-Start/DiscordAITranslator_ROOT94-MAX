// S3H owns logical historical provider admission. It bounds callback-era dispatches by
// captured Transport Key and by logical request, but deliberately makes no S4 claim that
// a timed-out callback transport has physically stopped in the background.

const MAX_HISTORICAL_ITEMS_PER_ATTEMPT = 10;
const MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT = 12000;
const MAX_HISTORICAL_BODY_BYTES_PER_ATTEMPT = 65536;
const MAX_HISTORICAL_ESTIMATED_TOKENS_PER_ATTEMPT = 16384;
const MAX_HISTORICAL_ATTEMPTS_PER_LOGICAL = 3;
const MAX_HISTORICAL_PROVIDER_CAPACITY = 4;
const ALLOWED_ROLES = new Set(["primary", "repair", "backup"]);

function whole(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function normalizeCapacity(value) {
	return Math.max(1, Math.min(MAX_HISTORICAL_PROVIDER_CAPACITY, whole(value, 1) || 1));
}

function denial(reason, exceeded = null) {
	const result = {granted: false, reason};
	if (exceeded && exceeded.length) result.exceeded = Object.freeze(exceeded.slice());
	return Object.freeze(result);
}

function createHistoricalProviderBudgetOwner({capacity = 2, now = Date.now, serverCooldownMs = 1000, defaultRateLimitMs = 5000, unhealthyCooldownMs = 15000, unhealthyCooldownMaxMs = 300000, healthLimit = 32} = {}) {
	let generation = 0;
	let logicalSequence = 0;
	let attemptSequence = 0;
	let configuredCapacity = normalizeCapacity(capacity);
	let stopped = false;
	let logicals = new Map();
	let keys = new Map();
	let healthByKey = new Map();
	let capacityByKey = new Map();
	let activeLeases = new Map();
	let drainWaiters = [];
	let counters = createCounters();

	function createCounters() {
		return {
			grantedAttempts: 0,
			settledAttempts: 0,
			deniedAttemptBudget: 0,
			deniedRequestBudget: 0,
			cancelledAdmissions: 0,
			stoppedAdmissions: 0,
			oversizedSingles: 0,
			rateLimits: 0,
			serverCooldowns: 0,
			invalidatedHealth: 0,
			highWater: 0,
			maxActiveByKey: 0,
			roleGrants: {primary: 0, repair: 0, backup: 0}
		};
	}

	function getLogical(token) {
		if (!token || token.generation !== generation) return null;
		return logicals.get(token.logicalId) || null;
	}

	function logicalIsCurrent(entry, requestCheck = null) {
		if (!entry || entry.cancelled || entry.finished || stopped) return false;
		for (const check of [entry.isCurrent, requestCheck]) {
			if (typeof check != "function") continue;
			try {if (check() !== true) return false;}
			catch (error) {return false;}
		}
		return true;
	}

	function beginLogical({isCurrent = null} = {}) {
		if (stopped) return null;
		const token = Object.freeze({generation, logicalId: ++logicalSequence});
		logicals.set(token.logicalId, {token, isCurrent, cancelled: false, finished: false, active: 0, reserved: 0, dispatched: 0});
		return token;
	}

	function normalizeTransportKey(value) {
		const key = String(value == null ? "" : value);
		return /^tk1:[a-z0-9:-]{1,72}$/i.test(key) ? key : null;
	}

	function timestamp() {
		try {const value = Number(now()); return Number.isFinite(value) ? Math.max(0, value) : 0;}
		catch (error) {return 0;}
	}

	function rememberHealth(transportKey, health) {
		if (healthByKey.has(transportKey)) healthByKey.delete(transportKey);
		healthByKey.set(transportKey, health);
		const limit = Math.max(1, whole(healthLimit, 32) || 32);
		while (healthByKey.size > limit) healthByKey.delete(healthByKey.keys().next().value);
		return health;
	}

	function healthDenial(transportKey) {
		const health = healthByKey.get(transportKey);
		if (!health) return null;
		if (health.blocked) return denial("provider_unhealthy");
		const remaining = Math.max(0, health.cooldownUntil - timestamp());
		return remaining > 0 ? Object.freeze({granted: false, reason: health.reason, retryAfterMs: Math.ceil(remaining)}) : null;
	}

	function keyCapacity(transportKey) {
		const health = healthByKey.get(transportKey);
		const healthCapacity = health && health.recovery ? 1 : configuredCapacity;
		const adaptiveCapacity = capacityByKey.get(transportKey);
		return Math.max(1, Math.min(healthCapacity, adaptiveCapacity == null ? configuredCapacity : normalizeCapacity(adaptiveCapacity)));
	}

	function applyHealthOutcome(transportKey, outcome = {}, healthAtGrant = null) {
		const statusCode = whole(outcome.statusCode);
		const errorClass = String(outcome.errorClass || outcome.failureKind || "");
		const current = healthByKey.get(transportKey);
		const rateLimitUntil = current && current.rateLimitUntil || 0;
		if (["auth", "configuration", "schema", "not_found", "invalid_request", "unsupported_field", "unsupported_value"].includes(errorClass)) {
			// A configuration-class failure (bad key/endpoint/schema, or a 4xx returned while
			// the provider is still starting up) used to block the key permanently: cooldownUntil
			// 0, recovery false, cleared only by a 2xx that could never arrive because admission
			// was denied first. One transient startup 4xx therefore trapped historical translation
			// for the whole Discord session, and the retry affordance kept re-hitting the same wall.
			// It is now a half-open breaker: cool down (backing off on consecutive failures), then
			// admit a single recovery probe (recovery caps the key at 1). A 2xx clears the key; another
			// failure re-cools with a longer delay, so a genuinely broken provider still backs off.
			const streak = Math.max(1, whole(current && current.unhealthyStreak) + 1);
			const base = Math.max(1, whole(unhealthyCooldownMs, 15000) || 15000);
			const ceiling = Math.max(base, whole(unhealthyCooldownMaxMs, 300000) || 300000);
			const delay = Math.min(ceiling, base * Math.pow(2, Math.min(streak - 1, 20)));
			counters.invalidatedHealth++;
			rememberHealth(transportKey, {blocked: false, reason: "provider_unhealthy", cooldownUntil: Math.max(current && current.cooldownUntil || 0, timestamp() + delay), recovery: true, unhealthyStreak: streak, rateLimitUntil});
			return;
		}
		if (statusCode === 429 || errorClass === "rate_limit") {
			const delay = Math.max(1, whole(outcome.retryAfterMs, whole(defaultRateLimitMs, 5000) || 5000));
			counters.rateLimits++;
			rememberHealth(transportKey, {blocked: false, reason: "rate_limit", cooldownUntil: Math.max(current && current.cooldownUntil || 0, timestamp() + delay), recovery: true, rateLimitUntil: Math.max(rateLimitUntil, timestamp() + delay)});
			return;
		}
		if (statusCode >= 500 && statusCode <= 599 || errorClass === "server") {
			const delay = Math.max(1, whole(serverCooldownMs, 1000) || 1000);
			counters.serverCooldowns++;
			rememberHealth(transportKey, {blocked: false, reason: "server_cooldown", cooldownUntil: Math.max(current && current.cooldownUntil || 0, timestamp() + delay), recovery: true, rateLimitUntil});
			return;
		}
		if (statusCode >= 200 && statusCode < 300 && !errorClass) {
			// Health entries are immutable revisions. Older in-flight successes cannot
			// clear a failure or half-open reset recorded after their admission.
			if (current && current !== healthAtGrant) return;
			// An older concurrent success does not revoke a newer server Retry-After window.
			if (rateLimitUntil > timestamp()) rememberHealth(transportKey, {blocked: false, reason: "rate_limit", cooldownUntil: rateLimitUntil, recovery: true, rateLimitUntil});
			else healthByKey.delete(transportKey);
		}
	}

	function exceededDimensions({itemCount, protectedChars, bodyBytes, estimatedTokens}) {
		const exceeded = [];
		if (itemCount > MAX_HISTORICAL_ITEMS_PER_ATTEMPT) exceeded.push("items");
		if (protectedChars > MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT) exceeded.push("protected_chars");
		if (bodyBytes > MAX_HISTORICAL_BODY_BYTES_PER_ATTEMPT) exceeded.push("body_bytes");
		if (estimatedTokens > MAX_HISTORICAL_ESTIMATED_TOKENS_PER_ATTEMPT) exceeded.push("estimated_tokens");
		return exceeded;
	}

	function getKeyState(transportKey) {
		let state = keys.get(transportKey);
		if (!state) {
			state = {transportKey, active: 0, exclusiveActive: false, waiters: []};
			keys.set(transportKey, state);
		}
		return state;
	}

	function maybeDeleteLogical(entry) {
		if (entry && !entry.active && !entry.reserved && (entry.cancelled || entry.finished)) logicals.delete(entry.token.logicalId);
	}

	function maybeDeleteKey(state) {
		if (state && !state.active && !state.waiters.length) keys.delete(state.transportKey);
	}

	function settleDrain() {
		if (activeLeases.size || [...keys.values()].some(state => state.waiters.length)) return;
		const waiters = drainWaiters;
		drainWaiters = [];
		for (const resolve of waiters) resolve();
	}

	function denyWaiter(waiter, reason) {
		waiter.logical.reserved = Math.max(0, waiter.logical.reserved - 1);
		if (reason === "cancelled" || reason === "finished") counters.cancelledAdmissions++;
		else if (reason === "stopped") counters.stoppedAdmissions++;
		waiter.resolve(denial(reason === "finished" ? "cancelled" : reason));
		maybeDeleteLogical(waiter.logical);
	}

	function grantWaiter(state, waiter) {
		const entry = waiter.logical;
		entry.reserved = Math.max(0, entry.reserved - 1);
		entry.dispatched++;
		entry.active++;
		state.active++;
		if (waiter.oversized) state.exclusiveActive = true;
		const lease = Object.freeze({
			granted: true,
			generation,
			logicalId: entry.token.logicalId,
			attemptId: ++attemptSequence,
			transportKey: state.transportKey,
			role: waiter.role,
			oversized: waiter.oversized,
			exceeded: Object.freeze(waiter.exceeded.slice())
		});
		activeLeases.set(lease, {lease, logical: entry, key: state, healthAtGrant: healthByKey.get(state.transportKey)});
		counters.grantedAttempts++;
		counters.roleGrants[waiter.role]++;
		if (waiter.oversized) counters.oversizedSingles++;
		counters.highWater = Math.max(counters.highWater, activeLeases.size);
		counters.maxActiveByKey = Math.max(counters.maxActiveByKey, state.active);
		waiter.resolve(lease);
	}

	function pumpKey(state) {
		const blocked = state && healthDenial(state.transportKey);
		if (blocked) {
			while (state.waiters.length) {
				const waiter = state.waiters.shift();
				waiter.logical.reserved = Math.max(0, waiter.logical.reserved - 1);
				waiter.resolve(blocked);
				maybeDeleteLogical(waiter.logical);
			}
			maybeDeleteKey(state);
			settleDrain();
			return;
		}
		while (state && state.waiters.length) {
			const waiter = state.waiters[0];
			if (!logicalIsCurrent(waiter.logical, waiter.isCurrent)) {
				state.waiters.shift();
				denyWaiter(waiter, stopped ? "stopped" : "cancelled");
				continue;
			}
			if (state.exclusiveActive) break;
			if (waiter.oversized) {
				if (state.active) break;
				state.waiters.shift();
				grantWaiter(state, waiter);
				break;
			}
			if (state.active >= keyCapacity(state.transportKey)) break;
			state.waiters.shift();
			grantWaiter(state, waiter);
		}
		maybeDeleteKey(state);
		settleDrain();
	}

	function acquireAttempt(logicalToken, request = {}) {
		const entry = getLogical(logicalToken);
		if (!entry) return Promise.resolve(denial(stopped ? "stopped" : "cancelled"));
		if (!logicalIsCurrent(entry, request.isCurrent)) return Promise.resolve(denial(stopped ? "stopped" : "cancelled"));
		if (entry.dispatched + entry.reserved >= MAX_HISTORICAL_ATTEMPTS_PER_LOGICAL) {
			counters.deniedAttemptBudget++;
			return Promise.resolve(denial("attempt_budget"));
		}
		const transportKey = normalizeTransportKey(request.transportKey);
		if (!transportKey) {
			counters.deniedRequestBudget++;
			return Promise.resolve(denial("request_budget", ["transport_key"]));
		}
		const normalized = {
			itemCount: Math.max(1, whole(request.itemCount, 1)),
			protectedChars: whole(request.protectedChars),
			bodyBytes: whole(request.bodyBytes),
			estimatedTokens: whole(request.estimatedTokens)
		};
		const exceeded = exceededDimensions(normalized);
		const oversized = normalized.itemCount === 1 && exceeded.length > 0;
		if (normalized.itemCount > 1 && exceeded.length) {
			counters.deniedRequestBudget++;
			return Promise.resolve(denial("request_budget", exceeded));
		}
		// Recovery permission is consumed only after currentness and both budgets pass.
		if (request.probeHealth === true) resetHealth(transportKey);
		const unhealthy = healthDenial(transportKey);
		if (unhealthy) return Promise.resolve(unhealthy);
		const role = ALLOWED_ROLES.has(String(request.role)) ? String(request.role) : "primary";
		entry.reserved++;
		const state = getKeyState(transportKey);
		return new Promise(resolve => {
			state.waiters.push({logical: entry, role, oversized, exceeded, isCurrent: request.isCurrent, resolve});
			pumpKey(state);
		});
	}

	function releaseAttempt(lease, outcome = {}) {
		const record = activeLeases.get(lease);
		if (!record) return false;
		activeLeases.delete(lease);
		record.logical.active = Math.max(0, record.logical.active - 1);
		record.key.active = Math.max(0, record.key.active - 1);
		if (record.lease.oversized) record.key.exclusiveActive = false;
		counters.settledAttempts++;
		applyHealthOutcome(record.key.transportKey, outcome, record.healthAtGrant);
		maybeDeleteLogical(record.logical);
		pumpKey(record.key);
		return true;
	}

	function rejectLogicalWaiters(entry, reason) {
		for (const state of [...keys.values()]) {
			const retained = [];
			for (const waiter of state.waiters) {
				if (waiter.logical === entry) denyWaiter(waiter, reason);
				else retained.push(waiter);
			}
			state.waiters = retained;
			pumpKey(state);
		}
	}

	function cancelLogical(token, reason = "cancelled") {
		const entry = getLogical(token);
		if (!entry || entry.cancelled) return false;
		entry.cancelled = true;
		rejectLogicalWaiters(entry, reason === "stopped" ? "stopped" : "cancelled");
		maybeDeleteLogical(entry);
		return true;
	}

	function finishLogical(token) {
		const entry = getLogical(token);
		if (!entry || entry.finished) return false;
		entry.finished = true;
		rejectLogicalWaiters(entry, "finished");
		maybeDeleteLogical(entry);
		return true;
	}

	function setCapacity(value) {
		configuredCapacity = normalizeCapacity(value);
		for (const state of [...keys.values()]) pumpKey(state);
		return configuredCapacity;
	}

	function setKeyCapacity(transportKey, value = null) {
		transportKey = normalizeTransportKey(transportKey);
		if (!transportKey) return false;
		if (value == null) capacityByKey.delete(transportKey);
		else capacityByKey.set(transportKey, normalizeCapacity(value));
		const state = keys.get(transportKey);
		if (state) pumpKey(state);
		return true;
	}

	// Explicit retry opens one captured key's recovery probe; it is not evidence of health.
	// Keep the recovery cap and failure streak. Missing keys never mean a global reset.
	function resetHealth(transportKey) {
		const key = normalizeTransportKey(transportKey);
		const health = key && healthByKey.get(key);
		if (stopped || !health || health.reason === "rate_limit") return false;
		const deadline = Math.max(timestamp(), health.rateLimitUntil || 0);
		if (!health.blocked && health.cooldownUntil <= deadline) return false;
		rememberHealth(key, Object.assign({}, health, {blocked: false, cooldownUntil: deadline, recovery: true}));
		const state = keys.get(key);
		if (state) pumpKey(state);
		return true;
	}

	// Admission/reset alone is not recovery proof, including an expired half-open key.
	function isKeyHealthy(transportKey) {
		const key = normalizeTransportKey(transportKey);
		return !stopped && !!key && !healthByKey.has(key);
	}

	function drain() {
		if (!activeLeases.size && ![...keys.values()].some(state => state.waiters.length)) return Promise.resolve();
		return new Promise(resolve => drainWaiters.push(resolve));
	}

	function stop() {
		if (!stopped) {
			stopped = true;
			capacityByKey.clear();
			for (const entry of logicals.values()) {
				entry.cancelled = true;
				rejectLogicalWaiters(entry, "stopped");
				maybeDeleteLogical(entry);
			}
		}
		settleDrain();
		return drain();
	}

	function start(value = configuredCapacity) {
		if (activeLeases.size || [...keys.values()].some(state => state.waiters.length)) return false;
		generation++;
		logicalSequence = 0;
		attemptSequence = 0;
		configuredCapacity = normalizeCapacity(value);
		stopped = false;
		logicals = new Map();
		keys = new Map();
		healthByKey = new Map();
		capacityByKey = new Map();
		activeLeases = new Map();
		drainWaiters = [];
		counters = createCounters();
		return true;
	}

	function getSnapshot() {
		const waitingAttemptCount = [...keys.values()].reduce((total, state) => total + state.waiters.length, 0);
		const activeKeyCount = [...keys.values()].filter(state => state.active > 0).length;
		return Object.freeze({
			generation,
			capacity: configuredCapacity,
			stopped,
			logicalCount: logicals.size,
			activeAttemptCount: activeLeases.size,
			waitingAttemptCount,
			activeKeyCount,
			keyCount: keys.size,
			grantedAttemptCount: counters.grantedAttempts,
			settledAttemptCount: counters.settledAttempts,
			deniedAttemptBudgetCount: counters.deniedAttemptBudget,
			deniedRequestBudgetCount: counters.deniedRequestBudget,
			cancelledAdmissionCount: counters.cancelledAdmissions,
			stoppedAdmissionCount: counters.stoppedAdmissions,
			oversizedSingleCount: counters.oversizedSingles,
			rateLimitCount: counters.rateLimits,
			serverCooldownCount: counters.serverCooldowns,
			invalidatedHealthCount: counters.invalidatedHealth,
			blockedKeyCount: [...healthByKey.values()].filter(health => health.blocked).length,
			cooldownKeyCount: [...healthByKey.values()].filter(health => !health.blocked && health.cooldownUntil > timestamp()).length,
			recoveryKeyCount: [...healthByKey.values()].filter(health => !health.blocked && health.recovery && health.cooldownUntil <= timestamp()).length,
			capacityOverrideKeyCount: capacityByKey.size,
			highWater: counters.highWater,
			maxActiveByKey: counters.maxActiveByKey,
			roleGrants: Object.freeze(Object.assign({}, counters.roleGrants)),
			logicalOnlyBeforeS4: true,
			resources: Object.freeze({active: activeLeases.size, waiting: waitingAttemptCount, logicals: logicals.size, keys: keys.size})
		});
	}

	return Object.freeze({beginLogical, acquireAttempt, releaseAttempt, cancelLogical, finishLogical, setCapacity, setKeyCapacity, resetHealth, isKeyHealthy, start, stop, drain, getSnapshot});
}

module.exports = {
	MAX_HISTORICAL_ITEMS_PER_ATTEMPT,
	MAX_HISTORICAL_PROTECTED_CHARS_PER_ATTEMPT,
	MAX_HISTORICAL_BODY_BYTES_PER_ATTEMPT,
	MAX_HISTORICAL_ESTIMATED_TOKENS_PER_ATTEMPT,
	MAX_HISTORICAL_ATTEMPTS_PER_LOGICAL,
	MAX_HISTORICAL_PROVIDER_CAPACITY,
	createHistoricalProviderBudgetOwner
};
