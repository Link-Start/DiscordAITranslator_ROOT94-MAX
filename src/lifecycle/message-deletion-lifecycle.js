function createMessageDeletionLifecycle({
	removeLiveMessage = () => false,
	getHistoricalQueue = () => null,
	getFailedSnapshot = () => null,
	setFailedSnapshot = () => {},
	deleteFailedSnapshot = () => {},
	clearHistoricalMarker = () => {},
	hasCachedTranslation = () => false,
	clearCachedTranslation = () => {},
	deleteDisplayMessage = () => false
} = {}) {
	function removeHistoricalMessage(messageId, channelId) {
		const entry = getHistoricalQueue(channelId);
		let removed = false;
		for (const job of entry && entry.jobs || []) {
			if (job.invalidateMessage(messageId, "source-deleted")) removed = true;
			clearHistoricalMarker(messageId, job.id);
		}
		const failedEntry = getFailedSnapshot(channelId);
		if (failedEntry && failedEntry.items) {
			const items = failedEntry.items.filter(item => !item || !item.message || String(item.message.id) !== messageId);
			if (items.length !== failedEntry.items.length) {
				removed = true;
				if (items.length) setFailedSnapshot(channelId, {...failedEntry, items});
				else deleteFailedSnapshot(channelId);
			}
		}
		return removed;
	}

	async function deleteMessage(messageId, channelId) {
		if (!messageId || !channelId) return false;
		messageId = String(messageId);
		channelId = String(channelId);
		const liveRemoved = removeLiveMessage(messageId, channelId);
		const historicalRemoved = removeHistoricalMessage(messageId, channelId);
		const cacheRemoved = hasCachedTranslation(messageId);
		clearCachedTranslation(messageId);
		const displayOutcome = await deleteDisplayMessage(messageId, channelId);
		return {messageId, channelId, removed: !!(liveRemoved || historicalRemoved || cacheRemoved || displayOutcome), displayOutcome};
	}

	function handleAction(action) {
		if (!action || action.type != "MESSAGE_DELETE" && action.type != "MESSAGE_DELETE_BULK") return Promise.resolve(false);
		const channelId = action.channelId || action.channel_id;
		const messageIds = action.type == "MESSAGE_DELETE_BULK" ? action.ids || action.messageIds || action.message_ids || [] : [action.id || action.messageId || action.message_id];
		const uniqueIds = [...new Set([].concat(messageIds || []).filter(Boolean).map(String))];
		return !channelId || !uniqueIds.length ? Promise.resolve(false) : Promise.all(uniqueIds.map(messageId => deleteMessage(messageId, channelId)));
	}

	return Object.freeze({deleteMessage, handleAction});
}

module.exports = {createMessageDeletionLifecycle};
