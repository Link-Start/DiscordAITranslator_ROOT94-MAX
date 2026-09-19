const FILTER_DEDUP_MS = 2000;

function digest16(value) {
	const text = String(value == null ? "" : value);
	let left = 0x811c9dc5, right = 0x9e3779b9;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		left ^= code; left = Math.imul(left, 0x01000193);
		right ^= code + index; right = Math.imul(right, 0x85ebca6b);
	}
	return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function createHistoryAutoTerminalObserver({
	getEligibility = () => ({eligible: false, reason: "invalid_entry"}),
	begin = () => null,
	update = () => false,
	terminal = () => false,
	now = Date.now,
	filterDedupMs = FILTER_DEDUP_MS
} = {}) {
	const activeByKey = new Map(), keyByRoute = new Map(), recentFiltered = new Map();
	const timestamp = () => {try {const value = Number(now()); return Number.isFinite(value) ? Math.max(0, value) : 0;} catch {return 0;}};
	const channelIdOf = (message, channel) => String(channel && channel.id || message && (message.channel_id || message.channelId) || "");
	const sourceTextOf = (message, source) => JSON.stringify({content: source && source.content != null ? String(source.content) : String(message && message.content || ""), embeds: Array.isArray(source && source.embeds) ? source.embeds.map(embed => ({title: String(embed && embed.title || ""), description: String(embed && embed.description || ""), fields: Array.isArray(embed && embed.fields) ? embed.fields.map(field => ({name: String(field && field.name || ""), value: String(field && field.value || "")})) : [], footer: String(embed && (embed.footerText || embed.footer && embed.footer.text) || "")})) : []});
	function identities(message, channel, source) {const channelId = channelIdOf(message, channel), messageId = String(message && message.id || ""), sourceText = sourceTextOf(message, source); return {key: `${channelId}:${messageId}:${digest16(sourceText)}`, messageIdentity: `mi1:${digest16(`${channelId}:${messageId}`)}`, sourceIdentity: `si1:${digest16(sourceText)}`};}
	function observe(message, channel, source, options = {}) {
		const identity = identities(message, channel, source), eligibility = options.eligibility || getEligibility(message, channel, source, options.ignoreQueued === true) || {eligible: false, reason: "invalid_entry"}, reason = String(eligibility.reason || (eligibility.eligible ? "eligible" : "filtered")).toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 48) || "filtered", entry = String(options.origin || "historical-load").toLowerCase().replace(/[^a-z0-9_.:-]/g, "-").slice(0, 48) || "historical-load";
		if (eligibility.eligible) {
			const existing = activeByKey.get(identity.key);
			if (existing) return Object.freeze({eligible: true, reason, routeId: existing, messageIdentity: identity.messageIdentity, sourceIdentity: identity.sourceIdentity});
			const routeId = begin({lane: "history-primary", entry, eligibility: "eligible", shape: source && Array.isArray(source.embeds) && source.embeds.length ? "embed-forward" : "text", promptFamily: "batch-json", validatorFamily: "history-batch", requestFamily: "batch-json", messageIdentity: identity.messageIdentity, sourceIdentity: identity.sourceIdentity, historyCheckpoint: {stage: "eligibility", reason}});
			if (routeId) {activeByKey.set(identity.key, routeId); keyByRoute.set(String(routeId), identity.key);}
			return Object.freeze({eligible: true, reason, routeId: routeId || null, messageIdentity: identity.messageIdentity, sourceIdentity: identity.sourceIdentity});
		}
		const dedupKey = `${identity.key}:${reason}`, previous = recentFiltered.get(dedupKey), current = timestamp();
		if (previous != null && current - previous < Math.max(0, Number(filterDedupMs) || 0)) return Object.freeze({eligible: false, reason, routeId: null, messageIdentity: identity.messageIdentity, sourceIdentity: identity.sourceIdentity, deduplicated: true});
		recentFiltered.set(dedupKey, current); while (recentFiltered.size > 256) recentFiltered.delete(recentFiltered.keys().next().value);
		const routeId = begin({lane: "history-primary", entry, eligibility: "filtered", sourceFilterReason: reason, shape: source && Array.isArray(source.embeds) && source.embeds.length ? "embed-forward" : "text", promptFamily: "none", validatorFamily: "received-filter", requestFamily: "none", messageIdentity: identity.messageIdentity, sourceIdentity: identity.sourceIdentity, historyCheckpoint: {stage: "eligibility", reason}});
		if (routeId) terminal(routeId, {outcome: "skipped", stage: "precheck", reason, displayCommit: "not-entered"});
		return Object.freeze({eligible: false, reason, routeId: null, messageIdentity: identity.messageIdentity, sourceIdentity: identity.sourceIdentity});
	}
	function checkpoint(routeId, stage, reason, fields = {}) {return routeId ? update(routeId, Object.assign({}, fields, {historyCheckpoint: {stage, reason}})) : false;}
	function release(routeId) {const id = String(routeId || ""), key = keyByRoute.get(id); if (!key) return false; keyByRoute.delete(id); if (activeByKey.get(key) === routeId) activeByKey.delete(key); return true;}
	function stop() {activeByKey.clear(); keyByRoute.clear(); recentFiltered.clear();}
	return Object.freeze({observe, checkpoint, release, stop, getResourceSnapshot: () => Object.freeze({active: activeByKey.size, indexedRoutes: keyByRoute.size, filteredDedup: recentFiltered.size})});
}

module.exports = {FILTER_DEDUP_MS, digest16, createHistoryAutoTerminalObserver};
