// Owns the LIVE automatic translation queue: the pending items and their order, the
// live-request registry that decides whether a late result may still land, the busy
// flags that keep exactly one translation running at a time, the retry timer, and the
// per-channel session bookkeeping. Before this module those ten vars lived in the
// plugin factory closure where any of the 8000 surrounding lines could write them, and
// several of the invariants below are fixes for bugs that shipped.
//
// The split is deliberate: this module owns queue STATE and ORDER, not translation
// policy. Preparing an item, calling the provider, validating a result, persisting a
// cache entry and committing to the display store all arrive as injected callbacks.
//
// A queue instance is per plugin instance, so a plugin restart drops all of it.

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
	onQueueIdle = () => {},
	// Translation policy. Everything below decides what a translation IS; the queue only
	// decides when it runs, in what order, and what happens to the item afterwards.
	getBatchEngineKey = () => null,
	createBurstContext = () => null,
	prepareBurstItem = () => null,
	requestBurstTranslation = () => Promise.resolve(null),
	resolveBurstItemResult = () => ({status: "retry"}),
	commitBurstResult = () => null,
	commitCachedResult = () => null,
	translateSingleItem = () => Promise.resolve()
} = {}) {
	const startTimer = scheduleTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
	const stopTimer = cancelTimer || (handle => globalThis.clearTimeout(handle));

	// Newest-first: enqueue unshifts and processing shifts the head, so a message that
	// just arrived is translated before a backlog the user has already scrolled past.
	let queue = [];
	let queuedMessages = {};
	let liveRequests = {};
	let requestSequence = 0;
	let runtimeGeneration = 0;
	// The manual/sent translation lock. Separate from the live lock because the two are
	// set by different call sites and only the live one resumes the queue.
	let busyTranslating = false;
	let liveAutoTranslating = false;
	let retryTimer = null;
	let channelStates = {};
	let lastChannelId = null;

	function getRequestKey(messageId, channelId) {
		return `${channelId || "__global"}:${String(messageId || "")}`;
	}

	// A live request that ends without a terminal commit must return its store record to
	// idle; a lingering pending identity would poison later commits for that message.
	function releaseRequestDisplayPending(request) {
		if (!request) return false;
		releaseDisplayPending({
			messageId: request.messageId,
			channelId: request.channelId,
			requestIdentity: String(request.id)
		});
		return true;
	}

	// Only the request that still owns the message may drop its queued marker; a newer
	// request has already replaced it and must keep the message marked as pending.
	function forgetQueuedRequest(request) {
		if (request && queuedMessages[request.messageId] === request) delete queuedMessages[request.messageId];
	}

	function finishRequest(request) {
		if (!request) return false;
		const key = getRequestKey(request.messageId, request.channelId);
		if (liveRequests[key] === request) delete liveRequests[key];
		forgetQueuedRequest(request);
		releaseRequestDisplayPending(request);
		return true;
	}

	function createRequest(message, channelId, originalContentData = null, signature = null) {
		if (!message || !message.id || !channelId) return null;
		const request = {
			id: ++requestSequence,
			generation: runtimeGeneration,
			channelId,
			messageId: String(message.id),
			signature: signature || createTranslationSignature(message, channelId, originalContentData || extractOriginalContentData(message))
		};
		liveRequests[getRequestKey(request.messageId, channelId)] = request;
		return request;
	}

	function isRequestCurrent(request, message = null) {
		if (!request || !isRuntimeActive() || request.generation !== runtimeGeneration || !isTranslationEnabled(request.channelId)) return false;
		if (liveRequests[getRequestKey(request.messageId, request.channelId)] !== request) return false;
		if (!message) return true;
		return createTranslationSignature(message, request.channelId, extractOriginalContentData(message)) === request.signature;
	}

	// Without a channel this bumps the generation, which retires every request that is
	// still holding a reference to the old one even after this map is refilled.
	function invalidateRequests(channelId = null) {
		if (!channelId) runtimeGeneration++;
		const key = normalizeChannelId(channelId);
		for (const requestKey of Object.keys(liveRequests)) {
			const request = liveRequests[requestKey];
			if (key && normalizeChannelId(request.channelId) !== key) continue;
			delete liveRequests[requestKey];
			forgetQueuedRequest(request);
			releaseRequestDisplayPending(request);
		}
	}

	function invalidateRequestForMessage(messageId, channelId, currentSignature) {
		if (!messageId || !channelId || !currentSignature) return false;
		const key = getRequestKey(messageId, channelId);
		const request = liveRequests[key];
		if (!request || request.signature === currentSignature) return false;
		delete liveRequests[key];
		forgetQueuedRequest(request);
		releaseRequestDisplayPending(request);
		return true;
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
		invalidateRequests(channelId);
		if (!channelId) {
			queue = [];
			queuedMessages = {};
			cancelQueueRetry();
			if (!liveAutoTranslating) onQueueIdle();
			return;
		}
		const key = normalizeChannelId(channelId);
		queue = queue.filter(queueItem => {
			const shouldRemove = !!(queueItem && queueItem.channel && normalizeChannelId(queueItem.channel.id) === key);
			if (shouldRemove && queueItem.message && queueItem.message.id && (!queueItem.liveRequest || queuedMessages[queueItem.message.id] === queueItem.liveRequest)) delete queuedMessages[queueItem.message.id];
			return !shouldRemove;
		});
		// The whole queue, not just this channel's slice: the retry exists to resume
		// processing, so it stays armed while any item is still waiting.
		if (!queue.length && retryTimer) cancelQueueRetry();
		if (!queue.length && !liveAutoTranslating) onQueueIdle();
	}

	function getChannelState(channelId) {
		if (!channelId) return null;
		const key = normalizeChannelId(channelId);
		if (!channelStates[key]) channelStates[key] = {
			initialized: false,
			boundaryMessageId: null
		};
		return channelStates[key];
	}

	function resetTracking(channelId = null) {
		if (channelId) {
			delete channelStates[normalizeChannelId(channelId)];
			resetLoadedMessageTracking(channelId);
		}
		else {
			channelStates = {};
			resetLoadedMessageTracking();
		}
		clearEligibleReplyPreviewMessages(channelId);
		if (!channelId || normalizeChannelId(lastChannelId) === normalizeChannelId(channelId)) lastChannelId = null;
	}

	function prepareChannelSession(channelId) {
		if (!channelId || normalizeChannelId(lastChannelId) === normalizeChannelId(channelId)) return;
		const previousChannelId = lastChannelId;
		if (previousChannelId) {
			clearChannelTranslationQueue(previousChannelId);
			// The seen map only serves boundary dedup inside the active channel session;
			// keeping it for left channels grows memory for the whole Discord session.
			resetLoadedMessageTracking(previousChannelId);
			onChannelSessionLeft(previousChannelId);
		}
		lastChannelId = channelId;
		const channelState = getChannelState(channelId);
		channelState.initialized = false;
		channelState.boundaryMessageId = null;
		resetLoadedMessageTracking(channelId);
		clearEligibleReplyPreviewMessages(channelId);
		onChannelSessionStarted(channelId);
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
			liveRequest: null
		};
	}

	function enqueueLiveItem(queueItem) {
		queue.unshift(queueItem);
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
		queueItem.liveRequest = createRequest(message, channelId, queueItem.originalContentData);
		if (!queueItem.liveRequest) return false;
		queuedMessages[message.id] = queueItem.liveRequest;
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
		if (busyTranslating || liveAutoTranslating) return false;
		if (isProviderBackoffActive()) {
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
			if (outcome && outcome.deferredIds && outcome.deferredIds.length) scheduleDisplayFlush(channelId, queueItem.message.id);
			finishRequest(queueItem.liveRequest);
		};
		return Promise.resolve(commit).then(finish, _ => finish(null));
	}

	function handleCachedItem(queueItem) {
		if (!queueItem || !queueItem.cachedTranslation) return false;
		const channelId = queueItem.channel && queueItem.channel.id || "__global";
		completeCommit(queueItem, channelId, commitCachedResult(queueItem, channelId));
		return true;
	}

	function handleGuardFailure(queueItem) {
		if (!queueItem) return false;
		if (shouldAutoTranslateMessage(queueItem.message, queueItem.channel, queueItem.originalContentData, true)) return false;
		finishRequest(queueItem.liveRequest);
		return true;
	}

	// Drains queued live items that can share one AI batch request with the first item:
	// same channel, no cached result, and not already batch-rejected.
	function collectBatchItems(firstItem) {
		const channelId = firstItem.channel && firstItem.channel.id || getMessageChannelId(firstItem.message);
		if (!channelId || firstItem.skipLiveBatch || firstItem.cachedTranslation) return null;
		if (!getBatchEngineKey(channelId)) return null;
		const items = [firstItem];
		for (let index = 0; index < queue.length && items.length < batchItemLimit;) {
			const candidate = queue[index];
			const candidateChannelId = candidate && candidate.channel && candidate.channel.id || candidate && getMessageChannelId(candidate.message);
			if (!candidate || !candidate.message || candidate.historicalLoad || candidate.cachedTranslation || candidate.skipLiveBatch || normalizeChannelId(candidateChannelId) !== normalizeChannelId(channelId)) {
				index++;
				continue;
			}
			queue.splice(index, 1);
			items.push(candidate);
		}
		return items.length > 1 ? {channelId, items} : null;
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
		if (!isRequestCurrent(queueItem.liveRequest, queueItem.message)) {
			finishRequest(queueItem.liveRequest);
			return;
		}
		queue.unshift(queueItem);
	}

	async function translateBurst(burst) {
		const {channelId, items} = burst;
		// Every drained item must reach a terminal state; anything still unsettled when
		// this returns is released so no message is left with a stuck loading indicator.
		const settled = new Set();
		liveAutoTranslating = true;
		try {
			const context = createBurstContext(channelId);
			const prepared = [];
			for (const queueItem of items) {
				try {
					// A source edit or channel switch between queueing and now invalidates
					// the item; the request guard is the same one the single path uses.
					if (!isRequestCurrent(queueItem.liveRequest, queueItem.message)) {
						settled.add(queueItem);
						finishRequest(queueItem.liveRequest);
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
			let resultMap = null;
			try {resultMap = await requestBurstTranslation(context, prepared);}
			catch (error) {resultMap = null;}
			const commits = [];
			for (const preparedItem of prepared) {
				const queueItem = preparedItem.queueItem;
				try {
					const resolved = resolveBurstItemResult(preparedItem, resultMap, channelId) || {status: "retry"};
					// One unusable item must not cost the whole burst: retry it alone.
					if (resolved.status === "retry") {
						requeueBurstItem(queueItem, settled);
						continue;
					}
					// A skip verdict is terminal and its decision is already persisted, so it
					// commits without re-checking the request; paying for a second full-price
					// request to reach the same verdict is waste. A translation still checks,
					// because a stale one would paint over content the user has moved on from.
					if (resolved.status !== "skipped" && !isRequestCurrent(queueItem.liveRequest, queueItem.message)) {
						settled.add(queueItem);
						finishRequest(queueItem.liveRequest);
						continue;
					}
					settled.add(queueItem);
					commits.push(commitBurstItem(queueItem, channelId, resolved.result));
				}
				catch (error) {
					requeueBurstItem(queueItem, settled);
				}
			}
			await Promise.all(commits);
		}
		finally {
			for (const queueItem of items) {
				if (settled.has(queueItem)) continue;
				try {finishRequest(queueItem.liveRequest);}
				catch (error) {}
			}
			liveAutoTranslating = false;
			processQueue();
		}
	}

	function translateSingle(queueItem) {
		liveAutoTranslating = true;
		translateSingleItem(queueItem).then(_ => {
			finishRequest(queueItem.liveRequest);
			liveAutoTranslating = false;
			processQueue();
		}).catch(_ => {
			finishRequest(queueItem.liveRequest);
			liveAutoTranslating = false;
			processQueue();
		});
	}

	function processQueue() {
		if (!beginProcessing()) return;
		if (!queue.length) return onQueueIdle();
		const nextItem = queue.shift();
		if (!nextItem || !nextItem.message) return processQueue();
		if (nextItem.historicalLoad) {
			collectHistoricalMessage(nextItem);
			return processQueue();
		}
		if (handleCachedItem(nextItem)) return processQueue();
		if (handleGuardFailure(nextItem)) return processQueue();
		// beginProcessing already refused to run inside a provider backoff window, so the
		// burst never holds the live lock across a backoff sleep.
		let burst = null;
		try {burst = collectBatchItems(nextItem);}
		catch (error) {burst = null;}
		// The burst runs detached; its own finally resumes the queue, and a failure there
		// must never surface as an unhandled rejection.
		if (burst) return translateBurst(burst).catch(_ => {});
		return translateSingle(nextItem);
	}

	return Object.freeze({
		// Live request registry.
		getRequestKey,
		createRequest,
		isRequestCurrent,
		finishRequest,
		releaseRequestDisplayPending,
		invalidateRequests,
		invalidateRequestForMessage,
		// A restart retires every in-flight request without releasing display pending
		// records, because the display runtime is reset separately on start.
		restartRequestGeneration() {
			runtimeGeneration++;
			liveRequests = {};
		},
		getRuntimeGeneration: () => runtimeGeneration,
		// Queued-message markers. Historical jobs park their own marker shape here so a
		// single lookup answers "is this message already spoken for".
		isMessageQueued: messageId => !!queuedMessages[messageId],
		getQueuedMarker: messageId => queuedMessages[messageId] || null,
		markMessageQueued(messageId, marker) {
			queuedMessages[messageId] = marker;
			return marker;
		},
		clearQueuedMessage(messageId) {
			delete queuedMessages[messageId];
		},
		// Only the job that placed the marker may remove it; a later job has already
		// claimed the message and still needs it to read as pending.
		clearHistoricalQueuedMessage(messageId, jobId) {
			const marker = messageId && queuedMessages[messageId];
			if (!marker || marker.type !== "historical" || marker.jobId !== jobId) return false;
			delete queuedMessages[messageId];
			return true;
		},
		clearAllQueuedMessages() {
			queuedMessages = {};
		},
		// Queue contents and order.
		createQueueItem,
		enqueueLiveItem,
		queueMessage,
		clearQueue,
		processQueue,
		beginProcessing,
		isQueueEmpty: () => !queue.length,
		getQueueLength: () => queue.length,
		// A copy: a reader must not be able to reorder the queue behind this module's back.
		getQueueSnapshot: () => queue.slice(),
		collectBatchItems,
		requeueBurstItem,
		translateBurst,
		translateSingle,
		handleCachedItem,
		handleGuardFailure,
		// Busy flags.
		isBusyTranslating: () => !!busyTranslating,
		setBusyTranslating(value) {
			busyTranslating = !!value;
		},
		isLiveAutoTranslating: () => !!liveAutoTranslating,
		setLiveAutoTranslating(value) {
			liveAutoTranslating = !!value;
		},
		// Retry timer.
		scheduleQueueRetry,
		cancelQueueRetry,
		hasPendingQueueRetry: () => !!retryTimer,
		// Per-channel session bookkeeping.
		getChannelState,
		prepareChannelSession,
		resetTracking,
		getLastChannelId: () => lastChannelId
	});
}

module.exports = {
	AUTO_TRANSLATION_QUEUE_RETRY_DELAY,
	LIVE_AI_BATCH_ITEM_LIMIT,
	createLiveTranslationQueue
};
