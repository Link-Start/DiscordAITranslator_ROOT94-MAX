const DEFAULT_TIER = 2;
const MAX_TIER = 4;
const PROMOTION_THRESHOLD = 2;
const HARD_PRESSURE_REASONS = new Set(["rate_limit", "server", "server_cooldown", "auth", "configuration", "schema", "provider_unhealthy"]);
const BLOCKED_REASONS = new Set(["auth", "configuration", "schema", "provider_unhealthy"]);

function whole(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function clampTier(value, fallback = DEFAULT_TIER) {
	return Math.max(1, Math.min(MAX_TIER, whole(value, fallback) || fallback));
}

function normalizeTransportKey(value) {
	const key = String(value == null ? "" : value);
	return /^tk1:[a-z0-9:-]{1,72}$/i.test(key) ? key : null;
}

function createHistoricalAdaptiveTierOwner({
	now = Date.now,
	defaultTier = DEFAULT_TIER,
	maxTier = MAX_TIER,
	promotionThreshold = PROMOTION_THRESHOLD,
	defaultCooldownMs = 1000,
	keyLimit = 32
} = {}) {
	const baseTier = Math.max(2, Math.min(MAX_TIER, clampTier(defaultTier)));
	const ceiling = Math.max(baseTier, Math.min(MAX_TIER, clampTier(maxTier, MAX_TIER)));
	const evidenceLimit = Math.max(1, whole(promotionThreshold, PROMOTION_THRESHOLD) || PROMOTION_THRESHOLD);
	const boundedKeys = Math.max(1, whole(keyLimit, 32) || 32);
	let generation = 0;
	let modeEpoch = 0;
	let observationSequence = 0;
	let stopped = false;
	let adaptiveMode = true;
	let fixedCap = baseTier;
	let activeKey = null;
	let activeKeyEpoch = 0;
	let entries = new Map();
	let observations = new Map();
	let lateObservationCount = 0;
	let pressureCount = 0;
	let promotionCount = 0;

	function timestamp() {
		try {const value = Number(now()); return Number.isFinite(value) ? Math.max(0, value) : 0;}
		catch (error) {return 0;}
	}

	function newEntry(transportKey) {
		return {
			transportKey,
			learnedTier: baseTier,
			promotionEvidence: 0,
			epoch: 0,
			pressureReason: null,
			cooldownUntil: 0,
			recoveryCap: null,
			blocked: false,
			hardPressure: false,
			lastPressureAt: null
		};
	}

	function rememberEntry(transportKey) {
		let entry = entries.get(transportKey);
		if (!entry) {
			entry = newEntry(transportKey);
			entries.set(transportKey, entry);
			while (entries.size > boundedKeys) {
				const oldestKey = entries.keys().next().value;
				if (oldestKey === activeKey && entries.size > 1) {
					const value = entries.get(oldestKey);
					entries.delete(oldestKey);
					entries.set(oldestKey, value);
					continue;
				}
				entries.delete(oldestKey);
				// Recreating a bounded key must not resurrect its old pressure-epoch tokens.
				for (const [id, token] of observations) if (token.transportKey === oldestKey) observations.delete(id);
				break;
			}
		}
		else {
			entries.delete(transportKey);
			entries.set(transportKey, entry);
		}
		return entry;
	}

	function refreshRecovery(entry) {
		if (!entry || entry.blocked || !entry.cooldownUntil || timestamp() < entry.cooldownUntil) return entry;
		entry.cooldownUntil = 0;
		entry.recoveryCap = Math.min(baseTier, adaptiveMode ? entry.learnedTier : fixedCap);
		entry.pressureReason = "recovery";
		return entry;
	}

	function targetFor(entry) {
		return adaptiveMode ? entry && entry.learnedTier || baseTier : fixedCap;
	}

	function effectiveFor(entry, {liveBusy = false, safetyEnabled = true} = {}) {
		const target = targetFor(entry);
		if (stopped) return {cap: 1, reason: "stopped", remaining: 0};
		if (liveBusy) return {cap: 1, reason: "live_busy", remaining: 0};
		if (!entry) return {cap: target, reason: null, remaining: 0};
		refreshRecovery(entry);
		if (entry.blocked) return {cap: 1, reason: entry.pressureReason || "provider_unhealthy", remaining: null};
		const remaining = Math.max(0, entry.cooldownUntil - timestamp());
		const applies = entry.hardPressure || safetyEnabled !== false;
		if (remaining > 0 && applies) return {cap: 1, reason: entry.pressureReason || "pressure", remaining: Math.ceil(remaining)};
		if (entry.recoveryCap != null && applies) return {cap: Math.max(1, Math.min(target, entry.recoveryCap)), reason: "recovery", remaining: 0};
		return {cap: target, reason: null, remaining: remaining ? Math.ceil(remaining) : 0};
	}

	function capture(value) {
		if (stopped) return null;
		const transportKey = normalizeTransportKey(value);
		if (!transportKey) return null;
		if (activeKey !== transportKey) activeKeyEpoch++;
		activeKey = transportKey;
		const entry = rememberEntry(transportKey);
		refreshRecovery(entry);
		const token = Object.freeze({generation, modeEpoch, observationId: ++observationSequence, transportKey, entryEpoch: entry.epoch});
		observations.set(token.observationId, token);
		return token;
	}

	function consumeObservation(token) {
		if (!token || token.generation !== generation || token.modeEpoch !== modeEpoch || !observations.has(token.observationId)) {
			lateObservationCount++;
			return null;
		}
		observations.delete(token.observationId);
		const entry = entries.get(token.transportKey);
		if (!entry || entry.epoch !== token.entryEpoch) {
			lateObservationCount++;
			return null;
		}
		return entry;
	}

	function recordPressure(token, {reason = "provider_pressure", cooldownMs = defaultCooldownMs, permanent = false} = {}) {
		const entry = consumeObservation(token);
		if (!entry) return false;
		const normalizedReason = String(reason || "provider_pressure");
		entry.promotionEvidence = 0;
		entry.epoch++;
		entry.pressureReason = normalizedReason;
		entry.lastPressureAt = timestamp();
		entry.hardPressure = HARD_PRESSURE_REASONS.has(normalizedReason);
		entry.blocked = permanent || BLOCKED_REASONS.has(normalizedReason);
		entry.cooldownUntil = entry.blocked ? 0 : Math.max(entry.cooldownUntil || 0, timestamp() + Math.max(1, whole(cooldownMs, whole(defaultCooldownMs, 1000) || 1000)));
		entry.recoveryCap = entry.blocked ? null : baseTier;
		pressureCount++;
		return true;
	}

	// A current, successful transport probe unlocks recovery, not promotion. Its epoch
	// invalidates older attempts and the probe job's clean-run observation.
	function recordRecovery(token) {
		const entry = consumeObservation(token);
		if (!entry || !entry.blocked) return false;
		entry.blocked = false;
		entry.cooldownUntil = 0;
		entry.recoveryCap = Math.min(baseTier, targetFor(entry));
		entry.pressureReason = "recovery";
		entry.hardPressure = true;
		entry.promotionEvidence = 0;
		entry.epoch++;
		return true;
	}

	function recordClean(token, {saturated = false, neutral = false} = {}) {
		const entry = consumeObservation(token);
		if (!entry) return false;
		refreshRecovery(entry);
		if (neutral || !saturated || entry.blocked || entry.cooldownUntil > timestamp()) return true;
		const target = targetFor(entry);
		if (entry.recoveryCap != null) {
			entry.promotionEvidence++;
			if (entry.promotionEvidence >= evidenceLimit) {
				entry.promotionEvidence = 0;
				entry.recoveryCap = Math.min(target, entry.recoveryCap + 1);
				entry.epoch++;
				if (entry.recoveryCap >= target) {
					entry.recoveryCap = null;
					entry.pressureReason = null;
					entry.hardPressure = false;
				}
			}
			return true;
		}
		if (!adaptiveMode || entry.learnedTier >= ceiling) return true;
		entry.promotionEvidence++;
		if (entry.promotionEvidence >= evidenceLimit) {
			entry.promotionEvidence = 0;
			entry.learnedTier = Math.min(ceiling, entry.learnedTier + 1);
			entry.epoch++;
			promotionCount++;
		}
		return true;
	}

	function discard(token) {
		if (!token || token.generation !== generation || !observations.has(token.observationId)) return false;
		observations.delete(token.observationId);
		return true;
	}

	function setMode(value) {
		adaptiveMode = String(value) === "auto";
		fixedCap = adaptiveMode ? baseTier : clampTier(value, baseTier);
		modeEpoch++;
		observations.clear();
		for (const entry of entries.values()) entry.promotionEvidence = 0;
		return adaptiveMode ? baseTier : fixedCap;
	}

	function getSnapshot(value = activeKey, options = {}) {
		const transportKey = normalizeTransportKey(value);
		const entry = transportKey ? rememberEntry(transportKey) : activeKey && entries.get(activeKey) || null;
		const effective = effectiveFor(entry, options);
		const selectedCap = targetFor(entry);
		return Object.freeze({
			adaptiveMode,
			selectedCap,
			learnedTier: entry ? entry.learnedTier : baseTier,
			promotionEvidence: entry ? entry.promotionEvidence : 0,
			effectiveCap: effective.cap,
			effectiveReason: effective.reason,
			cooldownRemainingMs: effective.remaining,
			tierEpoch: modeEpoch + activeKeyEpoch + (entry ? entry.epoch : 0),
			keyStateCount: entries.size,
			lateObservationCount,
			pressureCount,
			promotionCount,
			stopped,
			resources: Object.freeze({keys: entries.size, observations: observations.size})
		});
	}

	function stop() {
		stopped = true;
		generation++;
		modeEpoch++;
		activeKey = null;
		activeKeyEpoch = 0;
		entries = new Map();
		observations = new Map();
		return true;
	}

	function start(value = "auto") {
		generation++;
		modeEpoch++;
		observationSequence = 0;
		stopped = false;
		adaptiveMode = String(value) === "auto";
		fixedCap = adaptiveMode ? baseTier : clampTier(value, baseTier);
		activeKey = null;
		activeKeyEpoch = 0;
		entries = new Map();
		observations = new Map();
		lateObservationCount = 0;
		pressureCount = 0;
		promotionCount = 0;
		return true;
	}

	return Object.freeze({capture, recordPressure, recordRecovery, recordClean, discard, setMode, getSnapshot, stop, start});
}

module.exports = {
	DEFAULT_HISTORICAL_LEARNED_TIER: DEFAULT_TIER,
	MAX_HISTORICAL_LEARNED_TIER: MAX_TIER,
	createHistoricalAdaptiveTierOwner
};
