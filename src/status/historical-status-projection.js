// A read-only projection of the existing job queue and display tracker. No job or
// request lifecycle lives here: a late callback simply rereads the current owners.
function projectHistoricalStatus({channelId, jobs = [], display = {}, automaticPendingIds = [], retryable = 0, retryableIds = null, includeEmpty = false} = {}) {
	const currentJobs = jobs.filter(job => job && job.state !== "cancelled");
	const pendingDisplay = new Set(display.pendingIds || []);
	const failedDisplay = new Set(display.failedIds || []);
	if (!includeEmpty && !currentJobs.length && !pendingDisplay.size && !failedDisplay.size && !automaticPendingIds.length && !retryable && !(retryableIds && retryableIds.length)) return null;
	// The loaded capsule describes the whole channel, including bodies owned by
	// the live queue. Reading the existing display owner includes in-flight requests
	// after they have left the waiting queue, without another task tracker or timer.
	const automaticPending = new Set(automaticPendingIds.map(String));
	const pending = new Set([...(display.blockedTranslationIds || []), ...automaticPending]), all = new Set(automaticPending), skipped = new Set(), failed = new Set();
	const resolved = new Set();
	const working = currentJobs.filter(job => job.state !== "committed");
	for (const job of working) for (const [id, record] of job.items) {
		if (!record || record.status === "cancelled") continue;
		all.add(String(id));
		if (record.status === "skipped") {skipped.add(String(id)); resolved.add(String(id));}
		else if (record.status === "failed") failed.add(String(id));
		else if (record.status !== "translated" || !(job.progressCommitAcks && job.progressCommitAcks.has(String(id)))) pending.add(String(id));
		else resolved.add(String(id));
	}
	if (retryableIds) {
		const retryIds = new Set([...retryableIds.map(String), ...failed]);
		for (const id of resolved) retryIds.delete(id);
		for (const id of retryIds) pending.add(id);
		retryable = retryIds.size;
	}
	const states = new Set(working.map(job => job.state));
	const phase = states.has("repairing") ? "repairing" : states.has("translating") || automaticPending.size ? "requesting"
		: states.has("ready") ? "committing" : working.some(job => !job.sealed) ? "collecting"
		: working.length ? "queued" : pendingDisplay.size ? "displaying" : failedDisplay.size || retryable ? "failed" : "done";
	return {
		channelId, jobId: currentJobs.at(-1)?.id || null, aggregate: true,
		active: working.length > 0 || pendingDisplay.size > 0 || automaticPending.size > 0,
		collecting: phase === "collecting", done: phase === "done", phase,
		total: all.size, processed: Math.max(0, all.size - pending.size), displayed: 0,
		skipped: skipped.size, failed: failed.size, retryable, retryableCounted: !!retryableIds,
		displayPending: pendingDisplay.size, displayFailed: failedDisplay.size,
		pendingMessageIds: [...pending]
	};
}

module.exports = {projectHistoricalStatus};
