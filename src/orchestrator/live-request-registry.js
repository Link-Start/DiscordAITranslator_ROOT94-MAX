function createLiveRequestRegistry({
	normalizeChannelId = value => value == null ? "" : String(value),
	isRuntimeActive = () => true,
	isTranslationEnabled = () => false,
	extractOriginalContentData = () => null,
	createTranslationSignature = () => null,
	releaseDisplayPending = () => {},
	clearReservedLiveRequest = () => false,
	retireReservedLiveRequest = () => false,
	createAbortController = () => new AbortController()
} = {}) {
	let queuedMessages = {};
	let liveRequests = {};
	let requestSequence = 0;
	let runtimeGeneration = 0;
	// Monotonic and read-only outside this closure. Provider fences use it to tell
	// whether a side-effecting currentness callback changed request identity after an
	// earlier item in the same pass had already been checked.
	let mutationRevision = 0;
	const finishedRequests = new WeakSet();
	const requestControllers = new WeakMap();

	function getRequestKey(messageId, channelId) {
		return `${channelId || "__global"}:${String(messageId || "")}`;
	}

	function releaseRequestDisplayPending(request) {
		if (!request) return false;
		releaseDisplayPending({
			messageId: request.messageId,
			channelId: request.channelId,
			requestIdentity: String(request.id)
		});
		return true;
	}

	function forgetQueuedRequest(request) {
		if (request && queuedMessages[request.messageId] === request) delete queuedMessages[request.messageId];
	}

	function abortRequest(request, reason) {
		const controller = request && requestControllers.get(request);
		if (!controller || controller.signal.aborted) return false;
		try {controller.abort(String(reason || "cancelled"));}
		catch (error) {try {controller.abort();} catch (nestedError) {}}
		return true;
	}

	function finishRequest(request, reason = "request-finished") {
		if (!request || finishedRequests.has(request)) return false;
		mutationRevision++;
		finishedRequests.add(request);
		const key = getRequestKey(request.messageId, request.channelId);
		if (liveRequests[key] === request) delete liveRequests[key];
		forgetQueuedRequest(request);
		abortRequest(request, reason);
		releaseRequestDisplayPending(request);
		retireReservedLiveRequest(request.channelId, String(request.id), reason);
		return true;
	}

	function createRequest(message, channelId, originalContentData = null, signature = null) {
		if (!message || !message.id || !channelId) return null;
		mutationRevision++;
		const key = getRequestKey(message.id, channelId);
		const previous = liveRequests[key];
		if (previous) finishRequest(previous);
		const controller = createAbortController();
		const request = {
			id: ++requestSequence,
			generation: runtimeGeneration,
			channelId,
			messageId: String(message.id),
			signature: signature || createTranslationSignature(message, channelId, originalContentData || extractOriginalContentData(message)),
			signal: controller.signal
		};
		requestControllers.set(request, controller);
		liveRequests[key] = request;
		return request;
	}

	function isRequestCurrent(request, message = null) {
		if (!request || request.signal && request.signal.aborted || !isRuntimeActive() || request.generation !== runtimeGeneration || !isTranslationEnabled(request.channelId)) return false;
		if (liveRequests[getRequestKey(request.messageId, request.channelId)] !== request) return false;
		if (!message) return true;
		return createTranslationSignature(message, request.channelId, extractOriginalContentData(message)) === request.signature;
	}

	function invalidateRequests(channelId = null) {
		mutationRevision++;
		clearReservedLiveRequest(channelId);
		if (!channelId) runtimeGeneration++;
		const channelKey = normalizeChannelId(channelId);
		const invalidatedRequests = [];
		for (const requestKey of Object.keys(liveRequests)) {
			const request = liveRequests[requestKey];
			if (channelKey && normalizeChannelId(request.channelId) !== channelKey) continue;
			delete liveRequests[requestKey];
			finishedRequests.add(request);
			forgetQueuedRequest(request);
			abortRequest(request, channelKey ? "channel-invalidated" : "all-invalidated");
			invalidatedRequests.push(request);
		}
		// Retire the complete registry snapshot before invoking host-owned release hooks.
		// A throwing hook must not leave later old-generation requests addressable.
		let firstReleaseError = null;
		for (const request of invalidatedRequests) {
			try {releaseRequestDisplayPending(request);}
			catch (error) {if (!firstReleaseError) firstReleaseError = error;}
		}
		if (firstReleaseError) throw firstReleaseError;
	}

	function invalidateRequestForMessage(messageId, channelId, currentSignature) {
		if (!messageId || !channelId || !currentSignature) return false;
		const key = getRequestKey(messageId, channelId);
		const request = liveRequests[key];
		if (!request || request.signature === currentSignature) return false;
		mutationRevision++;
		delete liveRequests[key];
		finishedRequests.add(request);
		forgetQueuedRequest(request);
		abortRequest(request, "source-invalidated");
		releaseRequestDisplayPending(request);
		retireReservedLiveRequest(channelId, String(request.id), "source-invalidated");
		return true;
	}

	function removeMessage(messageId, channelId) {
		if (!messageId || !channelId) return false;
		const key = getRequestKey(messageId, channelId);
		const request = liveRequests[key];
		if (!request) return false;
		mutationRevision++;
		delete liveRequests[key];
		finishedRequests.add(request);
		forgetQueuedRequest(request);
		abortRequest(request, "source-deleted");
		releaseRequestDisplayPending(request);
		retireReservedLiveRequest(channelId, String(request.id), "source-deleted");
		return true;
	}

	function clearQueuedMessage(messageId, expectedMarker = null) {
		if (expectedMarker && queuedMessages[messageId] !== expectedMarker) return false;
		if (!Object.prototype.hasOwnProperty.call(queuedMessages, messageId)) return false;
		delete queuedMessages[messageId];
		return true;
	}

	return Object.freeze({
		getRequestKey,
		createRequest,
		abortRequest,
		isRequestCurrent,
		finishRequest,
		releaseRequestDisplayPending,
		invalidateRequests,
		invalidateRequestForMessage,
		removeMessage,
		getMutationRevision: () => mutationRevision,
		restartRequestGeneration() {
			mutationRevision++;
			runtimeGeneration++;
			for (const request of Object.values(liveRequests)) {
				finishedRequests.add(request);
				abortRequest(request, "runtime-restarted");
				// Restart owns only the live request identity. A historical/new-generation
				// marker may already have replaced it under the same message id.
				forgetQueuedRequest(request);
			}
			liveRequests = {};
		},
		getRuntimeGeneration: () => runtimeGeneration,
		isMessageQueued: messageId => !!queuedMessages[messageId],
		getQueuedMarker: messageId => queuedMessages[messageId] || null,
		markMessageQueued(messageId, marker) {
			queuedMessages[messageId] = marker;
			return marker;
		},
		clearQueuedMessage,
		clearHistoricalQueuedMessage(messageId, jobId) {
			const marker = messageId && queuedMessages[messageId];
			if (!marker || marker.type !== "historical" || marker.jobId !== jobId) return false;
			return clearQueuedMessage(messageId, marker);
		},
		clearAllQueuedMessages() {
			queuedMessages = {};
		}
	});
}

module.exports = {createLiveRequestRegistry};
