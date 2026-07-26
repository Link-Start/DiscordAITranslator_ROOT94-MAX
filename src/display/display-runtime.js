const {createMessageStateStore} = require("./message-state-store");
const {createTranslationDisplayController} = require("./translation-display-controller");
const {createDiscordRenderAdapter} = require("./discord-render-adapter");

function createDisplayRuntime(dependencies) {
	// The compile-time constant strips the journal implementation from release bundles;
	// node test runs see an undefined identifier and disable the journal the same way.
	const debugEnabled = typeof __TRANSLATOR_DISPLAY_DEBUG__ !== "undefined" && __TRANSLATOR_DISPLAY_DEBUG__;
	const journal = debugEnabled ? require("../diagnostics/display-transition-journal").createDisplayTransitionJournal({enabled: true}) : null;
	const store = createMessageStateStore({journal});
	const renderAdapter = createDiscordRenderAdapter(dependencies);
	const controller = createTranslationDisplayController({store, renderAdapter, journal});
	// Whether the most recent transaction had to fall back to a full-list rerender.
	// A targeted repaint does not disturb a reader, but a full remount does, so the
	// caller uses this to pick a calmer cadence for the next repaint.
	let lastFlushUsedFallback = false;

	function trackFallback(outcome) {
		lastFlushUsedFallback = !!(outcome && outcome.fallbackUsed);
		return outcome;
	}

	return Object.freeze({
		getTransitionJournal: () => journal,
		lastRenderUsedFallback: () => lastFlushUsedFallback,
		captureSource: snapshot => store.captureSource(snapshot),
		setChannelGeneration: (channelId, generation) => store.setChannelGeneration(channelId, generation),
		getChannelGeneration: channelId => store.getChannelGeneration(channelId),
		getDisplayView: messageId => controller.getDisplayView(messageId),
		markPending: (request, options) => controller.markPending(request, options),
		releasePending: request => store.releasePending(request),
		commitMessageResult: (result, options) => controller.commitMessageResult(result, options),
		commitHistoricalBatch: results => controller.commitHistoricalBatch(results),
		renderMessages: messageIds => controller.renderMessages(messageIds).then(trackFallback),
		restoreMessage: (messageId, options) => controller.restoreMessage(messageId, options),
		restoreChannel: channelId => controller.restoreChannel(channelId),
		restoreAll: options => controller.restoreAll(options)
	});
}

module.exports = {createDisplayRuntime};
