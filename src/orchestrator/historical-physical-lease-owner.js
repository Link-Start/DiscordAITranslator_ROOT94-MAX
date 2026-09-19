const HISTORICAL_PHYSICAL_CAPACITY_MIN = 1;
const HISTORICAL_PHYSICAL_CAPACITY_MAX = 4;

function assertCapacity(capacity) {
	if (!Number.isInteger(capacity)
		|| capacity < HISTORICAL_PHYSICAL_CAPACITY_MIN
		|| capacity > HISTORICAL_PHYSICAL_CAPACITY_MAX) {
		throw new RangeError("historical physical lease capacity must be an integer from 1 to 4");
	}
}

// One owner is shared by every historical job. It stores only opaque lease
// identities and currentness callbacks; message/provider data never enters its
// diagnostics snapshot.
function createHistoricalPhysicalLeaseOwner({capacity: initialCapacity = 1} = {}) {
	assertCapacity(initialCapacity);

	let capacity = initialCapacity;
	let generation = 0;
	let highWater = 0;
	let stopped = false;
	let pumping = false;
	const activeLeases = new Set();
	const waiters = [];
	const drainWaiters = [];
	// A stop snapshots the exact physical leases which were already in flight. A
	// later start may accept new waiters, but none of them may mix with that stopped
	// generation. This also lets drain() wait for the old physical work rather than
	// being extended by requests from the restarted generation.
	let restartBarrierLeases = new Set();

	function getSnapshot() {
		return Object.freeze({
			capacity,
			active: activeLeases.size,
			waiting: waiters.length,
			highWater,
			generation,
			stopped
		});
	}

	function resolveDrainWaiters() {
		for (let index = drainWaiters.length - 1; index >= 0; index--) {
			const waiter = drainWaiters[index];
			let pending = false;
			for (const lease of waiter.leases) if (activeLeases.has(lease)) {
				pending = true;
				break;
			}
			if (pending) continue;
			drainWaiters.splice(index, 1);
			waiter.resolve();
		}
	}

	function pump() {
		if (pumping) return;
		pumping = true;
		try {
			// start() can reopen admission before an old physical callback settles, but
			// the new generation remains behind this exact-token barrier until then.
			if (restartBarrierLeases.size) return;
			while (!stopped && activeLeases.size < capacity && waiters.length) {
				const waiter = waiters.shift();
				let isCurrent = false;
				try {isCurrent = waiter.isCurrent() === true;}
				catch (error) {}

				// The predicate may re-enter stop/reset. Recheck both lifecycle
				// generation and stopped state before creating a physical lease.
				if (!isCurrent || stopped || waiter.generation !== generation) {
					waiter.resolve(null);
					continue;
				}

				const lease = Object.freeze({});
				activeLeases.add(lease);
				highWater = Math.max(highWater, activeLeases.size);
				waiter.resolve(lease);
			}
		}
		finally {
			pumping = false;
		}
	}

	function acquire({isCurrent} = {}) {
		if (typeof isCurrent != "function") {
			throw new TypeError("historical physical lease acquire requires isCurrent");
		}
		if (stopped) return Promise.resolve(null);

		return new Promise(resolve => {
			waiters.push({generation, isCurrent, resolve});
			pump();
		});
	}

	// The local chunk pump can invalidate a logically launched sibling while that
	// sibling is still waiting behind unrelated physical work. Capacity may already
	// have dropped to one, so waiting for a future grant to discover staleness would
	// deadlock the terminal job. This explicit sweep cancels stale waiters without
	// granting or reordering any waiter which remains current.
	function pruneStaleWaiters() {
		if (!waiters.length) return 0;
		const pending = waiters.splice(0);
		const retained = [];
		let pruned = 0;
		for (const waiter of pending) {
			let isCurrent = false;
			try {isCurrent = waiter.isCurrent() === true;}
			catch (error) {}
			if (!isCurrent || stopped || waiter.generation !== generation) {
				pruned++;
				waiter.resolve(null);
			}
			else retained.push(waiter);
		}
		// A later predicate may have re-entered stop() after an earlier waiter was
		// retained. Revalidate its lifecycle generation without calling the predicate
		// twice. Re-entrant acquires append to waiters while the snapshot is checked;
		// retained older FIFO entries stay in front of those new arrivals.
		const finalRetained = [];
		for (const waiter of retained) {
			if (stopped || waiter.generation !== generation) {
				pruned++;
				waiter.resolve(null);
			}
			else finalRetained.push(waiter);
		}
		if (finalRetained.length) waiters.unshift(...finalRetained);
		return pruned;
	}

	function owns(lease) {
		return activeLeases.has(lease);
	}

	// A dynamically reduced capacity does not revoke an already-physical request,
	// but a granted lease which has not crossed the provider boundary must yield if
	// it now sits outside the capacity. Set iteration is acquisition order, so the
	// oldest physical turn keeps the surviving slot.
	function isDispatchable(lease) {
		if (stopped || restartBarrierLeases.size || !activeLeases.has(lease)) return false;
		let position = 0;
		for (const activeLease of activeLeases) {
			position++;
			if (activeLease === lease) return position <= capacity;
		}
		return false;
	}

	function release(lease) {
		if (!activeLeases.delete(lease)) return false;
		restartBarrierLeases.delete(lease);
		// Resolve generation-bound drains before pump can grant a restarted waiter.
		resolveDrainWaiters();
		pump();
		return true;
	}

	function setCapacity(nextCapacity) {
		assertCapacity(nextCapacity);
		if (nextCapacity === capacity) return false;
		capacity = nextCapacity;
		pump();
		return true;
	}

	function start(nextCapacity = capacity) {
		assertCapacity(nextCapacity);
		const changed = stopped || capacity !== nextCapacity;
		capacity = nextCapacity;
		if (stopped) {
			stopped = false;
			generation++;
		}
		pump();
		return changed;
	}

	// stop is synchronous: queued/future callers are rejected immediately, but
	// physical requests already in flight retain their exact leases until release.
	function stop() {
		if (stopped) return false;
		stopped = true;
		generation++;
		restartBarrierLeases = new Set(activeLeases);
		while (waiters.length) waiters.shift().resolve(null);
		resolveDrainWaiters();
		return true;
	}

	function drain() {
		const leases = new Set(activeLeases);
		if (!leases.size) return Promise.resolve();
		return new Promise(resolve => drainWaiters.push({leases, resolve}));
	}

	// reset is a terminal lifecycle operation for this owner: stop first, then
	// expose a promise that settles only after every in-flight request releases.
	function reset() {
		stop();
		return drain();
	}

	return Object.freeze({
		acquire,
		pruneStaleWaiters,
		owns,
		isDispatchable,
		release,
		setCapacity,
		start,
		stop,
		drain,
		reset,
		getSnapshot,
		getCapacity: () => capacity
	});
}

module.exports = {
	HISTORICAL_PHYSICAL_CAPACITY_MIN,
	HISTORICAL_PHYSICAL_CAPACITY_MAX,
	createHistoricalPhysicalLeaseOwner
};
