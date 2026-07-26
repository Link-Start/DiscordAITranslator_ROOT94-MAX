// Owns every piece of state behind "what did the user actually type before we
// translated it, and who is allowed to act on that". Before this module the same six
// vars lived in the plugin factory closure - the in-flight automatic sent requests
// with their sequence and generation counters, the two original-text ledgers that must
// survive a send round trip, and the manual request table - where any of the 8000
// surrounding lines could write them. Here the only way to change them is this API.
//
// A store instance is per plugin instance, so a plugin restart drops all of it.

// An unmatched pending send has to expire. Echo matching keys on exact submitted text,
// so a stale entry would let a later identical message adopt an original the user never
// typed for it. Two minutes is far longer than the send round trip.
const SENT_ORIGINAL_MATCH_TTL = 2 * 60 * 1000;
// Both original-text ledgers are bounded. Only recent sends are ever read (echo
// matching, then edit prefill), so an unbounded ledger would grow for a whole session
// to serve entries nothing will ask for.
const MAX_SENT_ORIGINAL_ENTRIES = 200;

function createSentTranslationStore({
	now = Date.now,
	// The plugin can be stopped while a translation call is still in flight; a request
	// created before the stop must not be able to commit its result afterwards.
	isRuntimeActive = () => true,
	isTranslationEnabled = () => true,
	isOwnMessage = () => false
} = {}) {
	let requests = {};
	let requestSequence = 0;
	let generation = 0;
	let pendingOriginals = [];
	let originalsByMessageId = {};
	let manualRequests = {};

	// Only the pending list expires. A remembered message keeps its original for as long
	// as it stays inside the cap, because the edit prefill that reads it can happen
	// arbitrarily long after the send.
	function pruneExpiredPendingOriginals() {
		const cutoff = now() - SENT_ORIGINAL_MATCH_TTL;
		pendingOriginals = pendingOriginals.filter(entry => entry && entry.createdAt >= cutoff);
	}

	function isCurrentRequest(request) {
		return !!(
			request &&
			!request.completed &&
			isRuntimeActive() &&
			request.generation == generation &&
			requests[request.id] === request &&
			isTranslationEnabled(request.channelId)
		);
	}

	function finishRequest(request) {
		if (!request || request.completed) return false;
		request.completed = true;
		if (requests[request.id] === request) delete requests[request.id];
		return true;
	}

	function appendPendingOriginal(channelId, originalText, submittedText) {
		originalText = String(originalText || "");
		submittedText = String(submittedText || "");
		// Nothing was substituted, so there is no original worth restoring later.
		if (!channelId || !originalText || !submittedText || originalText == submittedText) return false;
		pruneExpiredPendingOriginals();
		pendingOriginals.push({channelId, originalText, submittedText, createdAt: now()});
		if (pendingOriginals.length > MAX_SENT_ORIGINAL_ENTRIES) pendingOriginals.splice(0, pendingOriginals.length - MAX_SENT_ORIGINAL_ENTRIES);
		return true;
	}

	function rememberOriginalForMessage(messageId, channelId, originalText, submittedText) {
		if (!messageId) return false;
		originalText = String(originalText || "");
		submittedText = String(submittedText || "");
		// An edit that no longer substitutes anything must drop the stale record, or the
		// next edit prefill would resurrect a superseded original.
		if (!originalText || !submittedText || originalText == submittedText) {
			delete originalsByMessageId[messageId];
			return false;
		}
		pruneExpiredPendingOriginals();
		originalsByMessageId[messageId] = {channelId, originalText, submittedText, capturedAt: now()};
		const messageIds = Object.keys(originalsByMessageId);
		if (messageIds.length > MAX_SENT_ORIGINAL_ENTRIES) messageIds
			.sort((left, right) => originalsByMessageId[left].capturedAt - originalsByMessageId[right].capturedAt)
			.slice(0, messageIds.length - MAX_SENT_ORIGINAL_ENTRIES)
			.forEach(id => delete originalsByMessageId[id]);
		return true;
	}

	return Object.freeze({
		// A request is the receipt for one send or edit that may be rewritten before it
		// reaches Discord. It carries the generation it was born in so a late callback
		// can be told apart from a live one.
		createRequest(channelId, originalText, messageId = null) {
			if (!channelId) return null;
			const request = {
				id: ++requestSequence,
				generation,
				channelId,
				messageId: messageId ? String(messageId) : null,
				originalText: String(originalText || ""),
				completed: false
			};
			requests[request.id] = request;
			return request;
		},
		isRequestCurrent(request) {
			return isCurrentRequest(request);
		},
		// Always submits something: a superseded request falls back to the untranslated
		// text rather than dropping the user's message on the floor. Only a still-current
		// request is allowed to record an original, because only then was one substituted.
		completeRequest(request, translatedText, submit) {
			if (!request || request.completed || typeof submit != "function") return Promise.resolve(false);
			const current = isCurrentRequest(request);
			const nextText = current ? translatedText : request.originalText;
			finishRequest(request);
			return Promise.resolve(submit(nextText)).then(_ => {
				if (current) {
					// An edit knows its message id immediately; a fresh send does not, so it
					// waits for Discord to echo the message back.
					if (request.messageId) rememberOriginalForMessage(request.messageId, request.channelId, request.originalText, nextText);
					else appendPendingOriginal(request.channelId, request.originalText, nextText);
				}
				return true;
			});
		},
		// Without a channel this is a runtime-wide invalidation, so the generation moves
		// and every request ever issued becomes stale. A channel-scoped call only drops
		// that channel's requests; requests elsewhere stay live.
		invalidateRequests(channelId = null) {
			if (!channelId) generation++;
			for (const requestId of Object.keys(requests)) {
				const request = requests[requestId];
				if (channelId && request.channelId != channelId) continue;
				delete requests[requestId];
			}
		},
		trackPendingOriginal(channelId, originalText, submittedText) {
			return appendPendingOriginal(channelId, originalText, submittedText);
		},
		// Discord echoes our own sent message back; matching it against a pending entry is
		// what promotes an anonymous send into a message id we can prefill on edit.
		captureEcho(message, channelId = null) {
			if (!message || !message.id || !isOwnMessage(message)) return false;
			channelId = channelId || message.channel_id || null;
			const submittedText = String(message.content || "");
			if (!channelId || !submittedText) return false;
			pruneExpiredPendingOriginals();
			const pendingIndex = pendingOriginals.findIndex(entry => entry.channelId == channelId && entry.submittedText == submittedText);
			if (pendingIndex < 0) return false;
			const pending = pendingOriginals.splice(pendingIndex, 1)[0];
			return rememberOriginalForMessage(String(message.id), channelId, pending.originalText, submittedText);
		},
		// Editing a translated message must show the user what they typed, not what we
		// sent. If the visible text no longer matches what we sent, someone else changed
		// the message and the record is worthless.
		getEditableText(messageId, currentText) {
			pruneExpiredPendingOriginals();
			const stored = messageId && originalsByMessageId[messageId];
			if (!stored) return currentText;
			if (String(currentText || "") != stored.submittedText) {
				delete originalsByMessageId[messageId];
				return currentText;
			}
			return stored.originalText;
		},
		// A restart must not let anything issued by the previous run commit. Remembered
		// originals deliberately survive, so an edit still prefills after a reload.
		resetForStart() {
			generation++;
			requests = {};
			pendingOriginals = [];
		},
		clearPendingOriginals() {
			pendingOriginals = [];
		},

		// Manual requests are keyed by channel and message rather than by an id, because
		// the guard they exist for is "this exact message is already being translated by
		// hand"; the same message in a popout and in the chat list is one request.
		createManualRequestKey(channelId, messageId) {
			return `${channelId || "__global"}:${String(messageId)}`;
		},
		hasManualRequest(key) {
			return !!manualRequests[key];
		},
		beginManualRequest(key) {
			const request = {};
			manualRequests[key] = request;
			return request;
		},
		// A second manual translation of the same message replaces the first; the first
		// must then discard its result instead of painting over the newer one.
		isManualRequestCurrent(key, request) {
			return manualRequests[key] === request;
		},
		releaseManualRequest(key, request) {
			if (!key || manualRequests[key] !== request) return false;
			delete manualRequests[key];
			return true;
		},
		clearManualRequests() {
			manualRequests = {};
		}
	});
}

module.exports = {SENT_ORIGINAL_MATCH_TTL, MAX_SENT_ORIGINAL_ENTRIES, createSentTranslationStore};
