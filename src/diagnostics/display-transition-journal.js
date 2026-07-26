const DISPLAY_JOURNAL_MARKER = "TRANSLATOR_DISPLAY_DEBUG_JOURNAL";

function createDisplayTransitionJournal({enabled = false, limit = 500, now = Date.now} = {}) {
	const entries = [];
	return Object.freeze({
		append(entry) {
			if (!enabled) return;
			entries.push(Object.freeze({...entry, timestamp: entry.timestamp || now()}));
			if (entries.length > limit) entries.splice(0, entries.length - limit);
		},
		list({channelId, messageId} = {}) {
			return entries.filter(entry => (!channelId || entry.channelId === channelId) && (!messageId || entry.messageId === messageId));
		},
		clear() {
			entries.length = 0;
		},
		marker: DISPLAY_JOURNAL_MARKER
	});
}

module.exports = {DISPLAY_JOURNAL_MARKER, createDisplayTransitionJournal};
