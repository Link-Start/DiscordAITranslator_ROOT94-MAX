// Owns live queue order, translation locks and retry scheduling. Request validity,
// channel sessions and handoff reservations live in their dedicated modules.
// The split is deliberate: this module owns queue STATE and ORDER, not translation
// policy. Preparing an item, calling the provider, validating a result, persisting a
// cache entry and committing to the display store all arrive as injected callbacks.
// A queue instance is per plugin instance, so a plugin restart drops all of it.

const {createLiveHandoffReservations} = require("./live-handoff-reservations");
const {createLiveRequestRegistry} = require("./live-request-registry");
const {createLiveChannelSession} = require("./live-channel-session");
const {createLiveSlotLeaseOwner} = require("./live-slot-lease-owner");

// How long the queue waits before re-checking a condition that blocked it (a provider
// backoff window, most often). Short enough that a live message is not visibly late.
const AUTO_TRANSLATION_QUEUE_RETRY_DELAY = 900;
// A live burst drains into one AI batch request instead of one request per message;
// the cap keeps a single prompt within comfortable output limits.
const LIVE_AI_BATCH_ITEM_LIMIT = 10;

function normalizeChannelId(channelId) {
	return channelId == null ? "" : String(channelId);
}

function createLiveTranslationQueue({
	setTimeout: scheduleTimer = null,
	clearTimeout: cancelTimer = null,
	now = Date.now,
	batchItemLimit = LIVE_AI_BATCH_ITEM_LIMIT,
	retryDelay = AUTO_TRANSLATION_QUEUE_RETRY_DELAY,
	// Runtime facts the queue has to consult but must never own.
	isRuntimeActive = () => true,
	isTranslationEnabled = () => false,
	extractOriginalContentData = () => null,
	createTranslationSignature = () => null,
	getMessageChannelId = () => null,
	isProviderBackoffActive = () => false,
	shouldAutoTranslateMessage = () => false,
	isMessageWithinLoadedRange = () => true,
	// Display-store ownership stays with the display modules; the queue only says when.
	getDisplayCommitGeneration = () => 0,
	markDisplayPending = () => null,
	releaseDisplayPending = () => {},
	scheduleDisplayFlush = () => {},
	// Neighbouring runtime state that a channel session has to reset alongside ours.
	collectHistoricalMessage = () => false,
	resetLoadedMessageTracking = () => {},
	clearEligibleReplyPreviewMessages = () => {},
	clearChannelTranslationQueue = () => {},
	onChannelSessionLeft = () => {},
	onChannelSessionStarted = () => {},
	onLiveMessageQueued = () => {},
	onLiveTurnStarted = () => {},
	onReservedLiveRequestConsumed = () => {},
	onReservedLiveRequestRetired = () => {},
	// Translation policy. Everything below decides what a translation IS; the queue only
	// decides when it runs, in what order, and what happens to the item afterwards.
	getBatchEngineKey = () => null,
	createBurstContext = () => null,
	prepareBurstItem = () => null,
	requestBurstTranslation = () => Promise.resolve(null),
	resolveBurstItemResult = () => ({status: "retry"}),
	commitBurstResult = () => null,
	commitCachedResult = () => null,
	translateSingleItem = () => Promise.resolve(),
	// F0 observation seam. Optional {notify(type, payload)}; every emission is a
	// guarded no-op when absent, so queue behaviour is byte-identical without it.
	observer = null
} = {}) {
	const startTimer = scheduleTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
	const stopTimer = cancelTimer || (handle => globalThis.clearTimeout(handle));

	// Newest-first: enqueue unshifts and processing shifts the head, so a message that
	// just arrived is translated before a backlog the user has already scrolled past.
	let queue = [];
	// The manual/sent translation lock. Separate from the live lock because the two are
	// set by different call sites and only the live one resumes the queue.
	let busyTranslating = false;
	let compatibilityLiveSlotLease = null;
	let compatibilityLiveSlotRequested = false;
	// Acquisition and burst membership planning is one short synchronous critical
	// section. Reentrant queue entry records demand and is resumed after the plan.
	let providerPlanning = false;
	let providerPlanningPending = false;
	let retryTimer = null;
	let lastConsumedLiveRequests = {};
	const handoffReservations = createLiveHandoffReservations({onRetired: onReservedLiveRequestRetired});
	const channelSession = createLiveChannelSession({
		normalizeChannelId,
		resetLoadedMessageTracking,
		clearEligibleReplyPreviewMessages,
		clearChannelTranslationQueue,
		onChannelSessionLeft,
		onChannelSessionStarted,
		onLiveTurnStarted
	});
	const requestRegistry = createLiveRequestRegistry({
		normalizeChannelId,
		isRuntimeActive,
		isTranslationEnabled,
		extractOriginalContentData,
		createTranslationSignature,
		releaseDisplayPending,
		clearReservedLiveRequest: handoffReservations.clear,
		retireReservedLiveRequest: handoffReservations.retire
	});

	function notifyObserver(type, payload) {
		if (!observer || typeof observer.notify != "function") return;
		try {observer.notify(type, payload);}
		catch (error) {}
	}

	const liveSlotLeaseOwner = createLiveSlotLeaseOwner({
		onActiveCountChanged: active => notifyObserver("lane-active", {active})
	});

	function observerIds(queueItem) {
		let channelId = "";
		try {channelId = queueItem && queueItem.channel && queueItem.channel.id || queueItem && getMessageChannelId(queueItem.message);}
		catch (error) {}
		return {
			channelId: normalizeChannelId(channelId),
			messageId: queueItem && queueItem.message && queueItem.message.id != null ? String(queueItem.message.id) : null
		};
	}

	function cancelQueueRetry() {
		if (retryTimer) stopTimer(retryTimer);
		retryTimer = null;
	}

	function scheduleQueueRetry() {
		if (retryTimer) return;
		retryTimer = startTimer(_ => {
			retryTimer = null;
			processQueue();
		}, retryDelay);
	}

	function clearQueue(channelId = null) {
		if (!channelId) {
			queue = [];
			requestRegistry.clearAllQueuedMessages();
			lastConsumedLiveRequests = {};
			handoffReservations.clear();
			cancelQueueRetry();
			// A force-update clears waiting work while the transport is still physically
			// running, so only stop-time (inactive) cleanup resets logical ownership.
			const resetLiveOwner = !isRuntimeActive();
			if (resetLiveOwner) {
				compatibilityLiveSlotRequested = false;
				compatibilityLiveSlotLease = null;
			}
			// Generation/state invalidation precedes lane-zero publication. A reentrant
			// observer can therefore create only new-generation work, and there is no
			// outer cleanup after reset that could erase its nested state. The finally is
			// required because releaseDisplayPending is a host hook and may throw.
			if (resetLiveOwner) {
				try {requestRegistry.invalidateRequests();}
				finally {liveSlotLeaseOwner.reset();}
			}
			else requestRegistry.invalidateRequests();
			return;
		}
		requestRegistry.invalidateRequests(channelId);
		const key = normalizeChannelId(channelId);
		delete lastConsumedLiveRequests[key];
		handoffReservations.clear(channelId);
		queue = queue.filter(queueItem => {
			const shouldRemove = !!(queueItem && queueItem.channel && normalizeChannelId(queueItem.channel.id) === key);
			if (shouldRemove && queueItem.message && queueItem.message.id) requestRegistry.clearQueuedMessage(queueItem.message.id, queueItem.liveRequest || null);
			return !shouldRemove;
		});
		// The whole queue, not just this channel's slice: the retry exists to resume
		// processing, so it stays armed while any item is still waiting.
		if (!queue.length && retryTimer) cancelQueueRetry();
	}

	function removeMessage(messageId, channelId) {
		const normalizedMessageId = messageId == null ? "" : String(messageId);
		const normalizedChannelId = normalizeChannelId(channelId);
		if (!normalizedMessageId || !normalizedChannelId) return false;
		let removed = requestRegistry.removeMessage(normalizedMessageId, normalizedChannelId);
		queue = queue.filter(queueItem => {
			const queueMessageId = queueItem && queueItem.message && String(queueItem.message.id || "");
			const queueChannelId = normalizeChannelId(queueItem && queueItem.channel && queueItem.channel.id || queueItem && getMessageChannelId(queueItem.message));
			if (queueMessageId !== normalizedMessageId || queueChannelId !== normalizedChannelId) return true;
			removed = true;
			requestRegistry.clearQueuedMessage(normalizedMessageId, queueItem.liveRequest || null);
			return false;
		});
		if (!queue.length && retryTimer) cancelQueueRetry();
		return removed;
	}

	function reserveQueuedLiveRequest(channelId) {
		const key = normalizeChannelId(channelId);
		if (!key) return null;
		for (const queueItem of queue) {
			const queueChannelId = queueItem && queueItem.channel && queueItem.channel.id || queueItem && getMessageChannelId(queueItem.message);
			if (!queueItem || queueItem.historicalLoad || normalizeChannelId(queueChannelId) !== key || !queueItem.liveRequest || !requestRegistry.isRequestCurrent(queueItem.liveRequest)) continue;
			const ticket = String(queueItem.liveRequest.id);
			return handoffReservations.reserve(key, ticket);
		}
		handoffReservations.clear(key);
		return null;
	}

	function recordLiveRequestConsumption(request, reason = "single") {
		if (!request || !request.channelId) return null;
		const key = normalizeChannelId(request.channelId);
		const ticket = String(request.id);
		if (!key) return null;
		lastConsumedLiveRequests[key] = ticket;
		if (handoffReservations.consume(request.channelId, ticket)) onReservedLiveRequestConsumed(request.channelId, ticket, reason);
		return ticket;
	}

	function publishPhysicalLiveTurn(channelId, request, reason) {
		// Both callbacks are host-owned and run only after the provider function has
		// physically been invoked. Guard them independently: a throwing turn hook must
		// neither suppress handoff consumption nor release a still-running provider.
		try {channelSession.noteLiveTurnStarted(channelId);}
		catch (error) {}
		try {recordLiveRequestConsumption(request, reason);}
		catch (error) {}
	}

	function takeNextQueueSelection() {
		if (!queue.length) return null;
		const orderSnapshot = queue.slice();
		const reservedIndex = handoffReservations.findNextQueueIndex(queue, queueItem => ({
			channelId: queueItem && queueItem.channel && queueItem.channel.id || queueItem && getMessageChannelId(queueItem.message),
			ticket: queueItem && queueItem.liveRequest ? queueItem.liveRequest.id : null
		}));
		const index = reservedIndex >= 0 ? reservedIndex : 0;
		return {
			index,
			item: queue.splice(index, 1)[0],
			orderSnapshot
		};
	}

	function restoreQueueSelection(selection) {
		let restoreIndex = -1;
		const orderSnapshot = selection && Array.isArray(selection.orderSnapshot) ? selection.orderSnapshot : [];
		for (let index = selection.index - 1; restoreIndex < 0 && index >= 0; index--) {
			const previousIndex = queue.indexOf(orderSnapshot[index]);
			if (previousIndex >= 0) restoreIndex = previousIndex + 1;
		}
		for (let index = selection.index + 1; restoreIndex < 0 && index < orderSnapshot.length; index++) {
			restoreIndex = queue.indexOf(orderSnapshot[index]);
		}
		// With no surviving old neighbour, every current item arrived after selection and
		// therefore stays ahead of it in this newest-first queue.
		if (restoreIndex < 0) restoreIndex = queue.length;
		queue.splice(restoreIndex, 0, selection.item);
	}

	function resetTracking(channelId = null) {
		if (channelId) {
			delete lastConsumedLiveRequests[normalizeChannelId(channelId)];
			handoffReservations.clear(channelId);
		}
		else {
			lastConsumedLiveRequests = {};
			handoffReservations.clear();
		}
		channelSession.reset(channelId);
	}

	function createQueueItem(message, channel, originalContentData = null, queueOptions = {}) {
		const normalizedOriginalContentData = originalContentData || extractOriginalContentData(message);
		return {
			message,
			channel,
			originalContentData: normalizedOriginalContentData,
			historicalLoad: !!queueOptions.historicalLoad,
			deferHistoricalSnapshotStart: !!queueOptions.deferHistoricalSnapshotStart,
			deferWhileReading: !!queueOptions.deferWhileReading,
			cachedTranslation: queueOptions.cachedTranslation || null,
			terminalRouteId: queueOptions.terminalRouteId || null,
			liveRequest: null,
			resumeLiveBatch: false,
			queuedAt: now(),
			queueWaitMs: null
		};
	}

	function enqueueLiveItem(queueItem) {
		queue.unshift(queueItem);
		notifyObserver("enqueued", Object.assign({queueDepth: queue.length}, observerIds(queueItem)));
		processQueue();
		return true;
	}

	function queueMessage(message, channel, originalContentData = null, queueOptions = {}) {
		const cachedTranslation = queueOptions.cachedTranslation || null;
		if (!cachedTranslation && !shouldAutoTranslateMessage(message, channel, originalContentData)) return false;
		if (queueOptions.historicalLoad && !isMessageWithinLoadedRange(message)) return false;
		const queueItem = createQueueItem(message, channel, originalContentData, queueOptions);
		if (queueItem.historicalLoad) return collectHistoricalMessage(queueItem);
		const channelId = channel && channel.id || getMessageChannelId(message);
		queueItem.liveRequest = requestRegistry.createRequest(message, channelId, queueItem.originalContentData);
		if (!queueItem.liveRequest) return false;
		// The queue is reached from the message-list render pass, before Discord commits
		// the appended live row. Give the viewport owner one chance to preserve a
		// history reader before the host can snap the virtualized list to newest.
		try {onLiveMessageQueued(channelId, String(message.id));}
		catch (error) {}
		requestRegistry.markMessageQueued(message.id, queueItem.liveRequest);
		const pendingMark = markDisplayPending({
			messageId: message.id,
			channelId,
			generation: getDisplayCommitGeneration(channelId),
			origin: "automatic",
			requestIdentity: String(queueItem.liveRequest.id)
		}, {refresh: false});
		if (pendingMark && pendingMark.catch) pendingMark.catch(_ => {});
		return enqueueLiveItem(queueItem);
	}

	function beginProcessing() {
		if (busyTranslating || liveSlotLeaseOwner.getActiveCount() >= liveSlotLeaseOwner.getCapacity()) {
			if (queue.length) notifyObserver("blocked", {reason: busyTranslating ? "manual-lock" : "live-lock"});
			return false;
		}
		if (isProviderBackoffActive()) {
			if (queue.length) notifyObserver("blocked", {reason: "backoff"});
			scheduleQueueRetry();
			return false;
		}
		return true;
	}

	// A commit that deferred part of its work leaves the display store holding a record
	// the message list has not painted; the flush is what paints it. Either way the live
	// request is finished, so a failed commit cannot strand a loading indicator.
	function completeCommit(queueItem, channelId, commit) {
		const finish = outcome => {
			// The flush carries its lane so the rebuild diagnostics can separate cache
			// replays from fresh provider translations (cadence audit 2026-08-19).
			if (outcome && outcome.deferredIds && outcome.deferredIds.length) scheduleDisplayFlush(channelId, queueItem.message.id, queueItem.cachedTranslation ? "cached" : "live");
			requestRegistry.finishRequest(queueItem.liveRequest);
		};
		return Promise.resolve(commit).then(finish, _ => finish(null));
	}

	function handleCachedItem(queueItem) {
		if (!queueItem || !queueItem.cachedTranslation) return false;
		const channelId = queueItem.channel && queueItem.channel.id || "__global";
		notifyObserver("cached-serve", observerIds(queueItem));
		const commit = commitCachedResult(queueItem, channelId);
		recordLiveRequestConsumption(queueItem.liveRequest, "cached");
		completeCommit(queueItem, channelId, commit);
		return true;
	}

	function handleGuardFailure(queueItem) {
		if (!queueItem) return false;
		if (shouldAutoTranslateMessage(queueItem.message, queueItem.channel, queueItem.originalContentData, true)) return false;
		notifyObserver("guard-drop", observerIds(queueItem));
		recordLiveRequestConsumption(queueItem.liveRequest, "guard");
		requestRegistry.finishRequest(queueItem.liveRequest);
		return true;
	}

	// Drains queued live items that can share one AI batch request with the first item:
	// same channel, no cached result, and not already batch-rejected.
	function collectBatchItems(firstItem, candidateSnapshot = null, drainedItems = null) {
		const resumeLiveBatch = !!firstItem.resumeLiveBatch;
		firstItem.resumeLiveBatch = false;
		const channelId = firstItem.channel && firstItem.channel.id || getMessageChannelId(firstItem.message);
		if (!channelId || firstItem.skipLiveBatch || firstItem.cachedTranslation) return null;
		if (!getBatchEngineKey(channelId)) return null;
		const items = [firstItem];
		// Identity membership is frozen before acquisition. Arrivals produced by the
		// lane-active observer remain in the live queue for the next provider turn.
		const candidates = Array.isArray(candidateSnapshot) ? candidateSnapshot : queue.slice();
		for (const candidate of candidates) {
			if (items.length >= batchItemLimit) break;
			const index = queue.indexOf(candidate);
			if (index < 0) continue;
			const candidateChannelId = candidate && candidate.channel && candidate.channel.id || candidate && getMessageChannelId(candidate.message);
			if (!candidate || !candidate.message || candidate.historicalLoad || candidate.cachedTranslation || candidate.skipLiveBatch || normalizeChannelId(candidateChannelId) !== normalizeChannelId(channelId)) {
				continue;
			}
			queue.splice(index, 1);
			items.push(candidate);
			if (Array.isArray(drainedItems)) drainedItems.push(candidate);
		}
		return items.length > 1 || resumeLiveBatch ? {channelId, items} : null;
	}

	function restoreDrainedBatchItems(drainedItems, candidateSnapshot) {
		for (let index = drainedItems.length - 1; index >= 0; index--) {
			const item = drainedItems[index];
			if (queue.includes(item)) continue;
			const snapshotIndex = candidateSnapshot.indexOf(item);
			let restoreIndex = -1;
			for (let nextIndex = snapshotIndex + 1; nextIndex < candidateSnapshot.length; nextIndex++) {
				restoreIndex = queue.indexOf(candidateSnapshot[nextIndex]);
				if (restoreIndex >= 0) break;
			}
			if (restoreIndex < 0) restoreIndex = queue.length;
			queue.splice(restoreIndex, 0, item);
		}
	}

	function isPlannedRequestCurrent(queueItem) {
		try {
			if (!queueItem || !queueItem.message || !queueItem.liveRequest) return false;
			const plannedChannelId = queueItem.channel && queueItem.channel.id || getMessageChannelId(queueItem.message);
			if (!plannedChannelId || normalizeChannelId(plannedChannelId) !== normalizeChannelId(queueItem.liveRequest.channelId)) return false;
			return requestRegistry.isRequestCurrent(queueItem.liveRequest, queueItem.message);
		}
		catch (error) {return false;}
	}

	function classifyPlannedRequests(plannedItems) {
		const items = Array.from(new Set((plannedItems || []).filter(Boolean)));
		const forcedStale = new Set();
		let previousStableKey = null;
		let consecutiveStablePasses = 0;
		// Every pass is synchronous and the ceiling scales only with the frozen plan.
		// A callback that continuously mutates identity therefore fails closed instead of
		// spinning the provider lane forever.
		const maxPasses = Math.max(4, items.length * 2 + 4);
		for (let pass = 0; pass < maxPasses; pass++) {
			const revisionBefore = requestRegistry.getMutationRevision();
			const currentByIndex = [];
			let foundNewStale = false;
			for (const queueItem of items) {
				if (forcedStale.has(queueItem)) {
					currentByIndex.push(false);
					continue;
				}
				const current = isPlannedRequestCurrent(queueItem);
				if (!current) {
					forcedStale.add(queueItem);
					foundNewStale = true;
				}
				currentByIndex.push(current);
			}
			const revisionAfter = requestRegistry.getMutationRevision();
			const classificationKey = currentByIndex.map(current => current ? "1" : "0").join("");
			const stablePass = revisionBefore === revisionAfter && !foundNewStale;
			if (stablePass && classificationKey === previousStableKey) consecutiveStablePasses++;
			else consecutiveStablePasses = stablePass ? 1 : 0;
			previousStableKey = stablePass ? classificationKey : null;
			if (consecutiveStablePasses < 2) continue;
			return {
				stable: true,
				currentItems: items.filter((_, index) => currentByIndex[index]),
				staleItems: items.filter((_, index) => !currentByIndex[index])
			};
		}
		return {stable: false, currentItems: [], staleItems: items.slice()};
	}

	function retireStalePlannedItems(items, site) {
		for (const queueItem of new Set(items)) {
			if (!queueItem) continue;
			notifyObserver("stale-drop", Object.assign({site}, observerIds(queueItem)));
			if (queueItem.message && queueItem.message.id) requestRegistry.clearQueuedMessage(queueItem.message.id, queueItem.liveRequest || null);
			try {requestRegistry.finishRequest(queueItem.liveRequest);}
			catch (error) {}
		}
	}

	function restoreCurrentPlannedItems(selection, plannedItems, candidateSnapshot, currentItems, preserveBurstTurn = false) {
		const currentSet = new Set(currentItems);
		if (preserveBurstTurn && currentItems.length) {
			// One frozen provider turn carries one transport intent. Put it only on the
			// first batch-capable survivor; candidate items must not leak the flag after
			// they are drained behind that driver on the replan.
			const resumeItem = plannedItems.find(queueItem => currentSet.has(queueItem) && !queueItem.skipLiveBatch && !queueItem.cachedTranslation)
				|| plannedItems.find(queueItem => currentSet.has(queueItem));
			for (const queueItem of currentItems) queueItem.resumeLiveBatch = queueItem === resumeItem;
		}
		const currentDrainedItems = plannedItems.slice(1).filter(queueItem => currentSet.has(queueItem));
		restoreDrainedBatchItems(currentDrainedItems, candidateSnapshot);
		if (currentSet.has(selection.item) && !queue.includes(selection.item)) restoreQueueSelection(selection);
	}

	function fenceProviderPlan(selection, plannedItems, candidateSnapshot, liveSlotLease, site, preserveBurstTurn = false, onAbort = null) {
		const frozenPlan = Array.from(new Set((plannedItems || []).filter(Boolean)));
		let classification = classifyPlannedRequests(frozenPlan);
		if (classification.stable && !classification.staleItems.length && liveSlotLeaseOwner.owns(liveSlotLease)) {
			return Object.assign({allowed: true}, classification);
		}

		// A mixed plan is never partially dispatched. Retire a stable stale snapshot,
		// then classify the remaining snapshot again: stale-drop/display/reservation hooks
		// may synchronously invalidate an item that was current in the prior fixed point.
		const retiredItems = new Set();
		let remainingItems = frozenPlan.slice();
		while (remainingItems.length) {
			const newlyStaleItems = classification.stable ? classification.staleItems : remainingItems.slice();
			if (!newlyStaleItems.length) break;
			for (const queueItem of newlyStaleItems) retiredItems.add(queueItem);
			retireStalePlannedItems(newlyStaleItems, site);
			remainingItems = remainingItems.filter(queueItem => !retiredItems.has(queueItem));
			classification = remainingItems.length
				? classifyPlannedRequests(remainingItems)
				: {stable: classification.stable, currentItems: [], staleItems: []};
		}
		const currentItems = classification.stable ? classification.currentItems.slice() : [];
		restoreCurrentPlannedItems(selection, frozenPlan, candidateSnapshot, currentItems, preserveBurstTurn);
		const result = {
			allowed: false,
			stable: classification.stable,
			currentItems,
			staleItems: frozenPlan.filter(queueItem => retiredItems.has(queueItem))
		};
		// The caller marks restored work handled before release can synchronously replan.
		if (typeof onAbort == "function") onAbort(result);
		if (liveSlotLeaseOwner.owns(liveSlotLease)) releaseLiveSlotAndResume(liveSlotLease);
		return result;
	}

	function commitBurstItem(queueItem, channelId, result) {
		const commit = commitBurstResult(queueItem, channelId, Object.assign({
			requestIdentity: queueItem.liveRequest ? String(queueItem.liveRequest.id) : null
		}, result));
		return completeCommit(queueItem, channelId, commit);
	}

	// Returns a burst item to the single-message path, preserving the queue's
	// newest-first order so a retry is never starved behind later arrivals.
	function requeueBurstItem(queueItem, settled) {
		settled.add(queueItem);
		// Sticky: once the batch has refused an item it must never be drained into
		// another burst, or the same rejection repeats forever.
		queueItem.skipLiveBatch = true;
		// A cancelled channel already emptied its queue; re-injecting the item there
		// would restart provider traffic the cancellation was meant to stop.
		if (!requestRegistry.isRequestCurrent(queueItem.liveRequest, queueItem.message)) {
			notifyObserver("stale-drop", Object.assign({site: "burst-requeue"}, observerIds(queueItem)));
			requestRegistry.finishRequest(queueItem.liveRequest);
			return;
		}
		queue.unshift(queueItem);
		notifyObserver("requeued", observerIds(queueItem));
	}

	function releaseLiveSlotAndResume(liveSlotLease) {
		if (!liveSlotLeaseOwner.release(liveSlotLease)) return false;
		processQueue();
		return true;
	}

	async function translateBurst(burst, liveSlotLease, providerPlan) {
		const {channelId, items} = burst;
		// Every drained item must reach a terminal state; anything still unsettled when
		// this returns is released so no message is left with a stuck loading indicator.
		const settled = new Set();
		let providerPlanAborted = false;
		try {
			const context = createBurstContext(channelId);
			context.queueWaitMs = Math.max(0, now() - Math.min(...items.map(item => Number(item.queuedAt) || now())));
			const prepared = [];
			for (const queueItem of items) {
				try {
					// A source edit or channel switch between queueing and now invalidates
					// the item; the request guard is the same one the single path uses.
					if (!requestRegistry.isRequestCurrent(queueItem.liveRequest, queueItem.message)) {
						notifyObserver("stale-drop", Object.assign({site: "burst-pre"}, observerIds(queueItem)));
						settled.add(queueItem);
						requestRegistry.finishRequest(queueItem.liveRequest);
						continue;
					}
					const preparedItem = prepareBurstItem(queueItem, channelId, context);
					if (!preparedItem || preparedItem.skipped || preparedItem.cachedTranslation || !preparedItem.protectedText) {
						// Anything the batch cannot carry goes back to the single path.
						requeueBurstItem(queueItem, settled);
						continue;
					}
					prepared.push(preparedItem);
				}
				catch (error) {
					requeueBurstItem(queueItem, settled);
				}
			}
			if (!prepared.length) return;
			context.messageCount = prepared.length;
			const commits = [];
			const settleResults = (resultMap, terminalFailure = false, retirePrimaryItem = null) => {
				const early = typeof retirePrimaryItem === "function";
				for (const preparedItem of prepared) {
					const queueItem = preparedItem.queueItem;
					if (settled.has(queueItem) || early && (!preparedItem.wholeMarkerBatchFinal || !resultMap || !Object.prototype.hasOwnProperty.call(resultMap, String(preparedItem.message.id)))) continue;
					const finishTerminalItem = () => {
						if (early) retirePrimaryItem(preparedItem);
						settled.add(queueItem);
						try {requestRegistry.finishRequest(queueItem.liveRequest);} catch (error) {}
					};
					try {
						const resolved = resolveBurstItemResult(preparedItem, resultMap, channelId) || {status: "retry"};
						// One unusable item must not cost the whole burst: retry it alone.
						if (resolved.status === "retry") {
							if (terminalFailure || preparedItem.wholeMarkerBatchFinal) {
								finishTerminalItem();
								continue;
							}
							requeueBurstItem(queueItem, settled);
							continue;
						}
						// A skip verdict is terminal and its decision is already persisted, so it
						// commits without re-checking the request; paying for a second full-price
						// request to reach the same verdict is waste. A translation still checks,
						// because a stale one would paint over content the user has moved on from.
						if (resolved.status !== "skipped" && !requestRegistry.isRequestCurrent(queueItem.liveRequest, queueItem.message)) {
							notifyObserver("stale-drop", Object.assign({site: "burst-post"}, observerIds(queueItem)));
							finishTerminalItem();
							continue;
						}
						if (early && !retirePrimaryItem(preparedItem)) {finishTerminalItem(); continue;}
						settled.add(queueItem);
						const commit = commitBurstItem(queueItem, channelId, resolved.result);
						commits.push(preparedItem.wholeMarkerBatchFinal ? Promise.resolve(commit).catch(() => finishTerminalItem()) : commit);
					}
					catch (error) {
						if (preparedItem.wholeMarkerBatchFinal) finishTerminalItem();
						else requeueBurstItem(queueItem, settled);
					}
				}
			};
			// W5 invokes this once with validated-wire primary successes. Reuse the same
			// result policy and display commit path, without waiting for display ACK to
			// dispatch repair. The original live slot stays owned until both have settled.
			context.onPrimaryResults = (resultMap, retirePrimaryItem) => settleResults(resultMap, false, retirePrimaryItem);
			const consumptionItem = prepared.find(preparedItem => preparedItem && preparedItem.queueItem && preparedItem.queueItem.liveRequest) || null;
			let batchOutcome = null;
			let physicalRequest = null;
			let physicalRequestThrew = false;
			// Preparation callbacks are host-owned, so re-classify the frozen identities
			// after all of them. Turn/handoff publication happens only after the provider
			// invocation below, leaving no injected callback in this final dispatch gap.
			const finalFence = fenceProviderPlan(
				providerPlan.selection,
				items,
				providerPlan.candidateSnapshot,
				liveSlotLease,
				"pre-burst-provider",
				true,
				() => {
					providerPlanAborted = true;
					for (const queueItem of items) settled.add(queueItem);
				}
			);
			if (!finalFence.allowed) return;
			try {
				physicalRequest = requestBurstTranslation(context, prepared);
			}
			catch (error) {physicalRequestThrew = true;}
			publishPhysicalLiveTurn(channelId, consumptionItem && consumptionItem.queueItem.liveRequest, "burst");
			// These events describe an attempted physical request, so publish them only
			// after the provider boundary has actually been invoked. Payload assembly is
			// guarded too because clock/channel readers are injected ports.
			try {notifyObserver("burst-request", {channelId: normalizeChannelId(channelId), messageCount: prepared.length});}
			catch (error) {}
			for (const preparedItem of prepared) {
				if (!preparedItem || !preparedItem.queueItem) continue;
				try {
					notifyObserver("dispatched", Object.assign({
						mode: "burst",
						batchSize: prepared.length,
						queueWaitMs: Math.max(0, now() - (Number(preparedItem.queueItem.queuedAt) || now()))
					}, observerIds(preparedItem.queueItem)));
				}
				catch (error) {}
			}
			if (!physicalRequestThrew) {
				try {batchOutcome = await Promise.resolve(physicalRequest);}
				catch (error) {batchOutcome = null;}
			}
			const detailedOutcome = batchOutcome && typeof batchOutcome == "object" && (Object.prototype.hasOwnProperty.call(batchOutcome, "translations") || batchOutcome.failureKind);
			const resultMap = detailedOutcome ? batchOutcome.translations : batchOutcome;
			const terminalFailure = detailedOutcome && ["auth", "configuration", "semantic_schema", "permanent"].includes(batchOutcome.failureKind);
			settleResults(resultMap, terminalFailure);
			await Promise.all(commits);
		}
		finally {
			if (!providerPlanAborted) {
				for (const queueItem of items) {
					if (settled.has(queueItem)) continue;
					try {requestRegistry.finishRequest(queueItem.liveRequest);}
					catch (error) {}
				}
				releaseLiveSlotAndResume(liveSlotLease);
			}
		}
	}

	async function translateSingle(queueItem, liveSlotLease, providerPlan) {
		let providerPlanAborted = false;
		try {
			const channelId = queueItem && queueItem.channel && queueItem.channel.id || getMessageChannelId(queueItem && queueItem.message);
			queueItem.queueWaitMs = Math.max(0, now() - (Number(queueItem.queuedAt) || now()));
			let physicalRequest;
			let physicalRequestThrew = false;
			const finalFence = fenceProviderPlan(
				providerPlan.selection,
				[queueItem],
				providerPlan.candidateSnapshot,
				liveSlotLease,
				"pre-single-provider",
				false,
				() => {providerPlanAborted = true;}
			);
			if (!finalFence.allowed) return;
			try {
				physicalRequest = translateSingleItem(queueItem);
			}
			catch (error) {physicalRequestThrew = true;}
			publishPhysicalLiveTurn(channelId, queueItem && queueItem.liveRequest, "single");
			try {notifyObserver("dispatched", Object.assign({mode: "single", queueWaitMs: queueItem.queueWaitMs}, observerIds(queueItem)));}
			catch (error) {}
			if (!physicalRequestThrew) await Promise.resolve(physicalRequest);
		}
		catch (error) {}
		finally {
			if (!providerPlanAborted) {
				try {requestRegistry.finishRequest(queueItem.liveRequest);}
				catch (error) {}
				releaseLiveSlotAndResume(liveSlotLease);
			}
		}
	}

	function processQueue() {
		if (providerPlanning) {
			providerPlanningPending = true;
			return;
		}
		if (!beginProcessing()) return;
		if (!queue.length) return;
		const selection = takeNextQueueSelection();
		const nextItem = selection && selection.item;
		if (!nextItem || !nextItem.message) return processQueue();
		if (nextItem.historicalLoad) {
			collectHistoricalMessage(nextItem);
			return processQueue();
		}
		if (!requestRegistry.isRequestCurrent(nextItem.liveRequest, nextItem.message)) {
			notifyObserver("stale-drop", Object.assign({site: "queue-head"}, observerIds(nextItem)));
			if (nextItem.message && nextItem.message.id) requestRegistry.clearQueuedMessage(nextItem.message.id, nextItem.liveRequest || null);
			requestRegistry.finishRequest(nextItem.liveRequest);
			return processQueue();
		}
		if (handleCachedItem(nextItem)) return processQueue();
		if (handleGuardFailure(nextItem)) return processQueue();
		// Freeze the base-queue candidate membership and fence synchronous reentry before
		// acquisition. The owner still publishes lane-active:1 before injected burst
		// callbacks, while observer arrivals cannot widen this physical turn.
		let batchCandidateSnapshot = null;
		const plannedItems = [nextItem];
		let liveSlotLease = null;
		let burst = null;
		let canDispatch = false;
		let resumeAfterPlanning = false;
		providerPlanning = true;
		try {
			batchCandidateSnapshot = queue.slice();
			liveSlotLease = liveSlotLeaseOwner.tryAcquire();
			if (!liveSlotLease) {
				// A guard callback may synchronously acquire the compatibility lease after
				// beginProcessing. Restore against its old neighbours so synchronous newer
				// arrivals stay ahead of the selection.
				restoreQueueSelection(selection);
				notifyObserver("blocked", {reason: "live-lock"});
			}
			else if (!fenceProviderPlan(selection, plannedItems, batchCandidateSnapshot, liveSlotLease, "post-acquire").allowed) {
				resumeAfterPlanning = true;
			}
			else {
				let collectionFailed = false;
				try {burst = collectBatchItems(nextItem, batchCandidateSnapshot, plannedItems);}
				catch (error) {collectionFailed = true;}
				// Batch-engine/channel callbacks are also reentrant. A restart invalidates
				// every selected/drained exact marker; none may reach provider dispatch.
				if (!fenceProviderPlan(selection, plannedItems, batchCandidateSnapshot, liveSlotLease, "post-collect", !!burst).allowed) {
					resumeAfterPlanning = true;
				}
				else {
					if (collectionFailed && plannedItems.length > 1) {
						restoreDrainedBatchItems(plannedItems.slice(1), batchCandidateSnapshot);
						plannedItems.length = 1;
						burst = null;
					}
					canDispatch = true;
				}
			}
		}
		finally {
			providerPlanning = false;
			const pending = providerPlanningPending;
			providerPlanningPending = false;
			if (!canDispatch && (resumeAfterPlanning || pending)) processQueue();
		}
		if (!canDispatch) return;
		const providerPlan = {selection, candidateSnapshot: batchCandidateSnapshot};
		// Planning is now open, but the exact provider token already owns capacity.
		// beginProcessing refused backoff before selection, so no lease spans a retry.
		// The burst runs detached; its own finally resumes the queue, and a failure there
		// must never surface as an unhandled rejection.
		if (burst) return translateBurst(burst, liveSlotLease, providerPlan).catch(_ => {});
		return translateSingle(nextItem, liveSlotLease, providerPlan);
	}

	return Object.freeze({
		// Live request registry.
		getRequestKey: requestRegistry.getRequestKey,
		createRequest: requestRegistry.createRequest,
		isRequestCurrent: requestRegistry.isRequestCurrent,
		finishRequest: requestRegistry.finishRequest,
		releaseRequestDisplayPending: requestRegistry.releaseRequestDisplayPending,
		invalidateRequests: requestRegistry.invalidateRequests,
		invalidateRequestForMessage: requestRegistry.invalidateRequestForMessage,
		removeRequestForMessage: requestRegistry.removeMessage,
		// A restart retires every in-flight request without releasing display pending
		// records, because the display runtime is reset separately on start.
		restartRequestGeneration() {
			compatibilityLiveSlotRequested = false;
			compatibilityLiveSlotLease = null;
			requestRegistry.restartRequestGeneration();
			lastConsumedLiveRequests = {};
			handoffReservations.clear();
			// lane-active:0 is the publication boundary. All old-generation state is gone
			// first, and no outer cleanup follows that could erase observer-created state.
			liveSlotLeaseOwner.reset();
		},
		getRuntimeGeneration: requestRegistry.getRuntimeGeneration,
		// Queued-message markers. Historical jobs park their own marker shape here so a
		// single lookup answers "is this message already spoken for".
		isMessageQueued: requestRegistry.isMessageQueued,
		getQueuedMarker: requestRegistry.getQueuedMarker,
		markMessageQueued: requestRegistry.markMessageQueued,
		clearQueuedMessage: requestRegistry.clearQueuedMessage,
		clearHistoricalQueuedMessage: requestRegistry.clearHistoricalQueuedMessage,
		clearAllQueuedMessages() {
			requestRegistry.clearAllQueuedMessages();
			lastConsumedLiveRequests = {};
			handoffReservations.clear();
		},
		// Queue contents and order.
		createQueueItem,
		enqueueLiveItem,
		queueMessage,
		removeMessage,
		clearQueue,
		processQueue,
		beginProcessing,
		isQueueEmpty: () => !queue.length,
		getQueueLength: () => queue.length,
		hasQueuedLiveForChannel(channelId) {
			const key = normalizeChannelId(channelId);
			return !!key && queue.some(queueItem => queueItem && !queueItem.historicalLoad && normalizeChannelId(queueItem.channel && queueItem.channel.id || getMessageChannelId(queueItem.message)) === key);
		},
		reserveQueuedLiveRequest,
		clearReservedLiveRequest: handoffReservations.clear,
		getLastConsumedLiveRequestTicket: channelId => lastConsumedLiveRequests[normalizeChannelId(channelId)] || null,
		getStartedLiveTurnCount: channelSession.getStartedLiveTurnCount,
		// A copy: a reader must not be able to reorder the queue behind this module's back.
		getQueueSnapshot: () => queue.slice(),
		collectBatchItems,
		requeueBurstItem,
		handleCachedItem,
		handleGuardFailure,
		// Busy flags.
		isBusyTranslating: () => !!busyTranslating,
		setBusyTranslating(value) {
			busyTranslating = !!value;
		},
		isLiveAutoTranslating: () => liveSlotLeaseOwner.getActiveCount() > 0,
		setLiveAutoTranslating(value) {
			compatibilityLiveSlotRequested = !!value;
			// Lifecycle reset can invalidate a token while tryAcquire is synchronously
			// notifying observers. Never let that stale pointer suppress a later request.
			if (compatibilityLiveSlotLease && !liveSlotLeaseOwner.owns(compatibilityLiveSlotLease)) {
				compatibilityLiveSlotLease = null;
			}
			if (compatibilityLiveSlotRequested) {
				if (compatibilityLiveSlotLease) return;
				const lease = liveSlotLeaseOwner.tryAcquire();
				// The acquisition notification is reentrant: restart may replace ownership,
				// or a nested false may become the final compatibility intent.
				if (!lease || !liveSlotLeaseOwner.owns(lease)) return;
				if (!compatibilityLiveSlotRequested) {
					liveSlotLeaseOwner.release(lease);
					return;
				}
				// A nested request can install a replacement only after invalidating this
				// token. Keep an exact current pointer and never overwrite it with outer state.
				if (compatibilityLiveSlotLease) {
					liveSlotLeaseOwner.release(lease);
					return;
				}
				compatibilityLiveSlotLease = lease;
				return;
			}
			if (!compatibilityLiveSlotLease) return;
			const lease = compatibilityLiveSlotLease;
			compatibilityLiveSlotLease = null;
			liveSlotLeaseOwner.release(lease);
		},
		getLiveSlotActiveCount: liveSlotLeaseOwner.getActiveCount,
		getLiveSlotCapacity: liveSlotLeaseOwner.getCapacity,
		setLiveSlotCapacity(value) {
			const capacity = liveSlotLeaseOwner.setCapacity(value);
			processQueue();
			return capacity;
		},
		// Retry timer.
		scheduleQueueRetry,
		cancelQueueRetry,
		hasPendingQueueRetry: () => !!retryTimer,
		// Per-channel session bookkeeping.
		getChannelState: channelSession.getChannelState,
		prepareChannelSession: channelSession.prepare,
		resetTracking,
		getLastChannelId: channelSession.getLastChannelId
	});
}

module.exports = {
	AUTO_TRANSLATION_QUEUE_RETRY_DELAY,
	LIVE_AI_BATCH_ITEM_LIMIT,
	createLiveTranslationQueue
};
