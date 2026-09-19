// F1a deliberately fixes live provider capacity at one. The owner knows only
// identity and count; queue policy and lifecycle decisions stay with its caller.
const LIVE_SLOT_CAPACITY = 1;

function createLiveSlotLeaseOwner({onActiveCountChanged = null, capacity: initialCapacity = LIVE_SLOT_CAPACITY} = {}) {
	const activeLeases = new Set();
	let capacity = Math.max(1, Math.min(2, Math.floor(Number(initialCapacity)) || LIVE_SLOT_CAPACITY));

	function notifyActiveCountChanged() {
		if (typeof onActiveCountChanged != "function") return;
		try {onActiveCountChanged(activeLeases.size);}
		catch (error) {}
	}

	function tryAcquire() {
		if (activeLeases.size >= capacity) return null;
		const lease = Object.freeze({});
		activeLeases.add(lease);
		notifyActiveCountChanged();
		return lease;
	}

	function release(lease) {
		if (!activeLeases.delete(lease)) return false;
		notifyActiveCountChanged();
		return true;
	}

	function reset() {
		if (!activeLeases.size) return false;
		activeLeases.clear();
		notifyActiveCountChanged();
		return true;
	}

	return Object.freeze({
		tryAcquire,
		// Exact identity check used by a caller after the synchronous acquisition
		// notification returns. That notification may re-enter lifecycle cleanup and
		// invalidate the just-created token before tryAcquire returns to its caller.
		owns: lease => activeLeases.has(lease),
		release,
		reset,
		setCapacity(value) {
			capacity = Math.max(1, Math.min(2, Math.floor(Number(value)) || 1));
			return capacity;
		},
		getActiveCount: () => activeLeases.size,
		getCapacity: () => capacity
	});
}

module.exports = {
	LIVE_SLOT_CAPACITY,
	createLiveSlotLeaseOwner
};
