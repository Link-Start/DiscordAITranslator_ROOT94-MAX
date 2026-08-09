function createLiveChannelSession({
	normalizeChannelId = value => value == null ? "" : String(value),
	resetLoadedMessageTracking = () => {},
	clearEligibleReplyPreviewMessages = () => {},
	clearChannelTranslationQueue = () => {},
	onChannelSessionLeft = () => {},
	onChannelSessionStarted = () => {},
	onLiveTurnStarted = () => {}
} = {}) {
	let channelStates = {};
	let liveTurnCounts = {};
	let lastChannelId = null;

	function getChannelState(channelId) {
		if (!channelId) return null;
		const key = normalizeChannelId(channelId);
		if (!channelStates[key]) channelStates[key] = {initialized: false, boundaryMessageId: null};
		return channelStates[key];
	}

	function noteLiveTurnStarted(channelId) {
		const key = normalizeChannelId(channelId);
		if (!key) return 0;
		liveTurnCounts[key] = (liveTurnCounts[key] || 0) + 1;
		onLiveTurnStarted(channelId, liveTurnCounts[key]);
		return liveTurnCounts[key];
	}

	function reset(channelId = null) {
		if (channelId) {
			delete channelStates[normalizeChannelId(channelId)];
			delete liveTurnCounts[normalizeChannelId(channelId)];
			resetLoadedMessageTracking(channelId);
		}
		else {
			channelStates = {};
			liveTurnCounts = {};
			resetLoadedMessageTracking();
		}
		clearEligibleReplyPreviewMessages(channelId);
		if (!channelId || normalizeChannelId(lastChannelId) === normalizeChannelId(channelId)) lastChannelId = null;
	}

	function prepare(channelId) {
		if (!channelId || normalizeChannelId(lastChannelId) === normalizeChannelId(channelId)) return;
		const previousChannelId = lastChannelId;
		if (previousChannelId) {
			clearChannelTranslationQueue(previousChannelId);
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

	return Object.freeze({
		getChannelState,
		getStartedLiveTurnCount: channelId => liveTurnCounts[normalizeChannelId(channelId)] || 0,
		noteLiveTurnStarted,
		reset,
		prepare,
		getLastChannelId: () => lastChannelId
	});
}

module.exports = {createLiveChannelSession};
