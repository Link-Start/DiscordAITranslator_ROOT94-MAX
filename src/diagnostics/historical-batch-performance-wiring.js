const {createHistoricalBatchPerformanceTrace} = require("./historical-batch-performance-trace");
const {runChunkedHistoricalBatch, HISTORICAL_PROVIDER_CHUNK_SIZE, HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT} = require("../orchestrator/historical-provider-chunking");
const {createHistoricalPhysicalLeaseOwner} = require("../orchestrator/historical-physical-lease-owner");
const {createHistoricalProviderBudgetOwner} = require("../orchestrator/historical-provider-budget-owner");
const {createHistoricalAdaptiveTierOwner} = require("../orchestrator/historical-adaptive-tier-owner");
const {createHistoricalPrimarySampleReservoir} = require("./historical-primary-sample-reservoir");
const {normalizeSemanticReason} = require("./provider-latency-store");

const DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY = 2;
const MAX_HISTORICAL_PRIMARY_CONCURRENCY = 4;
const CLEAN_RUNS_REQUIRED_FOR_PROMOTION = 2;

// Keeps observation-only host wiring out of the legacy composition root. Every hook is
// best-effort: measurement must never change provider, queue, repair or display control
// flow when a diagnostic callback fails.
function createPluginHistoricalBatchPerformance({
	chunkSize = HISTORICAL_PROVIDER_CHUNK_SIZE,
	chunkCharLimit = HISTORICAL_PROVIDER_CHUNK_CHAR_LIMIT,
	createTrace = createHistoricalBatchPerformanceTrace,
	createPhysicalLeaseOwner = createHistoricalPhysicalLeaseOwner,
	createProviderBudgetOwner = createHistoricalProviderBudgetOwner,
	createAdaptiveTierOwner = createHistoricalAdaptiveTierOwner,
	createPrimarySampleReservoir = createHistoricalPrimarySampleReservoir,
	loadPrimarySamples = () => null,
	savePrimarySamples = () => {},
	recordSemanticObservation = () => null,
	isSafetyLimiterEnabled = () => true,
	now = Date.now,
	createAbortController = () => new AbortController()
} = {}) {
	const trace = createTrace();
	const physicalLeases = createPhysicalLeaseOwner({capacity: DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY});
	const providerBudgets = createProviderBudgetOwner({capacity: DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY, now});
	const adaptiveTiers = createAdaptiveTierOwner({now});
	const primarySamples = createPrimarySampleReservoir({load: loadPrimarySamples, save: savePrimarySamples, now});
	const abortControllersByJob = new Map();
	const activeJobCaps = new Map();
	let historicalAbortCount = 0;
	let configuredConcurrency = DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY;
	let pressureLocked = false;
	let pressureReason = null;
	let adaptiveMode = true;
	let cleanPromotionStreak = 0;
	let tierEpoch = 0;
	let currentTransportKey = null;
	let selectedConcurrency = "auto";

	function normalizeConcurrency(value) {
		return Math.max(1, Math.min(MAX_HISTORICAL_PRIMARY_CONCURRENCY, Math.floor(Number(value)) || 1));
	}

	function safetyLimiterEnabled() {
		try {return isSafetyLimiterEnabled() !== false;}
		catch (error) {return true;}
	}

	function syncAdaptiveState(snapshot) {
		if (!snapshot) return null;
		configuredConcurrency = snapshot.selectedCap;
		cleanPromotionStreak = snapshot.promotionEvidence;
		tierEpoch = snapshot.tierEpoch;
		pressureLocked = !!(snapshot.effectiveReason && snapshot.effectiveReason !== "live_busy" && snapshot.effectiveCap < snapshot.selectedCap);
		pressureReason = snapshot.effectiveReason;
		return snapshot;
	}

	function adaptiveSnapshot(job = null, options = {}) {
		const key = job && job.historicalTransportKey || currentTransportKey;
		return syncAdaptiveState(adaptiveTiers.getSnapshot(key, Object.assign({safetyEnabled: safetyLimiterEnabled()}, options)));
	}

	function captureJobTransportKey(job, transportKey) {
		if (!job || !transportKey) return null;
		if (job.historicalTransportKey && job.historicalTransportKey !== transportKey && job.historicalAdaptiveObservation) adaptiveTiers.discard(job.historicalAdaptiveObservation);
		job.historicalTransportKey = transportKey;
		currentTransportKey = transportKey;
		if (!job.historicalAdaptiveObservation) job.historicalAdaptiveObservation = adaptiveTiers.capture(transportKey);
		const snapshot = adaptiveSnapshot(job);
		job.historicalPrimaryConcurrency = snapshot.effectiveCap;
		job.historicalTierEpoch = snapshot.tierEpoch;
		activeJobCaps.set(job, snapshot.effectiveCap);
		try {providerBudgets.setKeyCapacity(transportKey, snapshot.effectiveCap);}
		catch (error) {}
		const activeTarget = activeJobCaps.size ? Math.max(...activeJobCaps.values()) : snapshot.effectiveCap;
		try {physicalLeases.setCapacity(activeTarget);}
		catch (error) {}
		try {providerBudgets.setCapacity(activeTarget);}
		catch (error) {}
		return snapshot;
	}

	function lockProviderPressure(reason = "provider_pressure", job = null, {transportKey = null, cooldownMs = 1000, permanent = false} = {}) {
		const key = transportKey || job && job.historicalTransportKey || currentTransportKey;
		if (!key) return false;
		if (job && job.historicalAdaptiveObservation) {adaptiveTiers.discard(job.historicalAdaptiveObservation); job.historicalAdaptiveObservation = null;}
		const token = adaptiveTiers.capture(key);
		if (!token || !adaptiveTiers.recordPressure(token, {reason, cooldownMs, permanent})) return false;
		if (job) job.historicalPressureReason = reason;
		currentTransportKey = key;
		const snapshot = adaptiveSnapshot(job || null);
		if (job) activeJobCaps.set(job, snapshot.effectiveCap);
		try {providerBudgets.setKeyCapacity(key, snapshot.effectiveCap);}
		catch (error) {}
		const activeTarget = activeJobCaps.size ? Math.max(...activeJobCaps.values()) : snapshot.effectiveCap;
		try {physicalLeases.setCapacity(activeTarget);}
		catch (error) {}
		try {providerBudgets.setCapacity(activeTarget);}
		catch (error) {}
		return true;
	}

	function resetAdaptiveTierForLive() {
		try {physicalLeases.setCapacity(1);}
		catch (error) {}
		try {providerBudgets.setCapacity(1);}
		catch (error) {}
	}

	function promotionRunIsNeutral(run, tier) {
		return !!(run && run.status === "committed" && (run.providerMessageCount === 0 || run.liveOverlapDispatches || run.liveTurnsDuringRun || run.liveOverlapDuringChunks || run.requestedChunks < tier + 1 || run.maxActiveChunks < tier));
	}

	function promotionRunIsClean(run, tier) {
		if (!run || run.status !== "committed" || run.chunkSize !== chunkSize || run.chunkCharLimit !== chunkCharLimit) return false;
		const terminalCount = run.translatedCount + run.skippedCount + run.failedCount;
		return run.requestedChunks === run.settledChunks && run.providerMessageCount === run.settledMessageCount
			&& run.requestedChunks >= tier + 1 && run.maxActiveChunks === tier && run.activeChunksAtFinish === 0
			&& !run.failureCount && !run.repairBatchRequests && !run.repairBatchMessages && !run.repairItemRequests
			&& !run.liveOverlapDispatches && !run.liveTurnsDuringRun && !run.liveOverlapDuringChunks
			&& !run.duplicateChunkEventCount && !run.orphanChunkSettleCount && !run.chunkConstraintViolationCount && !run.failedCount
			&& run.atomicCommitCount >= 1 && !run.commitErrorCount && !run.rejectedCount && !run.staleCount && !run.missingCount && !run.retryCount
			&& terminalCount === run.collectedMessageCount && run.commitResultCount === terminalCount && run.committedCount === run.commitResultCount;
	}

	function finishedRunHasStickyPressure(run) {
		return !!(run && (run.failureCount || run.repairBatchRequests || run.repairBatchMessages || run.repairItemRequests || run.failedCount || run.commitErrorCount || run.rejectedCount || run.staleCount));
	}

	function liveIsBusy(owner) {
		try {
			const queue = owner.ensureLiveTranslationQueue();
			return queue.getQueueLength() > 0 || queue.getLiveSlotActiveCount() > 0 || queue.isBusyTranslating();
		}
		catch (error) {return true;}
	}

	function refreshPhysicalCapacity(owner, job = null) {
		const liveBusy = liveIsBusy(owner);
		const snapshot = adaptiveSnapshot(job, {liveBusy});
		if (job) activeJobCaps.set(job, snapshot.effectiveCap);
		if (job && job.historicalTransportKey) {
			try {providerBudgets.setKeyCapacity(job.historicalTransportKey, snapshot.effectiveCap);}
			catch (error) {}
		}
		const activeTarget = activeJobCaps.size ? Math.max(...activeJobCaps.values()) : snapshot.effectiveCap;
		const desired = liveBusy ? 1 : Math.max(1, activeTarget);
		try {physicalLeases.setCapacity(desired);}
		catch (error) {}
		try {providerBudgets.setCapacity(desired);}
		catch (error) {}
		return desired;
	}

	function jobIsCurrent(owner, job) {
		try {return !!owner && !!job && owner.isHistoricalTranslationJobCurrent(job);}
		catch (error) {return false;}
	}

	function safeNow() {
		try {
			const value = Number(now());
			return Number.isFinite(value) ? Math.max(0, value) : 0;
		}
		catch (error) {return 0;}
	}

	function traceCall(method, ...args) {
		try {return trace && typeof trace[method] == "function" ? trace[method](...args) : null;}
		catch (error) {return null;}
	}

	function observeProviderLeaseOutcome(job, lease, outcome = {}) {
		if (!lease || !lease.transportKey) return false;
		if (!job || !job.historicalTransportKey || lease.role === "primary") captureJobTransportKey(job, lease.transportKey);
		const statusCode = Number(outcome && outcome.statusCode) || 0;
		const errorClass = String(outcome && (outcome.errorClass || outcome.failureKind) || "");
		if (statusCode === 429 || errorClass === "rate_limit") return lockProviderPressure("rate_limit", job, {transportKey: lease.transportKey, cooldownMs: Math.max(1, Number(outcome.retryAfterMs) || 5000)});
		if (statusCode >= 500 && statusCode <= 599 || errorClass === "server") return lockProviderPressure("server", job, {transportKey: lease.transportKey, cooldownMs: 1000});
		if (errorClass === "timeout" || outcome && outcome.timedOut) return lockProviderPressure("timeout", job, {transportKey: lease.transportKey, cooldownMs: 1000});
		if (["auth", "configuration", "schema", "provider_unhealthy"].includes(errorClass)) return lockProviderPressure(errorClass, job, {transportKey: lease.transportKey, permanent: true});
		return false;
	}

	// Keep retry authority local to the exact source items and captured transport contract.
	// The prior snapshot grants at most one probe per key/job; only this run's health
	// failures are carried into the next snapshot. No endpoint or credential is retained.
	function createRetryHealthContext(job, preparedItems) {
		const sources = preparedItems.map(item => item && (item.queueItem || item)).filter(Boolean);
		const scope = job && (job.historicalRetryHealthScope || (job.historicalRetryHealthScope = {permissions: new WeakMap(), probed: new Set()}));
		for (const source of sources) if (scope && !scope.permissions.has(source)) {
			scope.permissions.set(source, new Set(source.retryFailed && Array.isArray(source.historicalRetryTransportKeys) ? source.historicalRetryTransportKeys : []));
			delete source.historicalRetryTransportKeys;
		}
		return {
			claimProbe(transportKey) {
				if (!scope || scope.probed.has(transportKey) || !sources.some(source => scope.permissions.get(source).has(transportKey))) return false;
				scope.probed.add(transportKey);
				return true;
			},
			record(transportKey, outcome = {}) {
				const reason = String(outcome.reason || outcome.errorClass || outcome.failureKind || "");
				const status = Number(outcome.statusCode) || 0;
				if (!/^tk1:[a-z0-9:-]{1,72}$/i.test(String(transportKey || "")) || !(status === 429 || status >= 500 && status <= 599 || ["auth", "configuration", "schema", "not_found", "invalid_request", "unsupported_field", "unsupported_value", "provider_unhealthy", "rate_limit", "server", "server_cooldown"].includes(reason))) return;
				for (const source of sources) source.historicalRetryTransportKeys = [...new Set([...(source.historicalRetryTransportKeys || []), transportKey])];
			}
		};
	}

	function createH1LogicalContext(owner, job, {role = "primary", itemCount = 0, probeBarrier = false, primaryWave = 0, preparedItems = []} = {}) {
		const retryHealth = createRetryHealthContext(job, preparedItems);
		const runToken = job && job.historicalPerformanceToken;
		const logicalToken = traceCall("beginLogical", runToken, {role, itemCount, probeBarrier, primaryWave});
		const providerLogicalToken = providerBudgets.beginLogical({isCurrent: () => jobIsCurrent(owner, job)});
		let abortController = null;
		try {abortController = createAbortController();}
		catch (error) {}
		const abortEntry = abortController ? {controller: abortController, finished: false} : null;
		if (abortEntry && job) {
			let entries = abortControllersByJob.get(job);
			if (!entries) {entries = new Set(); abortControllersByJob.set(job, entries);}
			entries.add(abortEntry);
		}
		let finished = false;
		const recoveryObservations = new Set();
		const recoveryByLease = new Map();
		const discardRecovery = token => {recoveryObservations.delete(token); adaptiveTiers.discard(token);};
		const logicalIsCurrent = () => !finished && !(abortController && abortController.signal && abortController.signal.aborted) && jobIsCurrent(owner, job);
		return Object.freeze({
			logicalToken,
			recordLease(metrics) {if (logicalToken) traceCall("recordLease", logicalToken, metrics);},
			createTimingContext(base = {}) {
				if (!logicalToken) return base;
				const createObserver = attemptRole => {
					const requestedRole = String(attemptRole || base.role || "primary");
					const h1Role = requestedRole === "backup" ? "backup" : role === "repair" || requestedRole === "retry" ? "repair" : "primary";
					const attemptToken = traceCall("beginAttempt", logicalToken, {role: h1Role, engineKey: base.engineKey});
					return Object.freeze({
						onRequest(event) {
							if (h1Role === "primary" && event && event.transportKey) captureJobTransportKey(job, event.transportKey);
							if (!attemptToken) return;
							let slotActive = 0, slotCapacity = 0;
							try {const snapshot = physicalLeases.getSnapshot(); slotActive = snapshot.active; slotCapacity = snapshot.capacity;}
							catch (error) {}
							traceCall("recordAttemptDispatched", attemptToken, Object.assign({}, event || {}, {slotActive, slotCapacity}));
						},
						onSettle(event) {if (attemptToken) traceCall("recordAttemptSettled", attemptToken, event || {});}
					});
				};
				const latencyRole = role === "repair" && base.role !== "backup" ? "retry" : base.role;
				const historicalContractObserver = contract => {
					if (role === "primary" && contract && contract.transportKey) captureJobTransportKey(job, contract.transportKey);
					if (typeof base.onHistoricalContractCaptured == "function") try {base.onHistoricalContractCaptured(contract);} catch (error) {}
				};
				const historicalAdmission = providerLogicalToken ? Object.freeze({
					acquireAttempt: meta => {
						const probeHealth = logicalIsCurrent() && retryHealth.claimProbe(meta && meta.transportKey);
						// Capture before admission can queue: an older attempt must not become fresh
						// recovery evidence when pressure changes before its promise callback runs.
						const token = logicalIsCurrent() ? adaptiveTiers.capture(meta && meta.transportKey) : null;
						if (token) recoveryObservations.add(token);
						return providerBudgets.acquireAttempt(providerLogicalToken, Object.assign({}, meta || {}, {probeHealth, isCurrent: logicalIsCurrent})).then(lease => {
							if (!lease.granted) retryHealth.record(meta && meta.transportKey, lease);
							if (token && lease.granted && logicalIsCurrent()) recoveryByLease.set(lease, token);
							else discardRecovery(token);
							return lease;
						}, error => {discardRecovery(token); throw error;});
					},
					releaseAttempt: (lease, outcome = {}) => {
						const token = recoveryByLease.get(lease);
						recoveryByLease.delete(lease);
						const released = providerBudgets.releaseAttempt(lease, outcome);
						if (released) {
							retryHealth.record(lease.transportKey, outcome);
							observeProviderLeaseOutcome(job, lease, outcome);
							const status = Number(outcome.statusCode) || 0;
							const cleanTransport = status >= 200 && status < 300 && !outcome.errorClass && !outcome.failureKind && !outcome.error && !outcome.timedOut && !outcome.physicalAbort && !outcome.cancelledBeforeDispatch;
							if (token && logicalIsCurrent() && cleanTransport && providerBudgets.isKeyHealthy(lease.transportKey) && adaptiveTiers.recordRecovery(token)) {
								const snapshot = adaptiveTiers.getSnapshot(lease.transportKey, {safetyEnabled: safetyLimiterEnabled()});
								providerBudgets.setKeyCapacity(lease.transportKey, snapshot.effectiveCap);
							}
						}
						discardRecovery(token);
						return released;
					},
					isCurrent: logicalIsCurrent
				}) : null;
				const requestContext = Object.freeze({logicalRequestId: providerLogicalToken ? `historical-${providerLogicalToken.generation}-${providerLogicalToken.logicalId}` : null, signal: abortController && abortController.signal || null, isCurrent: logicalIsCurrent});
				return Object.assign({}, base, {role: latencyRole, requestContext, historicalBatch: base.historicalBatch === true, historicalAttemptFactory: createObserver, historicalContractObserver, historicalAdmission});
			},
			finish(status = "settled") {
				if (finished) return false;
				finished = true;
				for (const token of recoveryObservations) adaptiveTiers.discard(token);
				recoveryObservations.clear();
				recoveryByLease.clear();
				if (abortEntry) {
					abortEntry.finished = true;
					const entries = abortControllersByJob.get(job);
					if (entries) {entries.delete(abortEntry); if (!entries.size) abortControllersByJob.delete(job);}
				}
				if (providerLogicalToken) providerBudgets.finishLogical(providerLogicalToken);
				return logicalToken ? !!traceCall("finishLogical", logicalToken, {status}) : false;
			}
		});
	}

	function abortJobAttempts(job, reason = "cancelled") {
		const entries = abortControllersByJob.get(job);
		let aborted = 0;
		for (const entry of entries || []) {
			if (!entry || entry.finished || !entry.controller || entry.controller.signal && entry.controller.signal.aborted) continue;
			try {entry.controller.abort(reason); aborted++; historicalAbortCount++;}
			catch (error) {}
		}
		return aborted;
	}

	function abortAllJobAttempts(reason = "cancelled") {
		let aborted = 0;
		for (const job of [...abortControllersByJob.keys()]) aborted += abortJobAttempts(job, reason);
		return aborted;
	}

	function dispatchIsCurrent(owner, job, isDispatchCurrent = null) {
		if (!jobIsCurrent(owner, job)) return false;
		if (typeof isDispatchCurrent != "function") return true;
		try {return isDispatchCurrent() === true;}
		catch (error) {return false;}
	}

	function providerBackoffIsActive(owner) {
		try {
			const client = owner.ensureProviderClient();
			// Older/test-compatible provider seams expose only awaitBackoff. Absence of
			// the synchronous reader is not evidence of an active window; a throwing
			// reader is, because dispatching through an indeterminate live client is unsafe.
			if (!client || typeof client.isBackoffActive != "function") return false;
			return client.isBackoffActive() === true;
		}
		catch (error) {return true;}
	}

	function leaseIsDispatchable(lease) {
		try {
			if (typeof physicalLeases.isDispatchable == "function") return physicalLeases.isDispatchable(lease) === true;
			return physicalLeases.owns(lease) === true;
		}
		catch (error) {return false;}
	}

	async function acquirePhysicalLease(owner, job, isDispatchCurrent = null) {
		const isCurrent = () => dispatchIsCurrent(owner, job, isDispatchCurrent);
		let backoffWaitMs = 0;
		let leaseWaitMs = 0;
		while (isCurrent()) {
			refreshPhysicalCapacity(owner, job);
			const leaseStartedAt = safeNow();
			const lease = await physicalLeases.acquire({isCurrent});
			leaseWaitMs += Math.max(0, safeNow() - leaseStartedAt);
			if (!lease) return null;
			// Capacity/live pressure may change while this caller waits in the global FIFO.
			// Re-evaluate after grant; an out-of-cap speculative lease yields
			// without crossing the provider boundary.
			refreshPhysicalCapacity(owner, job);
			if (isCurrent() && leaseIsDispatchable(lease)) {providerBackoffIsActive(owner); return {lease, backoffWaitMs, leaseWaitMs};}
			physicalLeases.release(lease);
		}
		return null;
	}

	async function runPhysicalRequest(owner, job, requestFactory, onDispatch = null, {
		isDispatchCurrent = null,
		onOutcomeBeforeRelease = null,
		onErrorBeforeRelease = null,
		h1LogicalContext = null
	} = {}) {
		const isCurrent = () => dispatchIsCurrent(owner, job, isDispatchCurrent);
		while (isCurrent()) {
			const acquisition = await acquirePhysicalLease(owner, job, isDispatchCurrent);
			if (!acquisition) return {cancelledBeforeDispatch: true};
			const {lease, backoffWaitMs, leaseWaitMs} = acquisition;
			if (h1LogicalContext) {
				let slotActive = 0, slotCapacity = 0;
				try {const snapshot = physicalLeases.getSnapshot(); slotActive = snapshot.active; slotCapacity = snapshot.capacity;}
				catch (error) {}
				h1LogicalContext.recordLease({backoffWaitMs, leaseWaitMs, slotActive, slotCapacity});
			}
			try {
				// This is the final synchronous dispatch fence. A live turn can arrive in
				// the await gap after lease acquisition; lowering capacity alone
				// does not revoke a token which was already granted.
				refreshPhysicalCapacity(owner, job);
				if (!isCurrent()) return {cancelledBeforeDispatch: true};
				if (!leaseIsDispatchable(lease)) {
					continue;
				}
				let outcome;
				try {
					if (onDispatch) {const observed = onDispatch(Object.freeze({backoffWaitMs, leaseWaitMs})); if (observed && typeof observed.then == "function") Promise.resolve(observed).catch(() => {});}
					outcome = await requestFactory();
				}
				catch (error) {
					if (onErrorBeforeRelease) {
						try {onErrorBeforeRelease(error);}
						catch (hookError) {}
					}
					throw error;
				}
				if (onOutcomeBeforeRelease) {
					try {onOutcomeBeforeRelease(outcome);}
					catch (error) {}
				}
				return outcome;
			}
			finally {physicalLeases.release(lease);}
		}
		return {cancelledBeforeDispatch: true};
	}

	function begin(job) {
		const adaptive = adaptiveSnapshot(job);
		const concurrency = adaptive.effectiveCap;
		let sourceMetrics = job && job.historicalSourceMetrics || null;
		if (!sourceMetrics && job && job.items && typeof job.items.values == "function") {
			try {
				const firstRecord = job.items.values().next().value;
				sourceMetrics = firstRecord && firstRecord.source && firstRecord.source.historicalSourceMetrics || null;
			}
			catch (error) {}
		}
		if (job) {
			job.historicalPrimaryConcurrency = concurrency;
			job.historicalTierEpoch = adaptive.tierEpoch;
			job.historicalAdaptiveObservation = null;
			job.historicalPressureReason = null;
			activeJobCaps.set(job, concurrency);
		}
		try {return trace.beginRun({
			collectedMessageCount: job && job.items ? job.items.size : 0,
			concurrency,
			chunkSize,
			chunkCharLimit,
			sealedAt: job && job.sealedAt,
			batchKey: job && job.id,
			sourceMetrics
		});}
		catch (error) {return null;}
	}

	function finish(owner, job) {
		if (!job || !job.historicalPerformanceToken) return false;
		try {
			const summary = job.createSummary();
			primarySamples.recordFinal(job.id, {
				translatedIds: (summary.translated || []).map(item => item && item.message && String(item.message.id)).filter(Boolean),
				skippedIds: (summary.skipped || []).map(item => item && item.message && String(item.message.id)).filter(Boolean),
				failedIds: (summary.failed || []).map(item => item && item.message && String(item.message.id)).filter(Boolean)
			});
			const status = job.state == "committed" ? "committed" : job.state == "cancelled" ? "cancelled" : "failed";
			const completed = trace.finishRun(job.historicalPerformanceToken, {status, translatedCount: summary.translated.length, skippedCount: summary.skipped.length, failedCount: summary.failed.length});
			if (!completed || !job.historicalAdaptiveObservation) return completed;
			const tier = job.historicalPrimaryConcurrency;
			if (promotionRunIsNeutral(completed, tier)) adaptiveTiers.recordClean(job.historicalAdaptiveObservation, {neutral: true});
			else if (promotionRunIsClean(completed, tier)) adaptiveTiers.recordClean(job.historicalAdaptiveObservation, {saturated: true});
			else adaptiveTiers.discard(job.historicalAdaptiveObservation);
			job.historicalAdaptiveObservation = null;
			const adaptive = adaptiveSnapshot(job);
			try {if (job.historicalTransportKey) providerBudgets.setKeyCapacity(job.historicalTransportKey, adaptive.effectiveCap);}
			catch (error) {}
			return completed;
			/* legacy promotion was global and keyed by configurationSignature; S6 owns it above by the captured Transport Key. */
			/* c8 ignore next 13 */
			/*
			if (promotionRunIsNeutral(completed, tier)) return completed;
			if (!promotionRunIsClean(completed, tier)) {
				cleanPromotionStreak = 0;
				if (finishedRunHasStickyPressure(completed)) lockProviderPressure("dirty_run");
				return completed;
			}
			cleanPromotionStreak++;
			if (cleanPromotionStreak >= CLEAN_RUNS_REQUIRED_FOR_PROMOTION && configuredConcurrency === tier && configuredConcurrency < MAX_HISTORICAL_PRIMARY_CONCURRENCY) {
				configuredConcurrency++;
				cleanPromotionStreak = 0;
				tierEpoch++;
				// Do not raise physical capacity here: live demand may have lowered it in the
				// same turn. The next acquire refreshes capacity against current live state.
			}
			return completed;
			*/
		}
		catch (error) {return false;}
		finally {activeJobCaps.delete(job); primarySamples.finishJob(job && job.id);}
	}

	function requestPrimaryChunk(owner, engineKey, preparedItems, job, chunkMeta = {}) {
		const token = job && job.historicalPerformanceToken;
		const chunkIndex = Number.isFinite(Number(chunkMeta.chunkIndex)) ? Number(chunkMeta.chunkIndex) : 0;
		const inputChars = preparedItems.reduce((total, item) => total + String(item && item.protectedText || "").length, 0);
		const waveConcurrency = Math.max(1, Number(chunkMeta.concurrency) || Number(job && job.historicalPrimaryConcurrency) || 1);
		const primaryWave = Math.floor(chunkIndex / waveConcurrency);
		const h1LogicalContext = createH1LogicalContext(owner, job, {role: "primary", itemCount: preparedItems.length, probeBarrier: false, primaryWave, preparedItems});
		const primarySampleToken = primarySamples.beginPrimary({jobKey: job && job.id, blockIndex: chunkIndex, messageIds: preparedItems.map(item => item && item.message && String(item.message.id)).filter(Boolean), itemCount: preparedItems.length, protectedChars: inputChars, effectiveCap: waveConcurrency, wave: primaryWave});
		const historicalSampleObserver = Object.freeze({
			onContract: (contract, metrics) => primarySamples.recordContract(primarySampleToken, Object.assign({}, metrics || {}, contract || {})),
			onSettle: event => primarySamples.recordSettle(primarySampleToken, event || {})
		});
		let timingContext = null;
		let outcomeRecorded = false;
		let errorRecorded = false;
		const recordOutcome = outcome => {
			if (outcomeRecorded || errorRecorded) return;
			outcomeRecorded = true;
			const detailed = outcome && typeof outcome == "object" && (Object.prototype.hasOwnProperty.call(outcome, "translations") || Object.prototype.hasOwnProperty.call(outcome, "failureKind"));
			const failureKind = detailed && outcome.failureKind ? String(outcome.failureKind) : null;
			primarySamples.recordOutcome(primarySampleToken, {failureKind});
			if (failureKind && job && job.historicalPressureReason !== failureKind) {
				if (["rate_limit", "server", "timeout", "malformed", "transient"].includes(failureKind)) lockProviderPressure(failureKind, job, {cooldownMs: failureKind === "rate_limit" ? 5000 : 1000});
				else if (["auth", "configuration", "schema"].includes(failureKind)) lockProviderPressure(failureKind, job, {permanent: true});
			}
			try {trace.recordChunkSettled(token, {index: chunkIndex, messageCount: preparedItems.length, failureKind: detailed ? outcome.failureKind : null, statusCode: detailed ? outcome.statusCode : null});}
			catch (error) {}
			if (typeof chunkMeta.onOutcomeBeforeRelease == "function") {
				try {chunkMeta.onOutcomeBeforeRelease(outcome);}
				catch (error) {}
			}
			try {physicalLeases.pruneStaleWaiters();}
			catch (error) {}
			h1LogicalContext.finish("settled");
		};
		const recordError = error => {
			if (errorRecorded || outcomeRecorded) return;
			errorRecorded = true;
			primarySamples.recordOutcome(primarySampleToken, {failureKind: "thrown"});
			try {trace.recordChunkSettled(token, {index: chunkIndex, messageCount: preparedItems.length, failureKind: "thrown"});}
			catch (traceError) {}
			if (typeof chunkMeta.onErrorBeforeRelease == "function") {
				try {chunkMeta.onErrorBeforeRelease(error);}
				catch (hookError) {}
			}
			try {physicalLeases.pruneStaleWaiters();}
			catch (hookError) {}
			h1LogicalContext.finish("failed");
		};
		return runPhysicalRequest(owner, job, () => typeof chunkMeta.requestFactory == "function" ? chunkMeta.requestFactory(timingContext) : owner.requestAiBatchTranslationDetailed(engineKey, preparedItems, timingContext), leaseMetrics => {
			let liveActive = 0;
			try {liveActive = owner.ensureLiveTranslationQueue().getLiveSlotActiveCount();}
			catch (error) {}
			if (liveActive > 0) primarySamples.recordLiveOverlap(job && job.id);
			try {trace.recordChunkStarted(token, {index: chunkIndex, messageCount: preparedItems.length, inputChars, liveActive});}
			catch (error) {}
			let latencyToken = null;
			try {latencyToken = owner.ensureProviderClient().beginLatencyRequest({kind: "historical", lane: "history-primary", messageCount: preparedItems.length, inputChars});}
			catch (error) {}
			timingContext = h1LogicalContext.createTimingContext({token: latencyToken, role: "primary", observationRole: "primary", engineKey, messageCount: preparedItems.length, leaseWaitMs: leaseMetrics && leaseMetrics.leaseWaitMs, historicalBatch: chunkMeta.historicalBatch !== false, historicalSampleObserver, diagnosticRequestObserver: event => {for (const prepared of preparedItems) {const routeId = prepared && prepared.queueItem && prepared.queueItem.terminalRouteId; if (routeId) owner.updateTranslationTerminalRoute(routeId, {requestBodyBytes: event && event.bodyBytes, requestBodyIdentity: event && event.bodyIdentity});}}, diagnosticStageObserver: event => {for (const prepared of preparedItems) {const routeId = prepared && prepared.queueItem && prepared.queueItem.terminalRouteId; if (routeId) owner.recordTranslationTerminalStage(routeId, "provider", event && (event.errorClass || event.status) || "unknown");}}, onHistoricalContractCaptured: () => {if (typeof chunkMeta.onDesiredConcurrencyChanged == "function") chunkMeta.onDesiredConcurrencyChanged();}});
		}, {
			isDispatchCurrent: typeof chunkMeta.isDispatchCurrent == "function" ? chunkMeta.isDispatchCurrent : null,
			onOutcomeBeforeRelease: recordOutcome,
			onErrorBeforeRelease: recordError,
			h1LogicalContext
		}).then(outcome => {
			if (outcome && outcome.cancelledBeforeDispatch) {
				primarySamples.recordOutcome(primarySampleToken, {cancelled: true});
				// No physical trace event exists, but the local pump must still learn that
				// this logical launch was cancelled and retire its sibling waiters now.
				if (typeof chunkMeta.onOutcomeBeforeRelease == "function") {
					try {chunkMeta.onOutcomeBeforeRelease(outcome);}
					catch (error) {}
				}
				try {physicalLeases.pruneStaleWaiters();}
				catch (error) {}
				h1LogicalContext.finish("cancelled");
				return outcome;
			}
			recordOutcome(outcome);
			return outcome;
		}, error => {
			recordError(error);
			throw error;
		});
	}

	function runPrimaryBatch(owner, engineKey, preparedItems, job, onChunkSettled, onChunkOutcome = null) {
		const isCurrent = () => jobIsCurrent(owner, job);
		return runChunkedHistoricalBatch({
			preparedItems,
			chunkSize,
			chunkCharLimit,
			maxConcurrency: adaptiveMode ? MAX_HISTORICAL_PRIMARY_CONCURRENCY : configuredConcurrency,
			requestChunk: (chunk, chunkMeta) => requestPrimaryChunk(owner, engineKey, chunk, job, chunkMeta),
			isCurrent,
			onChunkSettled,
			onChunkOutcome,
			getDesiredConcurrency: () => {const snapshot = adaptiveSnapshot(job, {liveBusy: liveIsBusy(owner)}); activeJobCaps.set(job, snapshot.effectiveCap); return snapshot.effectiveCap;},
			onPressure: pressure => {const reason = pressure && pressure.failureKind || "provider_pressure"; if (!job || job.historicalPressureReason !== reason) lockProviderPressure(reason, job, {cooldownMs: reason === "rate_limit" ? 5000 : 1000});}
		});
	}
	function runClassicPrimaryItems(owner, engineKey, preparedItems, job, requestItem, onChunkSettled, onChunkOutcome = null) {const isCurrent = () => jobIsCurrent(owner, job); return runChunkedHistoricalBatch({preparedItems, chunkSize: 1, chunkCharLimit, maxConcurrency: adaptiveMode ? MAX_HISTORICAL_PRIMARY_CONCURRENCY : configuredConcurrency, requestChunk: (chunk, chunkMeta) => requestPrimaryChunk(owner, engineKey, chunk, job, Object.assign({}, chunkMeta, {historicalBatch: false, requestFactory: timingContext => requestItem(chunk[0], timingContext)})), isCurrent, onChunkSettled, onChunkOutcome, getDesiredConcurrency: () => {const snapshot = adaptiveSnapshot(job, {liveBusy: liveIsBusy(owner)}); activeJobCaps.set(job, snapshot.effectiveCap); return snapshot.effectiveCap;}, onPressure: pressure => {const reason = pressure && pressure.failureKind || "provider_pressure"; if (!job || job.historicalPressureReason !== reason) lockProviderPressure(reason, job, {cooldownMs: reason === "rate_limit" ? 5000 : 1000});}});}

	function recordRepair(job, mode, messageCount) {
		primarySamples.recordRepair({jobKey: job && job.id, mode, messageCount});
		try {return trace.recordRepairRequest(job && job.historicalPerformanceToken, {mode, messageCount});}
		catch (error) {return false;}
	}

	function runRepairRequest(owner, job, mode, messageCount, requestFactory, engineKey = null, preparedItems = []) {
		const h1LogicalContext = createH1LogicalContext(owner, job, {role: "repair", itemCount: messageCount, preparedItems});
		let batchTimingContext = null;
		let itemTraceContext = h1LogicalContext;
		return runPhysicalRequest(owner, job, () => requestFactory(mode === "batch" ? batchTimingContext : itemTraceContext), leaseMetrics => {
			recordRepair(job, mode, messageCount);
			let latencyToken = null;
			try {latencyToken = owner.ensureProviderClient().beginLatencyRequest({kind: "historical", lane: mode === "batch" ? "batch-repair" : "item-repair", messageCount, inputChars: null});}
			catch (error) {}
			if (mode === "batch") batchTimingContext = h1LogicalContext.createTimingContext({token: latencyToken, role: "retry", observationRole: "repair", engineKey, messageCount, leaseWaitMs: leaseMetrics && leaseMetrics.leaseWaitMs, historicalBatch: true});
			else itemTraceContext = Object.freeze(Object.assign({}, h1LogicalContext, {createTimingContext: base => h1LogicalContext.createTimingContext(Object.assign({token: latencyToken, observationRole: "repair", leaseWaitMs: leaseMetrics && leaseMetrics.leaseWaitMs}, base || {}))}));
		}, {h1LogicalContext}).then(outcome => {
			h1LogicalContext.finish(outcome && outcome.cancelledBeforeDispatch ? "cancelled" : "settled");
			return outcome;
		}, error => {
			h1LogicalContext.finish("failed");
			throw error;
		});
	}

	function recordCommitPreparation(job, counts) {
		return !!traceCall("recordCommitPreparation", job && job.historicalPerformanceToken, counts || {});
	}

	function recordAtomicCommit(job, batchOutcome, resultCount, error = false) {
		try {return trace.recordAtomicCommit(job && job.historicalPerformanceToken, {
			resultCount,
			committedCount: [].concat(batchOutcome && batchOutcome.committedIds || []).length,
			confirmedCount: [].concat(batchOutcome && batchOutcome.confirmedIds || []).length,
			deferredCount: [].concat(batchOutcome && batchOutcome.deferredIds || []).length,
			rejectedCount: [].concat(batchOutcome && batchOutcome.rejectedIds || []).length,
			missingCount: [].concat(batchOutcome && batchOutcome.missingIds || []).length,
			retryCount: [].concat(batchOutcome && batchOutcome.retryIds || []).length,
			staleCount: [].concat(batchOutcome && batchOutcome.staleIds || []).length,
			error
		});}
		catch (traceError) {return false;}
	}

	function recordCache(job, metrics) {
		primarySamples.recordCache(metrics || {});
		return !!traceCall("recordCache", job && job.historicalPerformanceToken, metrics || {});
	}

	function recordValidationReason(job, prepared, reason, options = {}) {
		if (prepared && prepared.semanticRequest) try {const observed = recordSemanticObservation({token: prepared.wireObservationToken || null, reason: normalizeSemanticReason(reason), lane: options.phase === "repair" || options.phase === "item" ? "item-repair" : "history-primary"}); if (observed && typeof observed.then == "function") Promise.resolve(observed).catch(() => {});} catch (error) {}
		return primarySamples.recordValidation({jobKey: job && job.id, messageId: prepared && prepared.message && prepared.message.id, reason, repairEligible: options.repairEligible === true, phase: options.phase || "primary"});
	}

	function recordParseValidate(job, metrics) {
		return !!traceCall("recordParseValidate", job && job.historicalPerformanceToken, metrics || {});
	}

	function recordDomConfirm(job, metrics) {
		return !!traceCall("recordDomConfirm", job && job.historicalPerformanceToken, metrics || {});
	}

	function recordDomConfirmByBatchKey(batchKey, metrics) {
		return !!traceCall("recordDomConfirmByBatchKey", batchKey, metrics || {});
	}

	function getControllerSnapshot() {
		const adaptive = adaptiveSnapshot();
		const primarySampleSnapshot = primarySamples.getSnapshot();
		return Object.freeze(Object.assign({}, trace.getSnapshot(), {
			configuredConcurrency: adaptive.selectedCap,
			adaptiveMode: adaptive.adaptiveMode,
			safetyLimiterEnabled: safetyLimiterEnabled(),
			maxConfiguredConcurrency: MAX_HISTORICAL_PRIMARY_CONCURRENCY,
			cleanPromotionStreak: adaptive.promotionEvidence,
			learnedTier: adaptive.learnedTier,
			promotionEvidence: adaptive.promotionEvidence,
			effectiveCap: adaptive.effectiveCap,
			effectiveReason: adaptive.effectiveReason,
			cooldownRemainingMs: adaptive.cooldownRemainingMs,
			adaptiveKeyStateCount: adaptive.keyStateCount,
			adaptiveLateObservationCount: adaptive.lateObservationCount,
			adaptivePressureCount: adaptive.pressureCount,
			adaptivePromotionCount: adaptive.promotionCount,
			tierEpoch: adaptive.tierEpoch,
			pressureLocked: !!(adaptive.effectiveReason && adaptive.effectiveReason !== "live_busy" && adaptive.effectiveCap < adaptive.selectedCap),
			pressureReason: adaptive.effectiveReason,
			physical: physicalLeases.getSnapshot(),
			providerBudget: providerBudgets.getSnapshot(),
			adaptiveResources: adaptive.resources,
			primarySamples: primarySampleSnapshot,
			s8Gate: primarySampleSnapshot.s8Gate,
			historicalAbortControllerCount: [...abortControllersByJob.values()].reduce((total, entries) => total + entries.size, 0),
			historicalAbortCount
		}));
	}

	return Object.freeze({
		begin,
		finish,
		runPrimaryBatch,
		runClassicPrimaryItems,
		runRepairBatch: (owner, job, messageCount, requestFactory, engineKey = null, preparedItems = []) => runRepairRequest(owner, job, "batch", messageCount, requestFactory, engineKey, preparedItems),
		runRepairItem: (owner, job, requestFactory, prepared = null) => runRepairRequest(owner, job, "item", 1, requestFactory, null, prepared ? [prepared] : []),
		recordAtomicCommit,
		recordCommitPreparation,
		recordCache,
		recordValidationReason,
		recordParseValidate,
		recordDomConfirm,
		recordDomConfirmByBatchKey,
		abortJobAttempts,
		captureTransportKey: captureJobTransportKey,
		recordLiveDemand: resetAdaptiveTierForLive,
		recordLiveTurnStarted: () => {
			resetAdaptiveTierForLive();
			primarySamples.recordLiveOverlap();
			try {return trace.recordLiveTurnStarted();}
			catch (error) {return 0;}
		},
		setConcurrency(value, {resetTrace = false} = {}) {
			selectedConcurrency = String(value) === "auto" ? "auto" : String(normalizeConcurrency(value));
			adaptiveMode = selectedConcurrency === "auto";
			adaptiveTiers.setMode(selectedConcurrency);
			const adaptive = adaptiveSnapshot();
			if (resetTrace) try {trace.reset();} catch (error) {}
			try {physicalLeases.setCapacity(adaptive.selectedCap);}
			catch (error) {}
			try {providerBudgets.setCapacity(adaptive.selectedCap);}
			catch (error) {}
			return adaptive.selectedCap;
		},
		getSnapshot: getControllerSnapshot,
		start() {
			selectedConcurrency = "auto";
			adaptiveMode = true;
			currentTransportKey = null;
			activeJobCaps.clear();
			adaptiveTiers.start("auto");
			primarySamples.start();
			adaptiveSnapshot();
			try {trace.reset();} catch (error) {}
			abortControllersByJob.clear();
			historicalAbortCount = 0;
			physicalLeases.start(DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY);
			providerBudgets.start(DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY);
		},
		stop() {
			currentTransportKey = null;
			activeJobCaps.clear();
			adaptiveTiers.stop();
			adaptiveSnapshot();
			try {trace.reset();} catch (error) {}
			abortAllJobAttempts("plugin-stopped");
			physicalLeases.stop();
			const providerDrain = providerBudgets.stop();
			return Promise.all([physicalLeases.drain(), providerDrain]).then(() => {primarySamples.stop();});
		},
		resetPrimarySamples: () => primarySamples.reset(),
		flushPrimarySamples: () => primarySamples.flush()
	});
}

module.exports = {DEFAULT_HISTORICAL_PRIMARY_CONCURRENCY, MAX_HISTORICAL_PRIMARY_CONCURRENCY, CLEAN_RUNS_REQUIRED_FOR_PROMOTION, createPluginHistoricalBatchPerformance};
