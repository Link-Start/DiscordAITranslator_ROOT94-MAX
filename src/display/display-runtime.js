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
	return Object.freeze({
		getTransitionJournal: () => journal,
		captureSource: snapshot => store.captureSource(snapshot),
		setChannelGeneration: (channelId, generation) => store.setChannelGeneration(channelId, generation),
		getChannelGeneration: channelId => store.getChannelGeneration(channelId),
		getDisplayView: messageId => controller.getDisplayView(messageId),
		markPending: (request, options) => controller.markPending(request, options),
		releasePending: request => store.releasePending(request),
		commitMessageResult: (result, options) => controller.commitMessageResult(result, options),
		commitHistoricalBatch: results => controller.commitHistoricalBatch(results),
		restoreMessage: (messageId, options) => controller.restoreMessage(messageId, options),
		restoreChannel: channelId => controller.restoreChannel(channelId),
		restoreAll: options => controller.restoreAll(options)
	});
}

module.exports = {createDisplayRuntime};
