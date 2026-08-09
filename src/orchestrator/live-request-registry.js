function createLiveRequestRegistry({
	normalizeChannelId = value => value == null ? "" : String(value),
	isRuntimeActive = () => true,
	isTranslationEnabled = () => false,
	extractOriginalContentData = () => null,
	createTranslationSignature = () => null,
	releaseDisplayPending = () => {},
	clearReservedLiveRequest = () => false,
	retireReservedLiveRequest = () => false
} = {}) {
	let queuedMessages = {};
	let liveRequests = {};
	let requestSequence = 0;
	let runtimeGeneration = 0;

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

	function finishRequest(request) {
		if (!request) return false;
		const key = getRequestKey(request.messageId, request.channelId);
		if (liveRequests[key] === request) delete liveRequests[key];
		forgetQueuedRequest(request);
		releaseRequestDisplayPending(request);
		retireReservedLiveRequest(request.channelId, String(request.id), "request-finished");
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

	function invalidateRequests(channelId = null) {
		clearReservedLiveRequest(channelId);
		if (!channelId) runtimeGeneration++;
		const channelKey = normalizeChannelId(channelId);
		for (const requestKey of Object.keys(liveRequests)) {
			const request = liveRequests[requestKey];
			if (channelKey && normalizeChannelId(request.channelId) !== channelKey) continue;
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
		retireReservedLiveRequest(channelId, String(request.id), "source-invalidated");
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
		isRequestCurrent,
		finishRequest,
		releaseRequestDisplayPending,
		invalidateRequests,
		invalidateRequestForMessage,
		restartRequestGeneration() {
			runtimeGeneration++;
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
