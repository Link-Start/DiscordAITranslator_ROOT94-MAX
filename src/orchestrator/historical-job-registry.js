// Owns the bookkeeping around historical (loaded-message) translation jobs: the
// per-channel job queues, the id sequence, the runtime generation, and the ledger
// of items that failed and may be retried.
//
// It deliberately does not know what a job DOES. Job execution, provider calls and
// display commits stay with their owners; this module answers "which jobs exist for
// this channel", "is this job still the current one", and "what failed here".
//
// Failed snapshots contain cloned messages (including embeds and attachments), so
// retaining one unbounded ledger per channel makes a long multi-channel session retain
// substantially more than the retry UI can use. Reads and writes refresh recency; the
// oldest untouched channel is retired first.
const MAX_FAILED_SNAPSHOT_CHANNELS = 32;
const MAX_FAILED_SNAPSHOT_ITEMS_PER_CHANNEL = 200;

function normalizeLimit(value, fallback) {
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createHistoricalJobRegistry({
	maxFailedSnapshotChannels = MAX_FAILED_SNAPSHOT_CHANNELS,
	maxFailedSnapshotItemsPerChannel = MAX_FAILED_SNAPSHOT_ITEMS_PER_CHANNEL
} = {}) {
	const queues = new Map();
	const failedSnapshots = new Map();
	const failedChannelLimit = normalizeLimit(maxFailedSnapshotChannels, MAX_FAILED_SNAPSHOT_CHANNELS);
	const failedItemLimit = normalizeLimit(maxFailedSnapshotItemsPerChannel, MAX_FAILED_SNAPSHOT_ITEMS_PER_CHANNEL);
	let jobSequence = 0;
	let runtimeGeneration = 0;

	function normalizeChannelId(channelId) {
		return channelId == null ? "" : String(channelId);
	}

	function touchFailedSnapshot(key) {
		const snapshot = failedSnapshots.get(key);
		if (!snapshot) return null;
		failedSnapshots.delete(key);
		failedSnapshots.set(key, snapshot);
		return snapshot;
	}

	function boundFailedSnapshot(snapshot) {
		if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length <= failedItemLimit) return snapshot;
		return {...snapshot, items: snapshot.items.slice(-failedItemLimit)};
	}

	function pruneFailedSnapshotChannels() {
		while (failedSnapshots.size > failedChannelLimit) failedSnapshots.delete(failedSnapshots.keys().next().value);
	}

	return Object.freeze({
		// A queue entry is created on demand so callers can ask about a channel that
		// has never had a job without allocating one.
		getQueue(channelId, createWhenMissing = true) {
			const key = normalizeChannelId(channelId);
			if (!key) return null;
			let entry = queues.get(key);
			if (!entry && createWhenMissing) {
				entry = {channelId: key, generation: 0, jobs: [], runningPromise: null, startToken: null, intakeBlocked: false, pendingLiveHandoffTicket: null};
				queues.set(key, entry);
			}
			return entry || null;
		},
		hasQueue(channelId) {
			return queues.has(normalizeChannelId(channelId));
		},
		isCurrentQueue(channelId, entry) {
			return !!entry && queues.get(normalizeChannelId(channelId)) === entry;
		},
		deleteQueue(channelId) {
			return queues.delete(normalizeChannelId(channelId));
		},
		clearQueues() {
			queues.clear();
		},
		listQueues() {
			return [...queues.values()];
		},
		nextJobId(channelId) {
			return `${normalizeChannelId(channelId)}:${++jobSequence}`;
		},
		// Bumping the generation is how a plugin stop or a bulk cancel makes every
		// in-flight job stale without having to reach into each one.
		advanceRuntimeGeneration() {
			return ++runtimeGeneration;
		},
		getRuntimeGeneration() {
			return runtimeGeneration;
		},
		getFailedSnapshot(channelId) {
			const key = normalizeChannelId(channelId);
			return key ? touchFailedSnapshot(key) : null;
		},
		hasFailedMessage(channelId, messageId, signature = null) {
			const entry = touchFailedSnapshot(normalizeChannelId(channelId));
			const id = normalizeChannelId(messageId);
			if (!entry || !id || !Array.isArray(entry.items)) return false;
			const item = entry.items.find(candidate => candidate && candidate.message && normalizeChannelId(candidate.message.id) === id);
			if (!item) return false;
			return !item.signature || signature == null || String(item.signature) === String(signature);
		},
		setFailedSnapshot(channelId, snapshot) {
			const key = normalizeChannelId(channelId);
			if (!key) return null;
			const boundedSnapshot = boundFailedSnapshot(snapshot);
			// Map#set does not refresh insertion order for an existing key. Delete first so
			// repeated failures in the active channel remain the most-recently-used entry.
			failedSnapshots.delete(key);
			failedSnapshots.set(key, boundedSnapshot);
			pruneFailedSnapshotChannels();
			return boundedSnapshot;
		},
		deleteFailedSnapshot(channelId) {
			return failedSnapshots.delete(normalizeChannelId(channelId));
		},
		clearFailedSnapshots() {
			failedSnapshots.clear();
		}
	});
}

module.exports = {
	MAX_FAILED_SNAPSHOT_CHANNELS,
	MAX_FAILED_SNAPSHOT_ITEMS_PER_CHANNEL,
	createHistoricalJobRegistry
};
