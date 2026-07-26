// Owns every piece of channel-title translation state. Before this module the same
// four maps lived in the plugin factory closure where any of the 9000 surrounding
// lines could mutate them; here the only way to change them is through this API.
//
// A store instance is per plugin instance, so a plugin restart drops all of it.
const CHANNEL_TITLE_FAILURE_RETRY_MS = 30000;

function createChannelTitleStore({now = Date.now} = {}) {
	let translated = {};
	let pending = {};
	let failed = {};
	let requestSequence = 0;

	function normalizeChannelId(channelId) {
		return channelId == null ? "" : String(channelId);
	}

	return Object.freeze({
		// A translated title only counts while its signature still matches the current
		// configuration; a stale entry is dropped on read so it cannot resurface.
		getTranslatedTitle(channelId, signature) {
			const key = normalizeChannelId(channelId);
			const entry = translated[key];
			if (!entry) return null;
			if (entry.signature !== signature) {
				delete translated[key];
				return null;
			}
			return entry.text;
		},
		hasTranslatedTitle(channelId) {
			const key = normalizeChannelId(channelId);
			return key ? !!translated[key] : !!Object.keys(translated).length;
		},
		// Returns null when a request for this exact signature is already settled,
		// in flight, or inside its failure cooldown.
		beginRequest(channelId, signature) {
			const key = normalizeChannelId(channelId);
			if (!key || !signature) return null;
			if (translated[key] && translated[key].signature === signature) return null;
			if (pending[key] && pending[key].signature === signature) return null;
			const failure = failed[key];
			if (failure && failure.signature === signature && failure.retryAfter > now()) return null;
			const request = {id: ++requestSequence, channelId: key, signature};
			pending[key] = request;
			return request;
		},
		isRequestCurrent(request) {
			return !!request && pending[normalizeChannelId(request.channelId)] === request;
		},
		completeRequest(request, text) {
			const key = normalizeChannelId(request && request.channelId);
			if (!key || pending[key] !== request) return false;
			delete pending[key];
			translated[key] = {signature: request.signature, text};
			delete failed[key];
			return true;
		},
		failRequest(request) {
			const key = normalizeChannelId(request && request.channelId);
			if (!key || pending[key] !== request) return false;
			delete pending[key];
			failed[key] = {signature: request.signature, retryAfter: now() + CHANNEL_TITLE_FAILURE_RETRY_MS};
			return true;
		},
		// Drops an in-flight request without recording a failure, so the next render
		// may retry immediately.
		abandonRequest(request) {
			const key = normalizeChannelId(request && request.channelId);
			if (!key || pending[key] !== request) return false;
			delete pending[key];
			return true;
		},
		cancelPending(channelId = null) {
			const key = normalizeChannelId(channelId);
			if (!key) {
				pending = {};
				failed = {};
				return;
			}
			delete pending[key];
			delete failed[key];
		},
		// Returns whether a visible title was actually removed, so the caller knows
		// if a component refresh is warranted.
		clear(channelId = null) {
			const key = normalizeChannelId(channelId);
			const hadTranslatedTitle = this.hasTranslatedTitle(channelId);
			this.cancelPending(channelId);
			if (!key) translated = {};
			else delete translated[key];
			return hadTranslatedTitle;
		},
		// Invalidates every in-flight request without touching displayed titles;
		// used when the plugin stops so late callbacks cannot commit.
		invalidateInFlight() {
			requestSequence++;
			pending = {};
		}
	});
}

module.exports = {CHANNEL_TITLE_FAILURE_RETRY_MS, createChannelTitleStore};
