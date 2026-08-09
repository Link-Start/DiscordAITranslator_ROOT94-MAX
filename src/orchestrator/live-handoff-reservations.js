function normalizeIdentity(value) {
	return value == null ? "" : String(value);
}

function createLiveHandoffReservations() {
	let sequence = 0;
	const reservations = new Map();

	function reserve(channelId, ticket) {
		const channelKey = normalizeIdentity(channelId);
		const ticketKey = normalizeIdentity(ticket);
		if (!channelKey || !ticketKey) return null;
		const existing = reservations.get(channelKey);
		if (existing && existing.ticket === ticketKey) return ticketKey;
		reservations.set(channelKey, {ticket: ticketKey, order: ++sequence});
		return ticketKey;
	}

	function clear(channelId = null, ticket = null) {
		if (channelId == null) {
			reservations.clear();
			return true;
		}
		const channelKey = normalizeIdentity(channelId);
		const existing = reservations.get(channelKey);
		if (!existing) return false;
		if (ticket != null && existing.ticket !== normalizeIdentity(ticket)) return false;
		reservations.delete(channelKey);
		return true;
	}

	function consume(channelId, ticket) {
		const channelKey = normalizeIdentity(channelId);
		const existing = reservations.get(channelKey);
		if (!existing || existing.ticket !== normalizeIdentity(ticket)) return false;
		reservations.delete(channelKey);
		return true;
	}

	function findNextQueueIndex(queue, getIdentity) {
		let selectedIndex = -1;
		let selectedOrder = Infinity;
		for (let index = 0; index < queue.length; index++) {
			const identity = getIdentity(queue[index]);
			const existing = identity && reservations.get(normalizeIdentity(identity.channelId));
			if (!existing || existing.ticket !== normalizeIdentity(identity.ticket) || existing.order >= selectedOrder) continue;
			selectedIndex = index;
			selectedOrder = existing.order;
		}
		return selectedIndex;
	}

	return Object.freeze({reserve, clear, consume, findNextQueueIndex});
}

module.exports = {createLiveHandoffReservations};
