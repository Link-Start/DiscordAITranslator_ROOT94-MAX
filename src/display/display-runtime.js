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
		renderMessages: messageIds => controller.renderMessages(messageIds),
		refreshDisplayTransaction: request => controller.refreshDisplayTransaction(request),
		restoreMessage: (messageId, options) => controller.restoreMessage(messageId, options),
		restoreChannel: (channelId, options) => controller.restoreChannel(channelId, options),
		restoreAll: options => controller.restoreAll(options),
		// The surface the legacy display maps are being retired onto. These are plain
		// store passthroughs rather than controller operations because none of them
		// paints anything - they are state the render paths read on their next pass.
		getDisplayState: messageId => store.getDisplayState(messageId),
		commitManualTranslation: request => store.commitManualTranslation(request),
		clearDisplayedTranslation: (messageId, options) => store.clearDisplayedTranslation(messageId, options),
		consumeSourceArchive: messageId => store.consumeSourceArchive(messageId),
		peekSourceArchive: messageId => store.peekSourceArchive(messageId),
		dropSourceArchive: messageId => store.dropSourceArchive(messageId),
		hasSourceArchive: messageId => store.hasSourceArchive(messageId),
		suppress: messageId => store.suppress(messageId),
		isSuppressed: messageId => store.isSuppressed(messageId),
		clearSuppression: messageId => store.clearSuppression(messageId),
		clearAllSuppression: () => store.clearAllSuppression(),
		resolveChannelId: (messageId, options) => store.resolveChannelId(messageId, options),
		listTranslated: () => store.listTranslated(),
		pruneChannel: channelId => store.pruneChannel(channelId),
		capturePreviewSource: snapshot => store.capturePreviewSource(snapshot),
		commitPreviewResult: (result, options) => controller.commitPreviewResult(result, options),
		markPreviewPending: request => store.markPreviewPending(request),
		isPreviewPending: messageId => store.isPreviewPending(messageId),
		getPreviewPending: messageId => store.getPreviewPending(messageId),
		// Two arguments, not one: markPreviewPending hands back a token string, and the
		// store keys the release on the message id with the token as the guard against a
		// superseded request releasing its successor's slot.
		releasePreviewPending: (messageId, token) => store.releasePreviewPending(messageId, token),
		getPreviewTranslation: (messageId, options) => store.getPreviewTranslation(messageId, options),
		getPreviewCandidates: messageId => store.getPreviewCandidates(messageId),
		getReplyPreviewProjection: (messageId, options) => store.getReplyPreviewProjection(messageId, options),
		clearPreview: messageId => store.clearPreview(messageId),
		clearPreviews: channelId => store.clearPreviews(channelId),
		listPreviewed: () => store.listPreviewed(),
		markPreviewHost: (channelId, referencedMessageId, hostMessageId) => store.markPreviewHost(channelId, referencedMessageId, hostMessageId),
		getPreviewHostMessageIds: (channelId, referencedMessageIds) => store.getPreviewHostMessageIds(channelId, referencedMessageIds),
		markPreviewEligible: (channelId, messageId) => store.markPreviewEligible(channelId, messageId),
		isPreviewEligible: (channelId, messageId) => store.isPreviewEligible(channelId, messageId),
		clearPreviewEligibility: channelId => store.clearPreviewEligibility(channelId)
	});
}

module.exports = {createDisplayRuntime};
