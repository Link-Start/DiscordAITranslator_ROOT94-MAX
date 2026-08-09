function scheduleMicrotask(callback) {
	if (typeof queueMicrotask == "function") queueMicrotask(callback);
	else Promise.resolve().then(callback);
}

function resumeHistoricalHandoff(plugin, channelId = null, handoffTicket = null, {retired = false} = {}) {
	const resume = () => {
		const entries = channelId ? [plugin.getHistoricalTranslationJobQueue(channelId, false)].filter(Boolean) : plugin.ensureHistoricalJobRegistry().listQueues();
		for (const entry of entries) {
			const hasSealedJob = entry && entry.jobs.some(job => job && job.state == "collecting" && job.sealed);
			const ticketMatches = entry && (retired ? entry.pendingLiveHandoffTicket != null && handoffTicket != null && String(handoffTicket) == String(entry.pendingLiveHandoffTicket) : entry.pendingLiveHandoffTicket == null || handoffTicket != null && String(handoffTicket) == String(entry.pendingLiveHandoffTicket));
			if (!entry || entry.runningPromise || !hasSealedJob || !ticketMatches) continue;
			entry.pendingLiveHandoffTicket = null;
			if (retired) {
				const liveQueue = plugin.ensureLiveTranslationQueue();
				const replacementTicket = liveQueue.reserveQueuedLiveRequest(entry.channelId);
				if (replacementTicket) {
					entry.pendingLiveHandoffTicket = replacementTicket;
					liveQueue.processQueue();
					continue;
				}
			}
			plugin.startCollectedHistoricalTranslationJobs(entry.channelId, {sealCurrent: false});
		}
	};
	if (retired) return scheduleMicrotask(resume);
	return resume();
}

module.exports = {resumeHistoricalHandoff};
