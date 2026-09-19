function createDeferredFieldWriter({write, delay = 350, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
	if (typeof write != "function") throw new TypeError("write callback required");
	const pending = new Map();

	function flush(key) {
		const entry = pending.get(key);
		if (!entry) return false;
		pending.delete(key);
		if (entry.timer) clearTimer(entry.timer);
		write(entry.key, entry.value);
		return true;
	}

	function schedule(key, value) {
		if (!key) return false;
		const previous = pending.get(key);
		if (previous && previous.timer) clearTimer(previous.timer);
		const entry = {key, value, timer: null};
		entry.timer = setTimer(() => flush(key), delay);
		pending.set(key, entry);
		return true;
	}

	function flushAll() {
		let count = 0;
		for (const key of [...pending.keys()]) if (flush(key)) count++;
		return count;
	}

	function cancelAll() {
		for (const entry of pending.values()) if (entry.timer) clearTimer(entry.timer);
		const count = pending.size;
		pending.clear();
		return count;
	}

	return Object.freeze({schedule, flush, flushAll, cancelAll, pendingCount: () => pending.size});
}

module.exports = {createDeferredFieldWriter};
