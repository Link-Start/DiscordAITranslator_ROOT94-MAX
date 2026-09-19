// Owns the per-channel operation version used to serialize asynchronous toggle cleanup.
// State stays in this module instead of adding another mutable map to the legacy runtime.
function createChannelToggleOperations() {
	const versions = new Map();

	function normalizeChannelId(channelId) {
		return String(channelId || "");
	}

	return Object.freeze({
		begin(channelId) {
			const normalizedChannelId = normalizeChannelId(channelId);
			const version = (versions.get(normalizedChannelId) || 0) + 1;
			versions.set(normalizedChannelId, version);
			return version;
		},
		isCurrent(channelId, version) {
			return versions.get(normalizeChannelId(channelId)) === version;
		},
		reset() {
			versions.clear();
		}
	});
}

module.exports = {createChannelToggleOperations};
