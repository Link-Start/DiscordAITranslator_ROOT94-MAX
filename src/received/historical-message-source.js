function createHistoricalMessageSource({
	listCachedMessages = async () => [],
	prefetchMessages = async () => [],
	isEligible = () => true,
	toQueueItem = message => message,
	isGenerationCurrent = () => true,
	observer = null
} = {}) {
	function observe(stage, phase, metrics = {}) {
		if (!observer || typeof observer.onStage != "function") return;
		try {observer.onStage(Object.freeze({stage, phase, count: Math.max(0, Number(metrics.count) || 0), prefetchedCount: Math.max(0, Number(metrics.prefetchedCount) || 0)}));}
		catch (error) {}
	}
	function isAborted(signal) {
		return !!(signal && signal.aborted);
	}

	function isCurrent(channelId, generation) {
		return isGenerationCurrent(channelId, generation);
	}

	function sortNewestFirst(messages) {
		return messages.slice().sort((left, right) => compareMessageIds(right && right.id, left && left.id));
	}

	function compareMessageIds(leftId, rightId) {
		const left = normalizeComparableId(leftId);
		const right = normalizeComparableId(rightId);
		if (left.kind == right.kind && left.kind == "bigint") {
			if (left.value > right.value) return 1;
			if (left.value < right.value) return -1;
			return 0;
		}
		if (left.kind == right.kind) {
			if (left.value > right.value) return 1;
			if (left.value < right.value) return -1;
			return 0;
		}
		return String(leftId || "").localeCompare(String(rightId || ""));
	}

	function normalizeComparableId(messageId) {
		const value = String(messageId || "").trim();
		if (/^\d+$/.test(value)) return {kind: "bigint", value: BigInt(value)};
		return {kind: "string", value};
	}

	function uniqueMessages(messages) {
		const seen = new Set();
		const unique = [];
		for (const message of messages || []) {
			const messageId = message && message.id != null ? String(message.id) : "";
			if (!messageId || seen.has(messageId)) continue;
			seen.add(messageId);
			unique.push(message);
		}
		return unique;
	}

	function isChannelMessage(message, channelId) {
		if (!message || !channelId) return false;
		return String(message.channel_id != null ? message.channel_id : message.channelId || "") == String(channelId);
	}

	function collectEligible(messages, limit) {
		const items = [];
		for (const message of messages) {
			if (!isEligible(message)) continue;
			items.push(message);
			if (items.length >= limit) break;
		}
		return items;
	}

	function buildResult(messages, prefetched) {
		const items = messages.map(message => toQueueItem(message));
		return {items, total: items.length, prefetched, cancelled: false};
	}

	async function build({channelId, generation, renderedMessages = [], limit = 0, signal = null} = {}) {
		const boundedLimit = Math.max(0, parseInt(limit, 10) || 0);
		if (!channelId || !boundedLimit) return {items: [], total: 0, prefetched: 0, cancelled: false};
		if (isAborted(signal) || !isCurrent(channelId, generation)) return {items: [], total: 0, prefetched: 0, cancelled: true};

		observe("source_load", "start");
		const cachedMessages = await listCachedMessages(channelId) || [];
		observe("source_load", "settle", {count: cachedMessages.length});
		if (isAborted(signal) || !isCurrent(channelId, generation)) return {items: [], total: 0, prefetched: 0, cancelled: true};

		let combinedMessages = sortNewestFirst(uniqueMessages([].concat(renderedMessages || [], cachedMessages || []).filter(message => isChannelMessage(message, channelId))));
		let eligibleMessages = collectEligible(combinedMessages, boundedLimit);
		let prefetchedCount = 0;
		observe("scan_prefetch", "scan", {count: eligibleMessages.length});

		if (eligibleMessages.length < boundedLimit) {
			const missing = boundedLimit - eligibleMessages.length;
			const oldestKnownMessage = combinedMessages[combinedMessages.length - 1] || null;
			try {
				if (isAborted(signal) || !isCurrent(channelId, generation)) return {items: [], total: 0, prefetched: 0, cancelled: true};
				observe("scan_prefetch", "prefetch_start", {count: missing});
				const prefetchedMessages = await prefetchMessages({
					channelId,
					beforeMessageId: oldestKnownMessage && oldestKnownMessage.id != null ? String(oldestKnownMessage.id) : null,
					limit: missing,
					signal
				}) || [];
				if (isAborted(signal) || !isCurrent(channelId, generation)) return {items: [], total: 0, prefetched: 0, cancelled: true};
				combinedMessages = sortNewestFirst(uniqueMessages(combinedMessages.concat(prefetchedMessages.filter(message => isChannelMessage(message, channelId)))));
				const prefetchedEligibleMessages = collectEligible(combinedMessages, boundedLimit);
				prefetchedCount = Math.max(0, prefetchedEligibleMessages.length - eligibleMessages.length);
				eligibleMessages = prefetchedEligibleMessages;
				observe("scan_prefetch", "prefetch_settle", {count: prefetchedMessages.length, prefetchedCount});
			}
			catch (error) {observe("scan_prefetch", "prefetch_settle");}
		}

		if (isAborted(signal) || !isCurrent(channelId, generation)) return {items: [], total: 0, prefetched: 0, cancelled: true};
		observe("scan_prefetch", "settle", {count: eligibleMessages.length, prefetchedCount});
		return buildResult(eligibleMessages, prefetchedCount);
	}

	return Object.freeze({build});
}

module.exports = {createHistoricalMessageSource};
